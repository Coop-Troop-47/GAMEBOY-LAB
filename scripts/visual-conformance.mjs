/* global Buffer, console, process */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GameBoy } from "../app/lib/gameboy.js";

function parseArguments(argv) {
  const options = {
    breakpoint: false,
    cycleBudget: 60_000_000,
    exact: false,
    frames: 30,
    model: null,
    output: null,
    reference: null,
    rom: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--breakpoint") options.breakpoint = true;
    else if (argument === "--cycles") options.cycleBudget = Number(argv[++index]);
    else if (argument === "--exact") options.exact = true;
    else if (argument === "--frames") options.frames = Number(argv[++index]);
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--output") options.output = resolve(argv[++index]);
    else if (argument === "--reference") options.reference = resolve(argv[++index]);
    else if (argument === "--rom") options.rom = resolve(argv[++index]);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.rom || !options.reference) {
    throw new Error("Provide --rom and --reference paths.");
  }
  if (options.model !== "dmg" && options.model !== "cgb") {
    throw new Error("--model must be dmg or cgb.");
  }
  if (!Number.isInteger(options.frames) || options.frames < 1) {
    throw new Error("--frames must be a positive integer.");
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
  ], { maxBuffer: 160 * 144 * 8 });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || "ffmpeg could not decode the reference image.");
  }
  const bytes = new Uint8Array(result.stdout);
  if (bytes.length !== 160 * 144 * 4) {
    throw new Error(`Expected a 160×144 reference image, received ${bytes.length} RGBA bytes.`);
  }
  return bytes;
}

function encodeFramebuffer(path, framebuffer) {
  const result = spawnSync("ffmpeg", [
    "-v", "error",
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", "160x144",
    "-i", "-",
    "-frames:v", "1",
    "-y",
    path,
  ], {
    input: Buffer.from(
      framebuffer.buffer,
      framebuffer.byteOffset,
      framebuffer.byteLength,
    ),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || "ffmpeg could not encode the framebuffer.");
  }
}

function rgbKey(bytes, offset) {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function compareStructure(actual, expected) {
  const actualColors = new Map();
  const expectedColors = new Map();
  const pairs = new Map();
  for (let offset = 0; offset < actual.length; offset += 4) {
    const actualColor = rgbKey(actual, offset);
    const expectedColor = rgbKey(expected, offset);
    if (!actualColors.has(actualColor)) actualColors.set(actualColor, actualColors.size);
    if (!expectedColors.has(expectedColor)) expectedColors.set(expectedColor, expectedColors.size);
    const key = `${actualColor}:${expectedColor}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
  const colorCount = Math.max(actualColors.size, expectedColors.size);
  if (colorCount > 12) {
    throw new Error(`Structural comparison supports at most 12 colors, received ${colorCount}.`);
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
        let matchingPixels = 0;
        if (actualIndex < actualColors.size && expectedIndex < expectedColors.size) {
          const actualColor = [...actualColors.keys()][actualIndex];
          const expectedColor = [...expectedColors.keys()][expectedIndex];
          matchingPixels = pairs.get(`${actualColor}:${expectedColor}`) || 0;
        }
        const nextMask = mask | bit;
        next[nextMask] = Math.max(next[nextMask], scores[mask] + matchingPixels);
      }
    }
    scores = next;
  }
  const matched = scores[scores.length - 1];
  return {
    mismatched: actual.length / 4 - matched,
    pixels: actual.length / 4,
    actualColors: actualColors.size,
    referenceColors: expectedColors.size,
  };
}

function compareExact(actual, expected) {
  let mismatched = 0;
  for (let offset = 0; offset < actual.length; offset += 4) {
    if (
      actual[offset] !== expected[offset]
      || actual[offset + 1] !== expected[offset + 1]
      || actual[offset + 2] !== expected[offset + 2]
    ) mismatched += 1;
  }
  return {
    mismatched,
    pixels: actual.length / 4,
  };
}

function compareFrame(actual, expected, exact) {
  return exact
    ? compareExact(actual, expected)
    : compareStructure(actual, expected);
}

const options = parseArguments(process.argv.slice(2));
const emulator = new GameBoy(options.model);
emulator.loadROM(new Uint8Array(readFileSync(options.rom)));
const reference = decodeReference(options.reference);
let best = null;
if (options.breakpoint) {
  let instructions = 0;
  while (emulator.baseCycles < options.cycleBudget) {
    if (instructions > 0 && emulator.read8(emulator.pc, true) === 0x40) break;
    emulator.step();
    instructions += 1;
  }
  const comparison = compareFrame(emulator.framebuffer, reference, options.exact);
  best = {
    breakpoint: emulator.read8(emulator.pc, true) === 0x40,
    cycles: emulator.cycles,
    baseCycles: emulator.baseCycles,
    instructions,
    ...comparison,
  };
} else {
  for (let frame = 1; frame <= options.frames; frame += 1) {
    emulator.runFrame();
    const comparison = compareFrame(emulator.framebuffer, reference, options.exact);
    if (!best || comparison.mismatched < best.mismatched) {
      best = { frame, ...comparison };
    }
    if (comparison.mismatched === 0) break;
  }
}
if (options.output) encodeFramebuffer(options.output, emulator.framebuffer);
console.log(JSON.stringify({
  model: options.model,
  comparison: options.exact ? "exact-rgb" : "color-structure",
  rom: options.rom,
  reference: options.reference,
  output: options.output,
  ...best,
  matchPercent: Number(((best.pixels - best.mismatched) / best.pixels * 100).toFixed(4)),
  pass: best.mismatched === 0,
}, null, 2));
if (best.mismatched !== 0 || (options.breakpoint && !best.breakpoint)) process.exitCode = 1;
