/* global Buffer, console, process */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArguments(argv) {
  const options = {
    baselineRef: null,
    frames: 600,
    trials: 5,
    warmup: 120,
    isolate: true,
    worker: false,
    coreReference: null,
    workerRom: null,
    workerModel: null,
    roms: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node --expose-gc scripts/core-benchmark.mjs [options] [ROM ...]");
      console.log("  --baseline-ref REF             Compare the current core to a git ref");
      console.log("  --warmup N --frames N          Warm-up and measured frame counts");
      console.log("  --trials N                     Number of alternating paired trials");
      console.log("  --no-isolate                   Keep both cores in this process");
      process.exit(0);
    }
    if (argument === "--baseline-ref") options.baselineRef = argv[++index];
    else if (argument === "--frames") options.frames = Number(argv[++index]);
    else if (argument === "--trials") options.trials = Number(argv[++index]);
    else if (argument === "--warmup") options.warmup = Number(argv[++index]);
    else if (argument === "--no-isolate") options.isolate = false;
    else if (argument === "--worker") options.worker = true;
    else if (argument === "--core-reference") options.coreReference = argv[++index] || null;
    else if (argument === "--rom") options.workerRom = resolve(argv[++index]);
    else if (argument === "--model") options.workerModel = argv[++index] || null;
    else options.roms.push(resolve(argument));
  }
  if (!options.roms.length) {
    options.roms = [
      resolve("SELECT_ROMS/Tetris (World) (Rev 1).gb"),
      resolve("SELECT_ROMS/Tetris DX (World) (SGB Enhanced) (GB Compatible).gbc"),
    ];
  }
  for (const key of ["frames", "trials", "warmup"]) {
    if (!Number.isInteger(options[key]) || options[key] < 0) {
      throw new Error(`--${key} must be a non-negative integer.`);
    }
  }
  if (options.frames === 0 || options.trials === 0) {
    throw new Error("--frames and --trials must be greater than zero.");
  }
  return options;
}

async function importCore(reference = null) {
  if (!reference) {
    return import(`${pathToFileURL(resolve("app/lib/gameboy.js"))}?benchmark=${Date.now()}`);
  }
  const source = execFileSync(
    "git",
    ["show", `${reference}:app/lib/gameboy.js`],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function gitCommit(ref = "HEAD") {
  try {
    return execFileSync("git", ["rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitBlobSha256(ref, path) {
  try {
    const blob = execFileSync("git", ["show", `${ref}:${path}`], { encoding: null });
    return sha256(blob);
  } catch {
    return null;
  }
}

function runIsolatedTrial(cartridge, options, coreReference = null) {
  const workerArgs = [
    "--expose-gc",
    fileURLToPath(import.meta.url),
    "--worker",
    "--rom", cartridge.path,
    "--model", cartridge.model,
    "--warmup", String(options.warmup),
    "--frames", String(options.frames),
  ];
  if (coreReference) workerArgs.push("--core-reference", coreReference);
  const output = execFileSync(process.execPath, workerArgs, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(output.trim());
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
  if (!ordered.length) return 0;
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function standardDeviation(values) {
  if (!values.length) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checksum(emulator) {
  let hash = 2166136261;
  const addByte = (value) => {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  };
  for (let index = 0; index < emulator.framebuffer.length; index += 1) {
    addByte(emulator.framebuffer[index]);
  }
  // A throughput comparison is not valid if a refactor changes audio while
  // leaving the framebuffer checksum untouched. Include the exact generated
  // PCM bytes that were produced during the measured window.
  if (emulator.audioSamples && Number.isInteger(emulator.audioSampleCount)) {
    const samples = emulator.audioSamples.subarray(0, emulator.audioSampleCount);
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    for (const value of bytes) addByte(value);
  }
  for (const value of [
    emulator.pc, emulator.sp, emulator.a, emulator.f, emulator.b, emulator.c,
    emulator.d, emulator.e, emulator.h, emulator.l, emulator.frameNumber,
    emulator.cycles, emulator.divCounter, emulator.audioClock, emulator.audioSampleCount,
    emulator.ch1?.timer, emulator.ch1?.dutyPosition, emulator.ch1?.volume,
    emulator.ch2?.timer, emulator.ch2?.dutyPosition, emulator.ch2?.volume,
    emulator.ch3?.timer, emulator.ch3?.wavePosition, emulator.ch3?.currentSample,
    emulator.ch4?.timer, emulator.ch4?.lfsr, emulator.ch4?.volume,
  ]) {
    const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
    addByte(normalized & 0xff);
    addByte((normalized >>> 8) & 0xff);
    addByte((normalized >>> 16) & 0xff);
    addByte((normalized >>> 24) & 0xff);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function runTrial(GameBoy, rom, model, warmupFrames, measuredFrames) {
  const emulator = new GameBoy(model);
  emulator.loadROM(rom);
  for (let frame = 0; frame < warmupFrames; frame += 1) emulator.runFrame();
  if (globalThis.gc) globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let frame = 0; frame < measuredFrames; frame += 1) emulator.runFrame();
  const milliseconds = performance.now() - started;
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    fps: measuredFrames / milliseconds * 1000,
    milliseconds,
    heapDelta: heapAfter - heapBefore,
    checksum: checksum(emulator),
  };
}

async function benchmarkCore(label, core, options, cartridges) {
  const cases = [];
  for (const cartridge of cartridges) {
    const values = [];
    for (let trial = 0; trial < options.trials; trial += 1) {
      values.push(options.isolate
        ? runIsolatedTrial(cartridge, options)
        : runTrial(
          core.GameBoy,
          cartridge.rom,
          cartridge.model,
          options.warmup,
          options.frames,
        ));
    }
    cases.push(summarizeCase(cartridge, values));
  }
  return { label, cases };
}

function summarizeCase(cartridge, values) {
  const fps = values.map((value) => value.fps);
  const medianFps = median(fps);
  const p10 = quantile(fps, 0.1);
  const p90 = quantile(fps, 0.9);
  return {
    cartridge: cartridge.name,
    romSha256: cartridge.sha256,
    romBytes: cartridge.rom.length,
    model: cartridge.model,
    medianFps: Number(medianFps.toFixed(2)),
    p10Fps: Number(p10.toFixed(2)),
    p90Fps: Number(p90.toFixed(2)),
    minFps: Number(Math.min(...fps).toFixed(2)),
    maxFps: Number(Math.max(...fps).toFixed(2)),
    stddevFps: Number(standardDeviation(fps).toFixed(2)),
    variationPercent: Number(((p90 - p10) / Math.max(0.0001, medianFps) * 100).toFixed(2)),
    medianHeapDeltaKiB: Number(
      (median(values.map((value) => value.heapDelta)) / 1024).toFixed(1),
    ),
    checksum: values.at(-1).checksum,
    checksums: values.map((value) => value.checksum),
    trials: values.map((value) => Number(value.fps.toFixed(2))),
  };
}

function assertPairedInputs(baselineCases, currentCases) {
  if (baselineCases.length !== currentCases.length) {
    throw new Error("Paired benchmark produced different case counts.");
  }
  baselineCases.forEach((baselineCase, index) => {
    const currentCase = currentCases[index];
    for (const field of ["cartridge", "romSha256", "romBytes", "model"]) {
      if (baselineCase[field] !== currentCase[field]) {
        throw new Error(`Paired benchmark input mismatch for ${field}: ${baselineCase[field]} != ${currentCase[field]}`);
      }
    }
  });
}

function summarizePairedImprovement(baselineCase, currentCase) {
  if (baselineCase.trials.length !== currentCase.trials.length) {
    throw new Error(`Paired benchmark trial mismatch for ${baselineCase.cartridge}.`);
  }
  const ratios = currentCase.trials.map((fps, index) => (fps / baselineCase.trials[index] - 1) * 100);
  return {
    outputEquivalent: baselineCase.checksum === currentCase.checksum
      && baselineCase.checksums.every((value, index) => value === currentCase.checksums[index]),
    fpsPercent: Number(median(ratios).toFixed(2)),
    p10FpsPercent: Number(quantile(ratios, 0.1).toFixed(2)),
    p90FpsPercent: Number(quantile(ratios, 0.9).toFixed(2)),
    variationPercent: Number(((quantile(ratios, 0.9) - quantile(ratios, 0.1))
      / Math.max(0.0001, median(ratios)) * 100).toFixed(2)),
    pairedTrialFpsPercent: ratios.map((value) => Number(value.toFixed(2))),
    ratioOfMediansPercent: Number(
      ((currentCase.medianFps / baselineCase.medianFps - 1) * 100).toFixed(2),
    ),
    baselineMedianFps: baselineCase.medianFps,
    currentMedianFps: currentCase.medianFps,
  };
}

async function benchmarkPaired(baselineLabel, baselineCore, currentCore, options, cartridges) {
  const baselineCases = [];
  const currentCases = [];
  for (const cartridge of cartridges) {
    const baselineValues = [];
    const currentValues = [];
    for (let trial = 0; trial < options.trials; trial += 1) {
      const order = trial & 1
        ? [[currentCore, currentValues], [baselineCore, baselineValues]]
        : [[baselineCore, baselineValues], [currentCore, currentValues]];
      for (const [core, values] of order) {
        const reference = core === baselineCore ? baselineLabel : null;
        values.push(options.isolate
          ? runIsolatedTrial(cartridge, options, reference)
          : runTrial(
            core.GameBoy,
            cartridge.rom,
            cartridge.model,
            options.warmup,
            options.frames,
          ));
      }
    }
    baselineCases.push(summarizeCase(cartridge, baselineValues));
    currentCases.push(summarizeCase(cartridge, currentValues));
  }
  assertPairedInputs(baselineCases, currentCases);
  return [
    { label: baselineLabel, cases: baselineCases },
    { label: "current", cases: currentCases },
  ];
}

const options = parseArguments(process.argv.slice(2));

if (options.worker) {
  if (!options.workerRom || !options.workerModel) {
    throw new Error("Worker mode requires --rom and --model.");
  }
  const core = await importCore(options.coreReference);
  const rom = new Uint8Array(readFileSync(options.workerRom));
  console.log(JSON.stringify(runTrial(
    core.GameBoy,
    rom,
    options.workerModel,
    options.warmup,
    options.frames,
  )));
  process.exit(0);
}

const cartridges = options.roms.map((path) => {
  const rom = new Uint8Array(readFileSync(path));
  return {
    path,
    name: basename(path),
    model: (rom[0x143] & 0x80) ? "cgb" : "dmg",
    sha256: sha256(rom),
    rom,
  };
});
const current = await importCore();
let results;
if (options.baselineRef) {
  const baseline = await importCore(options.baselineRef);
  results = await benchmarkPaired(
    options.baselineRef,
    baseline,
    current,
    options,
    cartridges,
  );
} else {
  results = [await benchmarkCore("current", current, options, cartridges)];
}

const report = {
  harness: "core-benchmark",
  harnessVersion: 4,
  node: process.version,
  baselineRef: options.baselineRef,
  source: {
    currentCommit: gitCommit(),
    currentBlobSha256: sha256(readFileSync(resolve("app/lib/gameboy.js"))),
    baselineCommit: options.baselineRef ? gitCommit(options.baselineRef) : null,
    baselineBlobSha256: options.baselineRef
      ? gitBlobSha256(options.baselineRef, "app/lib/gameboy.js")
      : null,
  },
  frames: options.frames,
  warmup: options.warmup,
  trials: options.trials,
  isolatedTrials: options.isolate,
  policy: {
    scope: "core + PPU framebuffer + APU sample generation; no DOM, CSS, shader or WebAudio backend",
    performanceClaim: "paired speed is eligible only when framebuffer, PCM output, and terminal core checksums match for every case and trial",
    boot: "none",
    renderer: "native 160x144 framebuffer enabled",
    audio: "core APU enabled, host output disabled",
    settings: {
      frames: options.frames,
      warmup: options.warmup,
      trials: options.trials,
      pairedOrder: "alternating baseline/current per trial",
    },
    roms: cartridges.map((cartridge) => ({
      name: cartridge.name,
      model: cartridge.model,
      bytes: cartridge.rom.length,
      sha256: cartridge.sha256,
    })),
    romManifestSha256: sha256(Buffer.from(cartridges
      .map((cartridge) => `${cartridge.name}\t${cartridge.model}\t${cartridge.rom.length}\t${cartridge.sha256}`)
      .sort()
      .join("\n"))),
  },
  results,
};
if (results.length === 2) {
  assertPairedInputs(results[0].cases, results[1].cases);
  report.improvements = results[1].cases.map((currentCase, index) => {
    const baselineCase = results[0].cases[index];
    return { cartridge: currentCase.cartridge, ...summarizePairedImprovement(baselineCase, currentCase) };
  });
  report.performanceEligible = report.improvements.every((improvement) => improvement.outputEquivalent);
}
console.log(JSON.stringify(report, null, 2));
if (report.performanceEligible === false) process.exitCode = 1;
