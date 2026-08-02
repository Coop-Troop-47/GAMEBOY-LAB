/* global Buffer, console, process */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { GameBoy } from "../app/lib/gameboy.js";
import { getEmbeddedBootROM } from "../app/lib/embeddedBios.js";

const SCREEN_BYTES = 160 * 144 * 4;
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

function parseArguments(argv) {
  const options = {
    baselineRef: null,
    cycleBudget: 60_000_000,
    expected: null,
    model: null,
    quiet: false,
    roms: null,
    bootMode: "none",
    bootPath: null,
    reportPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/mealybug-conformance.mjs --roms DIR --expected DIR --model dmg|cgb [options]");
      console.log("  --no-boot                      Use the post-boot state (default)");
      console.log("  --embedded-boot                Use the embedded BIOS for the selected model");
      console.log("  --boot-path PATH               Use an explicitly hashed BIOS");
      console.log("  --cycles N                     Per-ROM emulated cycle budget");
      console.log("  --expected DIR                 160x144 RGBA reference PNGs");
      console.log("  --roms DIR                     Matching .gb ROMs");
      process.exit(0);
    }
    if (argument === "--baseline-ref") options.baselineRef = argv[++index];
    else if (argument === "--cycles") options.cycleBudget = Number(argv[++index]);
    else if (argument === "--expected") options.expected = resolve(argv[++index]);
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--roms") options.roms = resolve(argv[++index]);
    else if (argument === "--no-boot") options.bootMode = "none";
    else if (argument === "--boot-path") {
      options.bootMode = "path";
      options.bootPath = resolve(argv[++index]);
    }
    else if (argument === "--embedded-boot") options.bootMode = "embedded";
    else if (argument === "--report") options.reportPath = resolve(argv[++index]);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.roms || !options.expected) {
    throw new Error("Provide --roms and --expected directories.");
  }
  if (!["dmg", "cgb"].includes(options.model)) {
    throw new Error("--model must be dmg or cgb.");
  }
  if (!Number.isInteger(options.cycleBudget) || options.cycleBudget < 1) {
    throw new Error("--cycles must be a positive integer.");
  }
  if (options.bootMode === "path" && !existsSync(options.bootPath)) {
    throw new Error(`Boot ROM does not exist: ${options.bootPath}`);
  }
  return options;
}

function decodeReference(path) {
  const result = spawnSync("ffmpeg", [
    "-v", "error",
    "-i", path,
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-",
  ], { maxBuffer: SCREEN_BYTES * 2 });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || `Could not decode ${path}.`);
  }
  if (result.stdout.length !== SCREEN_BYTES) {
    throw new Error(`${path} is not a 160×144 RGBA reference.`);
  }
  return new Uint8Array(result.stdout);
}

function rgbKey(bytes, offset) {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function maximumColorAssignment(weights, size) {
  // Hungarian assignment is the exact maximum-weight matching for the color
  // correspondence. The small bitmask dynamic program below is quicker for
  // four-color DMG images; CGB raster tests legitimately use more colors and
  // previously failed before they could be measured at all.
  const u = new Float64Array(size + 1);
  const v = new Float64Array(size + 1);
  const p = new Int32Array(size + 1);
  const way = new Int32Array(size + 1);
  for (let row = 1; row <= size; row += 1) {
    p[0] = row;
    let column = 0;
    const min = new Float64Array(size + 1);
    min.fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(size + 1);
    do {
      used[column] = 1;
      const matchedRow = p[column];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (used[candidate]) continue;
        const cost = -(weights[matchedRow - 1][candidate - 1] || 0)
          - u[matchedRow] - v[candidate];
        if (cost < min[candidate]) {
          min[candidate] = cost;
          way[candidate] = column;
        }
        if (min[candidate] < delta) {
          delta = min[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (used[candidate]) {
          u[p[candidate]] += delta;
          v[candidate] -= delta;
        } else min[candidate] -= delta;
      }
      column = nextColumn;
    } while (p[column] !== 0);
    do {
      const previous = way[column];
      p[column] = p[previous];
      column = previous;
    } while (column !== 0);
  }
  let score = 0;
  for (let column = 1; column <= size; column += 1) {
    score += weights[p[column] - 1][column - 1] || 0;
  }
  return score;
}

function compareStructure(actual, expected) {
  const actualColors = new Map();
  const expectedColors = new Map();
  const pairs = new Map();
  for (let offset = 0; offset < SCREEN_BYTES; offset += 4) {
    const actualColor = rgbKey(actual, offset);
    const expectedColor = rgbKey(expected, offset);
    if (!actualColors.has(actualColor)) actualColors.set(actualColor, actualColors.size);
    if (!expectedColors.has(expectedColor)) expectedColors.set(expectedColor, expectedColors.size);
    const key = `${actualColor}:${expectedColor}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
  const actualKeys = [...actualColors.keys()];
  const expectedKeys = [...expectedColors.keys()];
  const colorCount = Math.max(actualKeys.length, expectedKeys.length);
  if (colorCount > 12) {
    const weights = Array.from(
      { length: colorCount },
      (_, actualIndex) => Float64Array.from(
        { length: colorCount },
        (_, expectedIndex) => actualIndex < actualKeys.length
          && expectedIndex < expectedKeys.length
          ? pairs.get(`${actualKeys[actualIndex]}:${expectedKeys[expectedIndex]}`) || 0
          : 0,
      ),
    );
    return SCREEN_BYTES / 4 - maximumColorAssignment(weights, colorCount);
  }
  let scores = new Float64Array(1 << colorCount);
  scores.fill(Number.NEGATIVE_INFINITY);
  scores[0] = 0;
  for (let actualIndex = 0; actualIndex < colorCount; actualIndex += 1) {
    const next = new Float64Array(scores.length);
    next.fill(Number.NEGATIVE_INFINITY);
    for (let mask = 0; mask < scores.length; mask += 1) {
      if (!Number.isFinite(scores[mask])) continue;
      for (let expectedIndex = 0; expectedIndex < colorCount; expectedIndex += 1) {
        const bit = 1 << expectedIndex;
        if (mask & bit) continue;
        const matchingPixels = actualIndex < actualKeys.length
          && expectedIndex < expectedKeys.length
          ? pairs.get(`${actualKeys[actualIndex]}:${expectedKeys[expectedIndex]}`) || 0
          : 0;
        const nextMask = mask | bit;
        next[nextMask] = Math.max(next[nextMask], scores[mask] + matchingPixels);
      }
    }
    scores = next;
  }
  return SCREEN_BYTES / 4 - scores[scores.length - 1];
}

function runTest(romPath, referencePath, options) {
  const rom = new Uint8Array(readFileSync(romPath));
  const emulator = new EmulatorClass(options.model);
  if (options.bootMode === "embedded") emulator.setBootROM(getEmbeddedBootROM(options.model));
  else if (options.bootMode === "path") emulator.setBootROM(new Uint8Array(readFileSync(options.bootPath)));
  emulator.loadROM(rom);
  let instructions = 0;
  while (emulator.baseCycles < options.cycleBudget) {
    if (instructions > 0 && emulator.read8(emulator.pc, true) === 0x40) break;
    emulator.step();
    instructions += 1;
  }
  const breakpoint = emulator.read8(emulator.pc, true) === 0x40;
  const mismatched = compareStructure(
    emulator.framebuffer,
    decodeReference(referencePath),
  );
  return {
    name: basename(romPath, extname(romPath)),
    breakpoint,
    cycles: emulator.cycles,
    baseCycles: emulator.baseCycles,
    instructions,
    mismatched,
    romSha256: sha256(rom),
    referenceSha256: sha256(readFileSync(referencePath)),
    bootMode: options.bootMode,
    matchPercent: Number(((SCREEN_BYTES / 4 - mismatched) / (SCREEN_BYTES / 4) * 100).toFixed(4)),
    status: breakpoint ? (mismatched === 0 ? "pass" : "fail") : "timeout",
    pass: breakpoint && mismatched === 0,
  };
}

const options = parseArguments(process.argv.slice(2));
if (options.baselineRef) {
  const source = execFileSync(
    "git",
    ["show", `${options.baselineRef}:app/lib/gameboy.js`],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  EmulatorClass = module.GameBoy;
}

const references = readdirSync(options.expected)
  .filter((name) => name.toLowerCase().endsWith(".png"))
  .sort((left, right) => left.localeCompare(right));
if (!references.length) throw new Error("No PNG references found.");

const results = [];
for (const referenceName of references) {
  const stem = basename(referenceName, extname(referenceName));
  const romPath = join(options.roms, `${stem}.gb`);
  if (!existsSync(romPath)) continue;
  let result;
  try {
    result = runTest(romPath, join(options.expected, referenceName), options);
  } catch (error) {
    result = {
      name: stem,
      status: "error",
      pass: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  results.push(result);
  if (!options.quiet) {
    const marker = result.status === "pass" ? "PASS"
      : result.status === "fail" ? "FAIL"
        : result.status === "error" ? "ERR " : "TIME";
    console.log(result.status === "error"
      ? `${marker.padEnd(4)} ${result.name} · ${result.error}`
      : `${marker.padEnd(4)} ${result.name} · ${result.matchPercent.toFixed(4)}%`
        + ` · ${result.mismatched} px · ${(result.cycles / 1_000_000).toFixed(2)} M cycles`);
  }
}

const passing = results.filter((result) => result.pass).length;
const statusCounts = results.reduce((counts, result) => {
  counts[result.status || (result.pass ? "pass" : "error")] += 1;
  return counts;
}, { pass: 0, fail: 0, timeout: 0, error: 0 });
const unsupportedCases = references
  .filter((referenceName) => !existsSync(join(options.roms, `${basename(referenceName, extname(referenceName))}.gb`)))
  .map((referenceName) => ({
    name: basename(referenceName, extname(referenceName)),
    referenceSha256: sha256(readFileSync(join(options.expected, referenceName))),
    reason: "reference image has no matching ROM",
  }));
const romManifestSha256 = sha256(Buffer.from(results
  .map((result) => `${result.name}\t${result.romSha256}\t${result.referenceSha256}`)
  .concat(unsupportedCases.map((result) => `${result.name}\tunsupported\t${result.referenceSha256}`))
  .sort()
  .join("\n")));
const averageMatch = results.reduce(
  (sum, result) => sum + result.matchPercent,
  0,
) / Math.max(1, results.length);
const report = {
  harness: "mealybug-conformance",
  harnessVersion: 2,
  suite: "Mealybug Tearoom Tests",
  suiteCommit: gitCommit(options.roms) || gitCommit(options.expected),
  romsCommit: gitCommit(options.roms),
  expectedCommit: gitCommit(options.expected),
  romManifestSha256,
  model: options.model,
  baselineRef: options.baselineRef,
  expected: options.expected,
  total: results.length,
  pass: passing,
  fail: statusCounts.fail,
  passRate: Number((passing / Math.max(1, results.length) * 100).toFixed(2)),
  status: statusCounts,
  averageMatchPercent: Number(averageMatch.toFixed(4)),
  unsupported: unsupportedCases.length,
  unsupportedCases,
  policy: {
    cycleBudget: options.cycleBudget,
    cycleUnit: "DMG base-clock T-cycles (4.194304 MHz equivalent)",
    boot: options.bootMode,
    bootSha256: options.bootMode === "embedded"
      ? sha256(getEmbeddedBootROM(options.model))
      : options.bootMode === "path" ? sha256(readFileSync(options.bootPath)) : null,
    model: options.model,
    passDetection: "opcode 0x40 breakpoint plus exact RGBA structural comparison",
  },
  cases: results,
};
if (options.reportPath) writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  harness: report.harness,
  suite: report.suite,
  model: report.model,
  total: report.total,
  pass: report.pass,
  fail: report.fail,
  passRate: report.passRate,
  averageMatchPercent: report.averageMatchPercent,
  unsupported: report.unsupported,
  boot: report.policy.boot,
  bootSha256: report.policy.bootSha256,
  cycleBudget: report.policy.cycleBudget,
}));
if (report.fail || report.unsupported || report.status.timeout || report.status.error) process.exitCode = 1;
