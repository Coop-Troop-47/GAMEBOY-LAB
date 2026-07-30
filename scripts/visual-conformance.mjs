/* global console, process */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GameBoy } from "../app/lib/gameboy.js";

function parseArguments(argv) {
  const options = { frames: 30, model: null, reference: null, rom: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--frames") options.frames = Number(argv[++index]);
    else if (argument === "--model") options.model = argv[++index];
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

function rgbKey(bytes, offset) {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function compareStructure(actual, expected) {
  const actualToExpected = new Map();
  const expectedToActual = new Map();
  let mismatched = 0;
  for (let offset = 0; offset < actual.length; offset += 4) {
    const actualColor = rgbKey(actual, offset);
    const expectedColor = rgbKey(expected, offset);
    const mappedExpected = actualToExpected.get(actualColor);
    const mappedActual = expectedToActual.get(expectedColor);
    if (
      (mappedExpected !== undefined && mappedExpected !== expectedColor)
      || (mappedActual !== undefined && mappedActual !== actualColor)
    ) {
      mismatched += 1;
      continue;
    }
    actualToExpected.set(actualColor, expectedColor);
    expectedToActual.set(expectedColor, actualColor);
  }
  return {
    mismatched,
    pixels: actual.length / 4,
    actualColors: actualToExpected.size,
    referenceColors: expectedToActual.size,
  };
}

const options = parseArguments(process.argv.slice(2));
const emulator = new GameBoy(options.model);
emulator.loadROM(new Uint8Array(readFileSync(options.rom)));
const reference = decodeReference(options.reference);
let best = null;
for (let frame = 1; frame <= options.frames; frame += 1) {
  emulator.runFrame();
  const comparison = compareStructure(emulator.framebuffer, reference);
  if (!best || comparison.mismatched < best.mismatched) {
    best = { frame, ...comparison };
  }
  if (comparison.mismatched === 0) break;
}
console.log(JSON.stringify({
  model: options.model,
  rom: options.rom,
  reference: options.reference,
  ...best,
  matchPercent: Number(((best.pixels - best.mismatched) / best.pixels * 100).toFixed(4)),
  pass: best.mismatched === 0,
}, null, 2));
