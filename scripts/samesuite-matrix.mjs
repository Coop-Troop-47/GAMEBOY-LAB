/* global Buffer, console, process */

// SameSuite is a hardware-revision suite, not a single CGB score. Keep the
// classification and execution policy in this file so a result can always be
// reproduced from its report. In particular, an unrecognised suffix becomes a
// recorded policy error; it must never silently become CGB-E.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { GameBoy } from "../app/lib/gameboy.js";
import { getEmbeddedBootROM } from "../app/lib/embeddedBios.js";
import { coreSourceSnapshot, gitCommit, romSourceSnapshot } from "./conformance-source.mjs";
import { classifySameSuiteRom } from "./samesuite-policy.mjs";

const PASS_REGISTERS = [3, 5, 8, 13, 21, 34];
const FAIL_REGISTERS = [0x42, 0x42, 0x42, 0x42, 0x42, 0x42];
const RESULT_CODE_ADDRESS = 0xcffe;
const BREAKPOINT_OPCODE = 0x40; // `ld b,b`, SameSuite's completion marker.
// The public budget is expressed in DMG base-clock T-cycles.  The browser
// core exposes this domain as `baseCycles`, so a CGB speed switch cannot give
// one implementation twice as much emulated time as the other.
const DEFAULT_CYCLE_BUDGET = 80_000_000;
const DEFAULT_WALL_CLOCK_MS = 30_000;
const REVISION_NAMES = new Set(["cgb0", "cgbA", "cgbB", "cgbC", "cgbD", "cgbE"]);
const CGB_BOOT_BYTES = 0x900;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

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

function parseArguments(argv) {
  const options = {
    root: null,
    cycles: DEFAULT_CYCLE_BUDGET,
    wallClockMs: DEFAULT_WALL_CLOCK_MS,
    match: null,
    quiet: false,
    boot: null,
    bootPath: null,
    bootDir: null,
    sourceRoot: null,
    reportPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/samesuite-matrix.mjs [options] SUITE_ROOT");
      console.log("  --boot none|embedded|path     Explicit boot policy (required)");
      console.log("  --boot-path PATH              Use one explicitly named boot ROM");
      console.log("  --boot-dir DIR                Use revision-aware CGB boot mapping");
      console.log("  --source-root DIR             Root of the exact GAMEBOY LAB core being measured");
      console.log("  --cycles N                    Per-ROM DMG base-clock T-cycle budget");
      console.log("  --wall-clock-ms N             Per-ROM host safety timeout");
      console.log("  --match REGEXP                Limit the ROM set");
      console.log("  --report PATH                 Write the complete JSON report");
      console.log("  --quiet                       Suppress per-ROM progress lines");
      process.exit(0);
    }
    else if (argument === "--cycles") options.cycles = Number(argv[++index]);
    else if (argument === "--wall-clock-ms") options.wallClockMs = Number(argv[++index]);
    else if (argument === "--match") options.match = new RegExp(argv[++index], "i");
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--boot") options.boot = argv[++index];
    else if (argument === "--boot-path") options.bootPath = resolve(argv[++index]);
    else if (argument === "--boot-dir") {
      options.boot = "dir";
      options.bootDir = resolve(argv[++index]);
    }
    else if (argument === "--source-root") options.sourceRoot = resolve(argv[++index]);
    else if (argument === "--report") options.reportPath = resolve(argv[++index]);
    else if (!options.root) options.root = resolve(argument);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.root) throw new Error("Provide the SameSuite root directory.");
  if (!options.boot) throw new Error("Choose an explicit boot policy with --boot or --boot-dir; implicit boot state is not benchmark-safe.");
  if (!Number.isInteger(options.cycles) || options.cycles < 1) {
    throw new Error("--cycles must be a positive integer.");
  }
  if (!Number.isInteger(options.wallClockMs) || options.wallClockMs < 1) {
    throw new Error("--wall-clock-ms must be a positive integer.");
  }
  if (!["none", "embedded", "path", "dir"].includes(options.boot)) {
    throw new Error("--boot must be none, embedded, path, or dir.");
  }
  if (options.boot === "path" && !options.bootPath) throw new Error("--boot path requires --boot-path.");
  if (options.boot !== "path" && options.bootPath) throw new Error("--boot-path is only valid with --boot path.");
  if (options.boot === "dir" && !options.bootDir) throw new Error("--boot dir requires --boot-dir.");
  if (options.boot !== "dir" && options.bootDir) throw new Error("--boot-dir is only valid with --boot dir.");
  return options;
}

function registerSignature(emulator) {
  return [emulator.b, emulator.c, emulator.d, emulator.e, emulator.h, emulator.l];
}

function detectResult(emulator) {
  if (emulator.read8(emulator.pc, true) !== BREAKPOINT_OPCODE) return null;
  const registers = registerSignature(emulator);
  const resultCode = emulator.read8(RESULT_CODE_ADDRESS, true);
  if (resultCode === 0x50
    && registers.every((value, index) => value === PASS_REGISTERS[index])) return "pass";
  if (resultCode === 0x46
    && registers.every((value, index) => value === FAIL_REGISTERS[index])) return "fail";
  return "protocol-error";
}

function bootForRevision(options, revision) {
  if (options.boot === "none") return { bytes: null, path: null, source: "none" };
  if (options.boot === "embedded") {
    if (revision !== "cgbE") {
      return {
        bytes: null,
        path: null,
        source: `invalid:embedded-for-${revision}`,
      };
    }
    const bytes = getEmbeddedBootROM("cgb");
    return { bytes, path: null, source: "embedded:cgb", size: bytes.length };
  }
  if (options.boot === "path") {
    if (!statSync(options.bootPath, { throwIfNoEntry: false })) {
      return { bytes: null, path: options.bootPath, source: "unavailable:explicit-path", size: null };
    }
    const bytes = new Uint8Array(readFileSync(options.bootPath));
    if (bytes.length !== CGB_BOOT_BYTES) {
      return {
        bytes: null,
        path: options.bootPath,
        source: "invalid-size:explicit-path",
        size: bytes.length,
      };
    }
    return {
      bytes,
      path: options.bootPath,
      source: "explicit-path",
      size: bytes.length,
    };
  }
  const loadDirectoryBoot = (path, source) => {
    if (!statSync(path, { throwIfNoEntry: false })) {
      return { bytes: null, path: null, source: `unavailable:${revision}`, size: null };
    }
    const bytes = new Uint8Array(readFileSync(path));
    // SameBoy stores CGB boot ROMs in a 0x900-byte image. A compact 0x800
    // image can be accepted by the browser core, but must not silently enter
    // a controlled reference comparison as if it were the same input.
    if (bytes.length !== CGB_BOOT_BYTES) {
      return { bytes: null, path, source: `invalid-size:${source}`, size: bytes.length };
    }
    return { bytes, path, source, size: bytes.length };
  };
  const exact = join(options.bootDir, `${revision}_boot.bin`);
  if (revision === "cgb0" && statSync(exact, { throwIfNoEntry: false })) {
    return loadDirectoryBoot(exact, "revision:cgb0");
  }
  if (revision === "cgbE" && statSync(exact, { throwIfNoEntry: false })) {
    return loadDirectoryBoot(exact, "revision:cgbE");
  }
  if (revision !== "cgb0") {
    const standard = join(options.bootDir, "cgb_boot.bin");
    if (statSync(standard, { throwIfNoEntry: false })) {
      return loadDirectoryBoot(standard, `standard:${revision}->cgb`);
    }
  }
  return { bytes: null, path: null, source: `unavailable:${revision}`, size: null };
}

function bootPolicyVerification(options, cases) {
  // A single image (or a post-boot run) is useful for a diagnostic, but it is
  // not evidence that revision-specific cases received the right boot ROM.
  // Require the directory mapping for a comparable revision matrix.
  if (options.boot !== "dir") {
    return {
      verified: false,
      reason: "Revision-aware comparisons require --boot-dir; a single image or no-boot run is diagnostic only.",
    };
  }
  if (!cases.length) {
    return {
      verified: false,
      reason: "No measured cases have boot evidence.",
    };
  }
  const expectedSources = {
    cgb0: new Set(["revision:cgb0"]),
    cgbA: new Set(["standard:cgbA->cgb"]),
    cgbB: new Set(["standard:cgbB->cgb"]),
    cgbC: new Set(["standard:cgbC->cgb"]),
    cgbD: new Set(["standard:cgbD->cgb"]),
    cgbE: new Set(["revision:cgbE", "standard:cgbE->cgb"]),
  };
  const invalid = cases.filter((record) => {
    if (!REVISION_NAMES.has(record.revision)) return true;
    return record.result === "unsupported"
      || !record.bootSha256
      || record.bootSize !== CGB_BOOT_BYTES
      || !expectedSources[record.revision]?.has(record.bootSource);
  });
  return {
    verified: invalid.length === 0,
    reason: invalid.length
      ? `Boot mapping evidence is missing or unexpected for ${invalid.length} measured case(s).`
      : "Revision-aware boot directory mapping verified for every measured case.",
  };
}

function run(path, classification, cycleBudget, wallClockMs, boot) {
  const started = performance.now();
  const rom = new Uint8Array(readFileSync(path));
  let emulator;
  let result = null;
  let timeoutReason = null;
  let steps = 0;
  try {
    emulator = new GameBoy("cgb", { hardwareRevision: classification.revision });
    if (emulator.hardwareRevision !== classification.revision) {
      throw new Error(`Core selected ${emulator.hardwareRevision} instead of requested ${classification.revision}`);
    }
    if (boot) emulator.setBootROM(boot);
    emulator.loadROM(rom);
    while (emulator.baseCycles < cycleBudget) {
      result = detectResult(emulator);
      if (result) break;
      emulator.step();
      steps += 1;
      if ((steps & 0x3ff) === 0
        && performance.now() - started >= wallClockMs) {
        timeoutReason = `Host safety timeout after ${wallClockMs} ms.`;
        result = "timeout";
        break;
      }
    }
  } catch (error) {
    return {
      result: "error",
      error: error instanceof Error ? error.message : String(error),
      cycles: emulator?.cycles ?? 0,
      milliseconds: performance.now() - started,
      registers: emulator ? registerSignature(emulator) : [],
      selectedRevision: emulator?.hardwareRevision ?? null,
      pc: emulator?.pc ?? null,
      opcode: emulator ? emulator.read8(emulator.pc, true) : null,
      resultCode: emulator ? emulator.read8(RESULT_CODE_ADDRESS, true) : null,
      baseCycles: emulator?.baseCycles ?? 0,
      timeoutReason,
    };
  }
  return {
    result: result ?? "timeout",
    cycles: emulator.cycles,
    baseCycles: emulator.baseCycles,
    milliseconds: performance.now() - started,
    registers: registerSignature(emulator),
    selectedRevision: emulator.hardwareRevision,
    pc: emulator.pc,
    opcode: emulator.read8(emulator.pc, true),
    resultCode: emulator.read8(RESULT_CODE_ADDRESS, true),
    serial: emulator.serialOutput || "",
    timeoutReason,
  };
}

function marker(result) {
  return {
    pass: "PASS",
    fail: "FAIL",
    timeout: "TIME",
    crash: "CRASH",
    error: "ERR ",
    unsupported: "SKIP",
    "protocol-error": "PROTO",
  }[result] || "????";
}

const options = parseArguments(process.argv.slice(2));
const coreSource = options.sourceRoot
  ? coreSourceSnapshot(options.sourceRoot)
  : null;
const allFiles = collectRoms(options.root);
const isSgbPath = (path) => relative(options.root, path).toLowerCase().startsWith("sgb/");
const matches = (path) => !options.match || options.match.test(relative(options.root, path));
const excluded = allFiles.filter((path) => isSgbPath(path) && matches(path));
let files = allFiles.filter((path) => !isSgbPath(path)
  && matches(path));
if (!files.length) throw new Error("No matching non-SGB SameSuite ROMs found.");

const cases = [];
for (const path of files) {
  const rom = new Uint8Array(readFileSync(path));
  let classification;
  let boot = { bytes: null, path: null, source: "unresolved" };
  let result;
  try {
    classification = classifySameSuiteRom(path, options.root);
    if (!REVISION_NAMES.has(classification.revision)) {
      throw new Error(`Invalid revision policy: ${classification.revision}`);
    }
    boot = bootForRevision(options, classification.revision);
    result = boot.bytes
      ? run(path, classification, options.cycles, options.wallClockMs, boot.bytes)
      : {
        result: "unsupported",
        error: boot.source.startsWith("invalid:")
          ? `Boot policy cannot run ${classification.revision}: ${boot.source}. Use --boot-dir for revision-aware comparisons.`
          : `No boot ROM available for ${classification.revision}.`,
        cycles: 0,
        milliseconds: 0,
        registers: [],
        selectedRevision: null,
        pc: null,
        opcode: null,
        resultCode: null,
        baseCycles: 0,
        serial: "",
        timeoutReason: boot.source.startsWith("invalid:")
          ? "Boot image rejected before execution."
          : null,
      };
  } catch (error) {
    result = {
      result: "error",
      error: error instanceof Error ? error.message : String(error),
      cycles: 0,
      milliseconds: 0,
      registers: [],
      selectedRevision: null,
      pc: null,
      opcode: null,
      resultCode: null,
      baseCycles: 0,
      serial: "",
      timeoutReason: null,
    };
    classification ||= {
      revision: null,
      source: "classification-error",
      rationale: "No revision was selected because the filename policy rejected this case.",
    };
  }
  const record = {
    path: relative(options.root, path),
    sha256: sha256(rom),
    bytes: rom.length,
    model: "cgb",
    revision: classification.revision,
    revisionCandidates: classification.revisions || (classification.revision ? [classification.revision] : []),
    classification: classification.source,
    rationale: classification.rationale,
    bootSource: boot.source,
    bootPath: boot.path,
    bootSha256: boot.bytes ? sha256(boot.bytes) : null,
    bootSize: boot.size ?? null,
    ...result,
  };
  cases.push(record);
  if (!options.quiet) {
    console.log(`${marker(record.result).padEnd(5)} ${(record.revision || "????").padEnd(4)} ${record.path}`
      + ` · ${(record.cycles / 1_000_000).toFixed(2)} M cycles`);
  }
}

const totals = cases.reduce((summary, record) => {
  summary[record.result] = (summary[record.result] || 0) + 1;
  return summary;
}, { pass: 0, fail: 0, timeout: 0, crash: 0, error: 0, unsupported: 0, "protocol-error": 0 });
const byRevision = {};
for (const record of cases) {
  const revisionKey = record.revision || "unclassified";
  const group = byRevision[revisionKey] || {
    total: 0, pass: 0, fail: 0, timeout: 0, crash: 0, error: 0, unsupported: 0, "protocol-error": 0,
  };
  group.total += 1;
  group[record.result] += 1;
  byRevision[revisionKey] = group;
}
const romManifest = cases
  .map((record) => `${record.path}\t${record.bytes}\t${record.sha256}`)
  .sort()
  .join("\n");
const excludedCases = excluded.map((path) => {
  const rom = new Uint8Array(readFileSync(path));
  return {
    path: relative(options.root, path),
    sha256: sha256(rom),
    bytes: rom.length,
    status: "unsupported",
    reason: "SGB tests require an SGB host",
  };
});
const romSource = romSourceSnapshot(options.root, [...files, ...excluded]);
const selectedRevisionMismatches = cases
  .filter((record) => record.result !== "unsupported"
    && record.selectedRevision !== record.revision)
  .map((record) => ({
    path: record.path,
    requestedRevision: record.revision,
    selectedRevision: record.selectedRevision,
  }));
const bootVerification = bootPolicyVerification(options, cases);
const bootPolicySha256 = Object.fromEntries([...REVISION_NAMES].map((revision) => {
  const boot = bootForRevision(options, revision);
  return [revision, boot.bytes ? sha256(boot.bytes) : null];
}));
const report = {
  harness: "samesuite-matrix",
  harnessVersion: 8,
  suite: "SameSuite",
  suiteCommit: gitCommit(options.root),
  coreSource,
  root: options.root,
  romSource,
  romManifestSha256: sha256(Buffer.from(romManifest)),
  policy: {
    model: "cgb",
    boot: options.boot,
    bootSha256: bootPolicySha256,
    bootMapping: options.boot === "dir"
      ? "cgb0 uses cgb0_boot.bin; cgbA-D use cgb_boot.bin; cgbE uses cgbE_boot.bin when present or cgb_boot.bin as recorded fallback"
      : options.boot === "embedded"
        ? "single embedded production CGB image; use --boot-dir for reference comparisons"
        : "single explicit image or no boot",
    cycleBudget: options.cycles,
    cycleUnit: "DMG base-clock T-cycles (4.194304 MHz equivalent)",
    wallClockMs: options.wallClockMs,
    passDetection: "SameSuite base.inc result byte ('P'/'F') plus Fibonacci registers at opcode 0x40; unknown combinations are protocol errors",
    excluded: { count: excluded.length, reason: "SGB tests require an SGB host" },
  },
  total: cases.length,
  measured: cases.length - totals.unsupported,
  excluded: excluded.length,
  excludedCases,
  ...totals,
  passRate: cases.length - totals.unsupported
    ? Number((totals.pass / (cases.length - totals.unsupported) * 100).toFixed(2))
    : 0,
  byRevision,
  selectedRevisionMismatches,
  bootPolicyVerified: selectedRevisionMismatches.length === 0 && bootVerification.verified,
  bootPolicyReason: bootVerification.reason,
  cases,
};
if (options.reportPath) writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (totals.timeout || totals.crash || totals.error || totals.unsupported || totals["protocol-error"]
  || !report.bootPolicyVerified) process.exitCode = 1;
