/* global Buffer, console, process */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitCommit(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

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
  return "protocol-error";
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

function bootProfileFor(path, model) {
  if (model === "dmg" && /boot_.*-dmg0\.gb$/i.test(basename(path))) return "dmg0";
  if (model === "dmg" && /boot_.*-mgb\.gb$/i.test(basename(path))) return "mgb";
  return model;
}

function expectedBootBytes(profile) {
  return profile === "cgb" ? 0x900 : 0x100;
}

function bootHashFor(bootMode, bootProfile, bootBytes) {
  if (bootMode === "none") return null;
  return sha256(bootMode === "path" ? bootBytes : getEmbeddedBootROM(bootProfile));
}

function runUntilResult(path, {
  model,
  hardwareRevision = null,
  bootProfile = model,
  cycleBudget = DEFAULT_CYCLE_BUDGET,
  protocol = "auto",
  bootMode = "embedded",
  bootBytes = null,
  dumpRam = 0,
} = {}) {
  const rom = new Uint8Array(readFileSync(path));
  const start = performance.now();
  if (bootMode === "path" && bootBytes.length !== expectedBootBytes(bootProfile)) {
    return {
      path,
      model,
      selectedRevision: null,
      bootProfile,
      bootMode,
      bootSha256: bootHashFor(bootMode, bootProfile, bootBytes),
      result: "unsupported",
      error: `Boot image is ${bootBytes.length} bytes; ${bootProfile} requires ${expectedBootBytes(bootProfile)} bytes.`,
      cycles: 0,
      baseCycles: 0,
      milliseconds: 0,
      serial: "",
      registers: [],
      sha256: sha256(rom),
    };
  }
  let emulator;
  try {
    emulator = new EmulatorClass(model, hardwareRevision
      ? { hardwareRevision }
      : undefined);
    if (hardwareRevision && emulator.hardwareRevision !== hardwareRevision) {
      throw new Error(`Core selected ${emulator.hardwareRevision} instead of requested ${hardwareRevision}`);
    }
    if (bootMode === "embedded") emulator.setBootROM(getEmbeddedBootROM(bootProfile));
    else if (bootMode === "path") emulator.setBootROM(bootBytes);
    emulator.loadROM(rom);
  } catch (error) {
    return {
      path,
      model,
      selectedRevision: emulator?.hardwareRevision ?? null,
      bootProfile,
      bootMode,
      bootSha256: bootHashFor(bootMode, bootProfile, bootBytes),
      result: "error",
      error: error instanceof Error ? error.message : String(error),
      cycles: emulator?.cycles ?? 0,
      baseCycles: emulator?.baseCycles ?? 0,
      milliseconds: performance.now() - start,
      serial: emulator?.serialOutput?.trim() || "",
      registers: emulator ? registerSignature(emulator) : [],
      sha256: sha256(rom),
    };
  }
  let result = null;
  let memoryText = "";
  let steps = 0;
  try {
    while (emulator.baseCycles < cycleBudget) {
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
  } catch (error) {
    return {
      path,
      model,
      selectedRevision: emulator.hardwareRevision ?? null,
      bootProfile,
      bootMode,
      bootSha256: bootHashFor(bootMode, bootProfile, bootBytes),
      result: "error",
      error: error instanceof Error ? error.message : String(error),
      cycles: emulator.cycles,
      baseCycles: emulator.baseCycles,
      milliseconds: performance.now() - start,
      serial: emulator.serialOutput.trim(),
      registers: registerSignature(emulator),
      sha256: sha256(rom),
    };
  }
  const elapsed = performance.now() - start;
  const output = {
    path,
    model,
    selectedRevision: emulator.hardwareRevision ?? null,
    bootProfile,
    bootMode,
    bootSha256: bootHashFor(bootMode, bootProfile, bootBytes),
    result: result ?? "timeout",
    cycles: emulator.cycles,
    baseCycles: emulator.baseCycles,
    milliseconds: elapsed,
    serial: (emulator.serialOutput.trim() || memoryText.trim()),
    registers: registerSignature(emulator),
    sha256: sha256(rom),
    opcode: emulator.read8(emulator.pc, true),
    resultCode: emulator.read8(0xcffe, true),
  };
  if (dumpRam > 0 && output.result !== "pass") {
    output.ram = Array.from({ length: dumpRam }, (_, index) =>
      emulator.read8(0xc000 + index, true));
  }
  return output;
}

function printResult(root, result) {
  const marker = result.result === "pass"
    ? "PASS"
    : result.result === "fail"
      ? "FAIL"
      : result.result === "protocol-error"
        ? "PROTO"
        : result.result === "error" ? "ERR " : "TIME";
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
    bootMode: null,
    bootPath: null,
    quiet: false,
    baselineRef: null,
    model: null,
    hardwareRevision: null,
    dumpRam: 0,
    reportPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/core-conformance.mjs [options] SUITE_ROOT");
      console.log("  --suite mooneye|blargg          Select the protocol");
      console.log("  --embedded-boot                Use the embedded, named production BIOS");
      console.log("  --no-boot                      Start from the post-boot state");
      console.log("  --boot-path PATH               Use an explicitly hashed BIOS");
      console.log("  --model dmg|cgb                Override filename/header model policy");
      console.log("  --hardware-revision REV        Select production/cgb0/cgbA...cgbE");
      console.log("  --cycles N                     Per-ROM emulated cycle budget");
      console.log("  --report PATH                  Write the complete JSON report");
      process.exit(0);
    }
    if (argument === "--suite") options.suite = argv[++index];
    else if (argument === "--match") options.match = new RegExp(argv[++index], "i");
    else if (argument === "--limit") options.limit = Number(argv[++index]);
    else if (argument === "--cycles") options.cycleBudget = Number(argv[++index]);
    else if (argument === "--no-boot") options.bootMode = "none";
    else if (argument === "--embedded-boot") options.bootMode = "embedded";
    else if (argument === "--boot-path") {
      options.bootMode = "path";
      options.bootPath = resolve(argv[++index]);
    }
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--baseline-ref") options.baselineRef = argv[++index];
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--hardware-revision") options.hardwareRevision = argv[++index];
    else if (argument === "--dump-ram") options.dumpRam = Number(argv[++index]);
    else if (argument === "--report") options.reportPath = resolve(argv[++index]);
    else if (!options.root) options.root = resolve(argument);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.root) throw new Error("Provide the root directory containing test ROMs.");
  if (!options.bootMode) throw new Error("Choose an explicit boot policy with --embedded-boot, --no-boot, or --boot-path.");
  if (options.bootMode === "path" && !options.bootPath) throw new Error("--boot-path requires a file.");
  if (options.bootMode === "path" && !existsSync(options.bootPath)) throw new Error(`Boot ROM does not exist: ${options.bootPath}`);
  if (options.model && !["dmg", "cgb"].includes(options.model)) {
    throw new Error("--model must be dmg or cgb.");
  }
  if (options.hardwareRevision && !["production", "cgb0", "cgbA", "cgbB", "cgbC", "cgbD", "cgbE"].includes(options.hardwareRevision)) {
    throw new Error("--hardware-revision must be production, cgb0, cgbA, cgbB, cgbC, cgbD, or cgbE.");
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.suite === "samesuite") {
  throw new Error("SameSuite requires revision-aware execution; use scripts/samesuite-matrix.mjs instead of the generic runner.");
}
const bootBytes = options.bootMode === "path"
  ? new Uint8Array(readFileSync(options.bootPath))
  : null;
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
const unsupported = [];
for (const path of files) {
  if (options.suite === "mooneye") {
    const model = options.model || modelForMooneye(path);
    if (!model) {
      unsupported.push({
        path: relative(options.root, path),
        sha256: sha256(new Uint8Array(readFileSync(path))),
        reason: "Mooneye filename identifies an unsupported AGB/SGB target",
      });
      continue;
    }
    const result = runUntilResult(path, {
      model,
      bootProfile: bootProfileFor(path, model),
      hardwareRevision: options.hardwareRevision,
      cycleBudget: options.cycleBudget,
      protocol: "mooneye",
      bootMode: options.bootMode,
      bootBytes,
      dumpRam: options.dumpRam,
    });
    result.modelSource = options.model ? "cli" : "filename/header policy";
    if (result.result === "unsupported") {
      unsupported.push({
        path: relative(options.root, path),
        sha256: result.sha256,
        reason: result.error,
      });
    } else {
      results.push(result);
      if (!options.quiet) printResult(options.root, result);
    }
  } else {
    const header = readFileSync(path);
    const model = options.model || ((header[0x143] & 0x80)
      || extname(path).toLowerCase() === ".gbc"
      || /cgb/i.test(path)
      ? "cgb"
      : "dmg");
    const result = runUntilResult(path, {
      model,
      bootProfile: model,
      hardwareRevision: options.hardwareRevision,
      cycleBudget: options.cycleBudget,
      protocol: "blargg",
      bootMode: options.bootMode,
      bootBytes,
      dumpRam: options.dumpRam,
    });
    result.modelSource = options.model ? "cli" : "header/extension policy";
    if (result.result === "unsupported") {
      unsupported.push({
        path: relative(options.root, path),
        sha256: result.sha256,
        reason: result.error,
      });
    } else {
      results.push(result);
      if (!options.quiet) printResult(options.root, result);
    }
  }
}

const summary = results.reduce((totals, result) => {
  totals[result.result] += 1;
  totals.milliseconds += result.milliseconds;
  return totals;
}, { pass: 0, fail: 0, timeout: 0, error: 0, "protocol-error": 0, milliseconds: 0 });

const report = {
  harness: "core-conformance",
  harnessVersion: 3,
  suite: options.suite,
  suiteCommit: gitCommit(options.root),
  romManifestSha256: sha256(Buffer.from([
    ...results.map((result) => `${relative(options.root, result.path)}\t${result.sha256}`),
    ...unsupported.map((result) => `${result.path}\t${result.sha256}`),
  ].sort().join("\n"))),
  policy: {
    cycleBudget: options.cycleBudget,
    cycleUnit: "DMG base-clock T-cycles (4.194304 MHz equivalent)",
    boot: options.bootMode,
    bootSha256: bootBytes ? sha256(bootBytes) : options.bootMode === "embedded"
      ? Object.fromEntries(["dmg0", "mgb", "dmg", "cgb"].map((profile) => [
        profile, sha256(getEmbeddedBootROM(profile)),
      ]))
      : null,
    passDetection: options.suite === "mooneye"
        ? "Mooneye Fibonacci registers at opcode 0x40"
        : "Blargg serial and RAM signature",
    modelSelection: "header/filename policy recorded per case",
    modelPolicySource: "https://github.com/Gekkio/mooneye-test-suite#test-naming",
  },
  total: results.length,
  unsupported: unsupported.length,
  ...summary,
  passRate: results.length ? Number((summary.pass / results.length * 100).toFixed(2)) : 0,
  milliseconds: Number(summary.milliseconds.toFixed(1)),
  unsupportedCases: unsupported,
  cases: results,
};
if (options.reportPath) writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  harness: report.harness,
  suite: report.suite,
  suiteCommit: report.suiteCommit,
  total: report.total,
  unsupported: report.unsupported,
  pass: report.pass,
  fail: report.fail,
  timeout: report.timeout,
  error: report.error,
  protocolError: report["protocol-error"],
  passRate: report.passRate,
  boot: report.policy.boot,
  bootSha256: report.policy.bootSha256,
  cycleBudget: report.policy.cycleBudget,
  milliseconds: report.milliseconds,
}));
if (report.timeout || report.error || report.unsupported || report["protocol-error"]) {
  process.exitCode = 1;
}
