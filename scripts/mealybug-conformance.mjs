/* global Buffer, console, process */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { GameBoy } from "../app/lib/gameboy.js";

const SCREEN_BYTES = 160 * 144 * 4;
let EmulatorClass = GameBoy;

function parseArguments(argv) {
  const options = {
    baselineRef: null,
    cycleBudget: 60_000_000,
    expected: null,
    model: null,
    quiet: false,
    roms: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--baseline-ref") options.baselineRef = argv[++index];
    else if (argument === "--cycles") options.cycleBudget = Number(argv[++index]);
    else if (argument === "--expected") options.expected = resolve(argv[++index]);
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--roms") options.roms = resolve(argv[++index]);
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
  const emulator = new EmulatorClass(options.model);
  emulator.loadROM(new Uint8Array(readFileSync(romPath)));
  let instructions = 0;
  while (emulator.cycles < options.cycleBudget) {
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
    instructions,
    mismatched,
    matchPercent: Number(((SCREEN_BYTES / 4 - mismatched) / (SCREEN_BYTES / 4) * 100).toFixed(4)),
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
  const result = runTest(romPath, join(options.expected, referenceName), options);
  results.push(result);
  if (!options.quiet) {
    const marker = result.pass ? "PASS" : result.breakpoint ? "FAIL" : "TIME";
    console.log(
      `${marker.padEnd(4)} ${result.name} · ${result.matchPercent.toFixed(4)}%`
      + ` · ${result.mismatched} px · ${(result.cycles / 1_000_000).toFixed(2)} M cycles`,
    );
  }
}

const passing = results.filter((result) => result.pass).length;
const averageMatch = results.reduce(
  (sum, result) => sum + result.matchPercent,
  0,
) / Math.max(1, results.length);
console.log(JSON.stringify({
  model: options.model,
  baselineRef: options.baselineRef,
  expected: options.expected,
  total: results.length,
  pass: passing,
  fail: results.length - passing,
  passRate: Number((passing / Math.max(1, results.length) * 100).toFixed(2)),
  averageMatchPercent: Number(averageMatch.toFixed(4)),
}));
