/* global console, process */

// SameSuite contains ROMs for several CGB silicon revisions. Running every
// file against one generic CGB profile makes the score misleading: a test
// named `-cgb0B`, for example, is deliberately checking an older chip. This
// report routes each test to the internal revision profile it targets while
// keeping the normal emulator's production profile untouched.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { GameBoy } from "../app/lib/gameboy.js";
import { getEmbeddedBootROM } from "../app/lib/embeddedBios.js";

const PASS_REGISTERS = [3, 5, 8, 13, 21, 34];
const FAIL_REGISTERS = [0x42, 0x42, 0x42, 0x42, 0x42, 0x42];
const DEFAULT_CYCLE_BUDGET = 80_000_000;

function collectRoms(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (extname(entry).toLowerCase() === ".gb") files.push(path);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function revisionFor(path) {
  const name = basename(path, extname(path)).toLowerCase();
  if (name.includes("-cgb0bc")) return "cgbC";
  if (name.includes("-cgbde")) return "cgbE";
  if (name.includes("-cgb0b")) return "cgbB";
  if (name.endsWith("-cgb0")) return "cgb0";
  if (name.endsWith("-cgba") || name.endsWith("-a")) return "cgbA";
  if (name.endsWith("-cgbb")) return "cgbB";
  if (name.endsWith("-cgbc")) return "cgbC";
  if (name.endsWith("-cgbd")) return "cgbD";
  if (name.endsWith("-cgbe")) return "cgbE";
  // Unsuffixed APU/PPU tests are the CGB-E baseline in SameSuite's own
  // results table. This is a diagnostics choice, not a user setting.
  return "cgbE";
}

function parseArguments(argv) {
  const options = {
    root: null,
    cycles: DEFAULT_CYCLE_BUDGET,
    match: null,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cycles") options.cycles = Number(argv[++index]);
    else if (argument === "--match") options.match = new RegExp(argv[++index], "i");
    else if (argument === "--quiet") options.quiet = true;
    else if (!options.root) options.root = resolve(argument);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.root) throw new Error("Provide the SameSuite root directory.");
  if (!Number.isInteger(options.cycles) || options.cycles < 1) {
    throw new Error("--cycles must be a positive integer.");
  }
  return options;
}

function registerSignature(emulator) {
  return [emulator.b, emulator.c, emulator.d, emulator.e, emulator.h, emulator.l];
}

function resultFor(emulator) {
  if (emulator.read8(emulator.pc, true) !== 0x40) return null;
  const registers = registerSignature(emulator);
  if (registers.every((value, index) => value === PASS_REGISTERS[index])) return "pass";
  if (registers.every((value, index) => value === FAIL_REGISTERS[index])) return "fail";
  return null;
}

function run(path, revision, cycleBudget) {
  const emulator = new GameBoy("cgb", { hardwareRevision: revision });
  emulator.setBootROM(getEmbeddedBootROM("cgb"));
  emulator.loadROM(new Uint8Array(readFileSync(path)));
  let result = null;
  while (emulator.cycles < cycleBudget) {
    result = resultFor(emulator);
    if (result) break;
    emulator.step();
  }
  return {
    result: result ?? "timeout",
    revision,
    registers: registerSignature(emulator),
    cycles: emulator.cycles,
  };
}

const options = parseArguments(process.argv.slice(2));
let files = collectRoms(options.root).filter((path) => !relative(options.root, path).startsWith("sgb/")
  && (!options.match || options.match.test(relative(options.root, path))));
if (!files.length) throw new Error("No matching non-SGB SameSuite ROMs found.");

const totals = { pass: 0, fail: 0, timeout: 0 };
const byRevision = new Map();
for (const path of files) {
  const revision = revisionFor(path);
  const result = run(path, revision, options.cycles);
  totals[result.result] += 1;
  const group = byRevision.get(revision) ?? { pass: 0, fail: 0, timeout: 0, total: 0 };
  group[result.result] += 1;
  group.total += 1;
  byRevision.set(revision, group);
  if (!options.quiet) {
    const marker = result.result === "pass" ? "PASS" : result.result === "fail" ? "FAIL" : "TIME";
    console.log(`${marker.padEnd(4)} ${revision.padEnd(12)} ${relative(options.root, path)}`
      + ` · ${(result.cycles / 1_000_000).toFixed(2)} M cycles`);
  }
}

console.log(JSON.stringify({
  suite: "samesuite-matrix",
  total: files.length,
  ...totals,
  passRate: Number((totals.pass / files.length * 100).toFixed(2)),
  byRevision: Object.fromEntries(byRevision),
}));
