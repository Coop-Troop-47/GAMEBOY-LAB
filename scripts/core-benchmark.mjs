/* global Buffer, console, process */

import { execFileSync } from "node:child_process";
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

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}

function checksum(emulator) {
  let hash = 2166136261;
  for (let index = 0; index < emulator.framebuffer.length; index += 97) {
    hash ^= emulator.framebuffer[index];
    hash = Math.imul(hash, 16777619);
  }
  for (const value of [
    emulator.pc, emulator.sp, emulator.a, emulator.f, emulator.b, emulator.c,
    emulator.d, emulator.e, emulator.h, emulator.l, emulator.frameNumber,
  ]) {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
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
    cases.push({
      cartridge: cartridge.name,
      model: cartridge.model,
      medianFps: Number(median(values.map((value) => value.fps)).toFixed(2)),
      p10Fps: Number(percentile(values.map((value) => value.fps), 0.1).toFixed(2)),
      medianHeapDeltaKiB: Number(
        (median(values.map((value) => value.heapDelta)) / 1024).toFixed(1),
      ),
      checksum: values.at(-1).checksum,
      trials: values.map((value) => Number(value.fps.toFixed(2))),
    });
  }
  return { label, cases };
}

function summarizeCase(cartridge, values) {
  return {
    cartridge: cartridge.name,
    model: cartridge.model,
    medianFps: Number(median(values.map((value) => value.fps)).toFixed(2)),
    p10Fps: Number(percentile(values.map((value) => value.fps), 0.1).toFixed(2)),
    medianHeapDeltaKiB: Number(
      (median(values.map((value) => value.heapDelta)) / 1024).toFixed(1),
    ),
    checksum: values.at(-1).checksum,
    trials: values.map((value) => Number(value.fps.toFixed(2))),
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
  node: process.version,
  frames: options.frames,
  warmup: options.warmup,
  trials: options.trials,
  isolatedTrials: options.isolate,
  results,
};
if (results.length === 2) {
  report.improvements = results[1].cases.map((currentCase, index) => {
    const baselineCase = results[0].cases[index];
    return {
      cartridge: currentCase.cartridge,
      fpsPercent: Number(
        ((currentCase.medianFps / baselineCase.medianFps - 1) * 100).toFixed(2),
      ),
    };
  });
}
console.log(JSON.stringify(report, null, 2));
