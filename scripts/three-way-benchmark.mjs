/* global console, process */

// Host-throughput comparison for the three cores used in the release audit.
// This intentionally measures the same ROM, model, warm-up, measured-frame
// count, and trial order for every backend. It is a throughput report, not a
// pixel-accuracy ranking: each reference core is driven by a small native
// adapter and its final framebuffer hash is retained beside the timing data.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { GameBoy } from "../app/lib/gameboy.js";

const DEFAULT_FRAMES = 600;
const DEFAULT_WARMUP = 120;
const DEFAULT_TRIALS = 9;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function quantile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function standardDeviation(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function fnv1a(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function parseArgs(argv) {
  const options = {
    frames: DEFAULT_FRAMES,
    warmup: DEFAULT_WARMUP,
    trials: DEFAULT_TRIALS,
    sameboyRunner: null,
    gambatteRunner: null,
    gambatteCore: null,
    sameboyLabel: "SameBoy",
    gambatteLabel: "Gambatte-libretro",
    report: null,
    worker: false,
    workerModel: null,
    workerRom: null,
  };
  const roms = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/three-way-benchmark.mjs [options] [ROM ...]");
      console.log("  --sameboy-runner PATH    SameBoy adapter (model warmup frames ROM)");
      console.log("  --gambatte-runner PATH   Gambatte adapter (core model warmup frames ROM)");
      console.log("  --gambatte-core PATH     Gambatte-libretro dynamic library");
      console.log("  --frames N --warmup N --trials N");
      console.log("  --report PATH            Write the complete JSON report");
      process.exit(0);
    }
    if (argument === "--frames") options.frames = Number(argv[++index]);
    else if (argument === "--warmup") options.warmup = Number(argv[++index]);
    else if (argument === "--trials") options.trials = Number(argv[++index]);
    else if (argument === "--sameboy-runner") options.sameboyRunner = resolve(argv[++index]);
    else if (argument === "--gambatte-runner") options.gambatteRunner = resolve(argv[++index]);
    else if (argument === "--gambatte-core") options.gambatteCore = resolve(argv[++index]);
    else if (argument === "--sameboy-label") options.sameboyLabel = argv[++index];
    else if (argument === "--gambatte-label") options.gambatteLabel = argv[++index];
    else if (argument === "--report") options.report = resolve(argv[++index]);
    else if (argument === "--worker") options.worker = true;
    else if (argument === "--model") options.workerModel = argv[++index];
    else if (argument === "--rom") options.workerRom = resolve(argv[++index]);
    else roms.push(resolve(argument));
  }
  if (!roms.length && !options.worker) {
    roms.push(
      resolve("SELECT_ROMS/Tetris (World) (Rev 1).gb"),
      resolve("SELECT_ROMS/Tetris DX (World) (SGB Enhanced) (GB Compatible).gbc"),
    );
  }
  for (const key of ["frames", "warmup", "trials"]) {
    if (!Number.isInteger(options[key]) || options[key] < 1) {
      throw new Error(`--${key} must be a positive integer.`);
    }
  }
  if (options.worker && (!options.workerModel || !options.workerRom)) {
    throw new Error("Worker mode requires --model and --rom.");
  }
  if (!options.worker && (!options.sameboyRunner || !options.gambatteRunner || !options.gambatteCore)) {
    throw new Error("Provide SameBoy and Gambatte adapter/core paths for a three-way run.");
  }
  return { options, roms };
}

function modelForRom(rom) {
  return (rom[0x143] & 0x80) ? "cgb" : "dmg";
}

function runLabWorker(romPath, model, warmup, frames) {
  const emulator = new GameBoy(model);
  emulator.loadROM(new Uint8Array(readFileSync(romPath)));
  for (let index = 0; index < warmup; index += 1) emulator.runFrame();
  if (globalThis.gc) globalThis.gc();
  const started = performance.now();
  for (let index = 0; index < frames; index += 1) emulator.runFrame();
  const milliseconds = performance.now() - started;
  console.log(JSON.stringify({
    milliseconds,
    fps: frames / milliseconds * 1000,
    checksum: fnv1a(new Uint8Array(emulator.framebuffer.buffer)),
    frame: emulator.frameNumber,
    baseCycles: emulator.baseCycles,
  }));
}

function parseAdapterOutput(output) {
  const line = output.trim().split(/\r?\n/).findLast((entry) => entry.trim());
  if (!line) throw new Error("Adapter returned no result line.");
  const hash = line.match(/hash=([0-9a-f]+)/i)?.[1]?.toLowerCase();
  const frames = Number(line.match(/frames=(\d+)/)?.[1]);
  if (!hash || !Number.isInteger(frames)) throw new Error(`Unrecognised adapter output: ${line}`);
  return { checksum: hash, frames };
}

function runAdapter(command, args, frames) {
  const started = performance.now();
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const milliseconds = performance.now() - started;
  if (result.status !== 0) {
    throw new Error(`${basename(command)} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  const parsed = parseAdapterOutput(result.stdout);
  if (parsed.frames !== frames) throw new Error(`${basename(command)} returned ${parsed.frames} measured frames, expected ${frames}.`);
  return { milliseconds, fps: frames / milliseconds * 1000, checksum: parsed.checksum };
}

function summarize(label, values) {
  const fps = values.map((value) => value.fps);
  const medianFps = median(fps);
  const p10 = quantile(fps, 0.1);
  const p90 = quantile(fps, 0.9);
  return {
    label,
    medianFps: Number(medianFps.toFixed(2)),
    p10Fps: Number(p10.toFixed(2)),
    p90Fps: Number(p90.toFixed(2)),
    minFps: Number(Math.min(...fps).toFixed(2)),
    maxFps: Number(Math.max(...fps).toFixed(2)),
    stddevFps: Number(standardDeviation(fps).toFixed(2)),
    variationPercent: Number(((p90 - p10) / Math.max(.0001, medianFps) * 100).toFixed(2)),
    checksums: values.map((value) => value.checksum),
    outputStable: values.every((value) => value.checksum === values[0].checksum),
    trials: values.map((value) => Number(value.fps.toFixed(2))),
  };
}

function runLab(options, romPath, model) {
  const workerArgs = [
    process.execPath,
    "--expose-gc",
    new URL(import.meta.url).pathname,
    "--worker",
    "--model", model,
    "--rom", romPath,
    "--warmup", String(options.warmup),
    "--frames", String(options.frames),
  ];
  const started = performance.now();
  const result = spawnSync(workerArgs[0], workerArgs.slice(1), { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const milliseconds = performance.now() - started;
  if (result.status !== 0) throw new Error(`LAB worker exited ${result.status}: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout.trim());
  return { milliseconds, fps: options.frames / milliseconds * 1000, checksum: parsed.checksum };
}

const { options, roms } = parseArgs(process.argv.slice(2));
if (options.worker) {
  runLabWorker(options.workerRom, options.workerModel, options.warmup, options.frames);
  process.exit(0);
}

const cartridges = roms.map((path) => {
  const rom = new Uint8Array(readFileSync(path));
  return {
    name: basename(path),
    path,
    model: modelForRom(rom),
    bytes: rom.length,
    sha256: sha256(rom),
  };
});
const backends = ["lab", "sameboy", "gambatte"];
const cases = [];
for (const cartridge of cartridges) {
  const values = Object.fromEntries(backends.map((label) => [label, []]));
  for (let trial = 0; trial < options.trials; trial += 1) {
    const order = backends.map((_, index) => backends[(index + trial) % backends.length]);
    for (const backend of order) {
      if (backend === "lab") {
        values.lab.push(runLab(options, cartridge.path, cartridge.model));
      } else if (backend === "sameboy") {
        values.sameboy.push(runAdapter(
          options.sameboyRunner,
          [cartridge.model, String(options.warmup), String(options.frames), cartridge.path],
          options.frames,
        ));
      } else {
        values.gambatte.push(runAdapter(
          options.gambatteRunner,
          [options.gambatteCore, cartridge.model, String(options.warmup), String(options.frames), cartridge.path],
          options.frames,
        ));
      }
    }
  }
  cases.push({
    cartridge: cartridge.name,
    model: cartridge.model,
    romBytes: cartridge.bytes,
    romSha256: cartridge.sha256,
    results: backends.map((backend) => summarize(backend, values[backend])),
  });
}

const report = {
  harness: "three-way-benchmark",
  harnessVersion: 1,
  frames: options.frames,
  warmup: options.warmup,
  trials: options.trials,
  policy: {
    scope: "core execution plus native framebuffer delivery; no DOM, CSS, shader or host audio backend",
    boot: "none/post-boot for all three adapters",
    order: "rotated LAB/SameBoy/Gambatte order per trial",
    note: "Cross-core checksums are reported for reproducibility; differing checksums make no cross-core speed claim.",
  },
  adapters: {
    lab: { source: "app/lib/gameboy.js" },
    sameboy: { runner: options.sameboyRunner, label: options.sameboyLabel },
    gambatte: { runner: options.gambatteRunner, core: options.gambatteCore, label: options.gambatteLabel },
  },
  cases,
};
if (options.report) writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
