/* global Buffer, console, process */

import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { GameBoy } from "../app/lib/gameboy.js";
import { getEmbeddedBootROM } from "../app/lib/embeddedBios.js";

const PASS_REGISTERS = [3, 5, 8, 13, 21, 34];
const FAIL_REGISTERS = [0x42, 0x42, 0x42, 0x42, 0x42, 0x42];
// A few mapper and sprite-timing ROMs intentionally perform long exhaustive
// sweeps and report success beyond 70 million T-cycles on the individual
// Blargg builds. Eighty million avoids misclassifying those deterministic
// completions as hangs while keeping genuinely stuck ROMs bounded.
const DEFAULT_CYCLE_BUDGET = 80_000_000;
let EmulatorClass = GameBoy;

function collectRoms(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if ([".gb", ".gbc"].includes(extname(entry).toLowerCase())) files.push(path);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function registerSignature(emulator) {
  return [emulator.b, emulator.c, emulator.d, emulator.e, emulator.h, emulator.l];
}

function signaturesEqual(left, right) {
  return left.every((value, index) => value === right[index]);
}

function detectMooneyeResult(emulator) {
  if (emulator.read8(emulator.pc, true) !== 0x40) return null;
  const signature = registerSignature(emulator);
  if (signaturesEqual(signature, PASS_REGISTERS)) return "pass";
  if (signaturesEqual(signature, FAIL_REGISTERS)) return "fail";
  return null;
}

function detectBlarggMemoryResult(emulator) {
  const ram = emulator.eram;
  if (!ram || ram.length < 5 || ram[1] !== 0xde || ram[2] !== 0xb0 || ram[3] !== 0x61) {
    return null;
  }
  if (ram[0] === 0x80) return null;
  return {
    result: ram[0] === 0 ? "pass" : "fail",
    text: Array.from(ram.subarray(4, Math.max(4, ram.indexOf(0, 4))))
      .map((value) => String.fromCharCode(value))
      .join(""),
  };
}

function modelForMooneye(path) {
  const name = basename(path, extname(path));
  if (/(?:^|[-_])(?:C|cgb(?:0|A|B|C|D|E|ABCDE)?)$/i.test(name)) return "cgb";
  if (/(?:^|[-_])(?:A|agb|ags)$/i.test(name)) return null;
  if (/(?:^|[-_])S(?:$|[-_])/i.test(name) || /sgb/i.test(name)) return null;
  return "dmg";
}

function runUntilResult(path, {
  model,
  hardwareRevision = null,
  cycleBudget = DEFAULT_CYCLE_BUDGET,
  protocol = "auto",
  boot = true,
  dumpRam = 0,
} = {}) {
  const rom = new Uint8Array(readFileSync(path));
  const emulator = new EmulatorClass(model, hardwareRevision
    ? { hardwareRevision }
    : undefined);
  if (boot) emulator.setBootROM(getEmbeddedBootROM(model));
  emulator.loadROM(rom);
  const start = performance.now();
  let result = null;
  let memoryText = "";
  let steps = 0;
  while (emulator.cycles < cycleBudget) {
    if (protocol !== "blargg") {
      result = detectMooneyeResult(emulator);
      if (result) break;
    }
    emulator.step();
    steps += 1;
    if (protocol !== "mooneye" && emulator.serialOutput) {
      if (/\bPassed\b/i.test(emulator.serialOutput)) {
        result = "pass";
        break;
      }
      if (/\bFailed\b/i.test(emulator.serialOutput)) {
        result = "fail";
        break;
      }
    }
    if (protocol !== "mooneye" && (steps & 0xff) === 0) {
      const memoryResult = detectBlarggMemoryResult(emulator);
      if (memoryResult) {
        result = memoryResult.result;
        memoryText = memoryResult.text;
        break;
      }
    }
  }
  const elapsed = performance.now() - start;
  const output = {
    path,
    model,
    result: result ?? "timeout",
    cycles: emulator.cycles,
    milliseconds: elapsed,
    serial: (emulator.serialOutput.trim() || memoryText.trim()),
    registers: registerSignature(emulator),
  };
  if (dumpRam > 0 && output.result !== "pass") {
    output.ram = Array.from({ length: dumpRam }, (_, index) =>
      emulator.read8(0xc000 + index, true));
  }
  return output;
}

function printResult(root, result) {
  const marker = result.result === "pass" ? "PASS" : result.result === "fail" ? "FAIL" : "TIME";
  const detail = result.serial
    ? ` · ${result.serial.replace(/\s+/g, " ").slice(-80)}`
    : "";
  const registers = result.result === "pass"
    ? ""
    : ` · regs ${result.registers.map((value) => value.toString(16).padStart(2, "0")).join(" ")}`;
  console.log(
    `${marker.padEnd(4)} ${result.model.toUpperCase()} `
    + `${relative(root, result.path)} · ${(result.cycles / 1_000_000).toFixed(2)} M cycles`
    + ` · ${result.milliseconds.toFixed(1)} ms${detail}${registers}`,
  );
  if (result.ram) {
    console.log(`     C000 ${result.ram.map((value) => value.toString(16).padStart(2, "0")).join(" ")}`);
  }
}

function parseArguments(argv) {
  const options = {
    suite: "mooneye",
    root: null,
    match: null,
    limit: Number.POSITIVE_INFINITY,
    cycleBudget: DEFAULT_CYCLE_BUDGET,
    boot: true,
    quiet: false,
    baselineRef: null,
    model: null,
    hardwareRevision: null,
    dumpRam: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--suite") options.suite = argv[++index];
    else if (argument === "--match") options.match = new RegExp(argv[++index], "i");
    else if (argument === "--limit") options.limit = Number(argv[++index]);
    else if (argument === "--cycles") options.cycleBudget = Number(argv[++index]);
    else if (argument === "--no-boot") options.boot = false;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--baseline-ref") options.baselineRef = argv[++index];
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--hardware-revision") options.hardwareRevision = argv[++index];
    else if (argument === "--dump-ram") options.dumpRam = Number(argv[++index]);
    else if (!options.root) options.root = resolve(argument);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.root) throw new Error("Provide the root directory containing test ROMs.");
  if (options.model && !["dmg", "cgb"].includes(options.model)) {
    throw new Error("--model must be dmg or cgb.");
  }
  if (options.hardwareRevision && !["production", "cgb0", "cgbA", "cgbB", "cgbC", "cgbD", "cgbE"].includes(options.hardwareRevision)) {
    throw new Error("--hardware-revision must be production, cgb0, cgbA, cgbB, cgbC, cgbD, or cgbE.");
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.baselineRef) {
  const source = execFileSync(
    "git",
    ["show", `${options.baselineRef}:app/lib/gameboy.js`],
    { encoding: "utf8" },
  );
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  EmulatorClass = module.GameBoy;
}
let files = collectRoms(options.root);
if (options.match) {
  files = files.filter((file) => options.match.test(relative(options.root, file)));
}
files = files.slice(0, options.limit);
if (!files.length) throw new Error("No matching .gb or .gbc test ROMs were found.");

const results = [];
for (const path of files) {
  if (options.suite === "mooneye") {
    const model = options.model || modelForMooneye(path);
    if (!model) continue;
    const result = runUntilResult(path, {
      model,
      hardwareRevision: options.hardwareRevision,
      cycleBudget: options.cycleBudget,
      protocol: "mooneye",
      boot: options.boot,
      dumpRam: options.dumpRam,
    });
    results.push(result);
    if (!options.quiet) printResult(options.root, result);
  } else {
    const header = readFileSync(path);
    const model = options.model || ((header[0x143] & 0x80)
      || extname(path).toLowerCase() === ".gbc"
      || /cgb/i.test(path)
      ? "cgb"
      : "dmg");
    const result = runUntilResult(path, {
      model,
      hardwareRevision: options.hardwareRevision,
      cycleBudget: options.cycleBudget,
      // SameSuite deliberately terminates with the Fibonacci-register
      // software breakpoint also used by Mooneye. Keep that signal enabled;
      // treating it as a Blargg-only ROM otherwise turns completed results
      // into 60-million-cycle timeouts.
      protocol: options.suite === "samesuite" ? "auto" : "blargg",
      boot: options.boot,
      dumpRam: options.dumpRam,
    });
    results.push(result);
    if (!options.quiet) printResult(options.root, result);
  }
}

const summary = results.reduce((totals, result) => {
  totals[result.result] += 1;
  totals.milliseconds += result.milliseconds;
  return totals;
}, { pass: 0, fail: 0, timeout: 0, milliseconds: 0 });

console.log(JSON.stringify({
  suite: options.suite,
  total: results.length,
  pass: summary.pass,
  fail: summary.fail,
  timeout: summary.timeout,
  passRate: results.length ? Number((summary.pass / results.length * 100).toFixed(2)) : 0,
  milliseconds: Number(summary.milliseconds.toFixed(1)),
}));
