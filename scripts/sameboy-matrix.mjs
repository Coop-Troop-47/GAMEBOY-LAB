/* global Buffer, console, process */

// Runs the same explicit SameSuite policy against a pinned SameBoy adapter.
// The adapter is intentionally external to the browser build; this script
// records its binary/source identity so a result cannot be mistaken for an
// undocumented “SameBoy score”.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { gitCommit, repositorySnapshot, romSourceSnapshot } from "./conformance-source.mjs";
import {
  classifySameSuiteRom,
  documentedSameBoyExpectation,
} from "./samesuite-policy.mjs";

const DEFAULT_CYCLE_BUDGET = 80_000_000;
const CGB_BOOT_BYTES = 0x900;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceVersion(root) {
  if (!root) return null;
  try {
    const match = readFileSync(join(root, "version.mk"), "utf8")
      .match(/^VERSION\s*:?=\s*([^\s#]+)/m);
    return match?.[1] || null;
  } catch {
    return null;
  }
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
    runner: null,
    root: null,
    cycles: DEFAULT_CYCLE_BUDGET,
    wallClockMs: 30_000,
    boot: null,
    bootPath: null,
    bootDir: null,
    match: null,
    quiet: false,
    reportPath: null,
    sourceRoot: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/sameboy-matrix.mjs --runner PATH [options] SUITE_ROOT");
      console.log("  --boot none|path                 Explicit boot policy (required)");
      console.log("  --boot-path PATH                 Use one explicitly named boot ROM");
      console.log("  --boot-dir DIR                   Use revision-aware CGB boot mapping");
      console.log("  --source-root DIR                Record the pinned reference source");
      console.log("  --cycles N                       Per-ROM DMG base-clock T-cycle budget");
      console.log("  --wall-clock-ms N                External runner safety timeout");
      console.log("  --match REGEXP                   Limit the ROM set");
      console.log("  --report PATH                    Write the complete JSON report");
      console.log("  --quiet                          Suppress per-ROM progress lines");
      process.exit(0);
    }
    if (argument === "--runner") options.runner = resolve(argv[++index]);
    else if (argument === "--cycles") options.cycles = Number(argv[++index]);
    else if (argument === "--wall-clock-ms") options.wallClockMs = Number(argv[++index]);
    else if (argument === "--boot") options.boot = argv[++index];
    else if (argument === "--boot-path") options.bootPath = resolve(argv[++index]);
    else if (argument === "--boot-dir") {
      options.boot = "dir";
      options.bootDir = resolve(argv[++index]);
    }
    else if (argument === "--match") options.match = new RegExp(argv[++index], "i");
    else if (argument === "--report") options.reportPath = resolve(argv[++index]);
    else if (argument === "--source-root") options.sourceRoot = resolve(argv[++index]);
    else if (argument === "--quiet") options.quiet = true;
    else if (!options.root) options.root = resolve(argument);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.runner || !options.root) throw new Error("Usage: node scripts/sameboy-matrix.mjs --runner PATH [options] SUITE_ROOT");
  if (!options.boot) throw new Error("Choose an explicit boot policy with --boot or --boot-dir; implicit boot state is not benchmark-safe.");
  if (!Number.isInteger(options.cycles) || options.cycles < 1) throw new Error("--cycles must be a positive integer.");
  if (!Number.isInteger(options.wallClockMs) || options.wallClockMs < 1) throw new Error("--wall-clock-ms must be a positive integer.");
  if (!["none", "path", "dir"].includes(options.boot)) throw new Error("--boot must be none, path, or dir.");
  if (options.boot === "path" && !options.bootPath) throw new Error("--boot path requires --boot-path.");
  if (options.boot === "dir" && !options.bootDir) throw new Error("--boot-dir requires a directory.");
  if (options.boot !== "path" && options.bootPath) throw new Error("--boot-path requires --boot path.");
  if (options.boot !== "dir" && options.bootDir) throw new Error("--boot-dir requires --boot dir.");
  return options;
}

function bootForRevision(options, revision) {
  if (options.boot === "none") return { path: null, source: "none" };
  if (options.boot === "path") {
    if (!existsSync(options.bootPath)) {
      return { path: null, source: "unavailable:explicit-path", size: null };
    }
    const size = statSync(options.bootPath).size;
    return size === CGB_BOOT_BYTES
      ? { path: options.bootPath, source: "explicit-path", size }
      : { path: null, source: "invalid-size:explicit-path", size };
  }
  const checkDirectoryBoot = (path, source) => {
    if (!existsSync(path)) return { path: null, source: `unavailable:${revision}`, size: null };
    const size = statSync(path).size;
    return size === CGB_BOOT_BYTES
      ? { path, source, size }
      : { path: null, source: `invalid-size:${source}`, size };
  };
  const exact = join(options.bootDir, `${revision}_boot.bin`);
  if (revision === "cgb0" && existsSync(exact)) {
    return checkDirectoryBoot(exact, "revision:cgb0");
  }
  if (revision === "cgbE" && existsSync(exact)) {
    return checkDirectoryBoot(exact, "revision:cgbE");
  }
  if (revision !== "cgb0") {
    const standard = join(options.bootDir, "cgb_boot.bin");
    if (existsSync(standard)) return checkDirectoryBoot(standard, `standard:${revision}->cgb`);
  }
  return { path: null, source: `unavailable:${revision}`, size: null };
}

function bootPolicyVerification(options, cases) {
  // A reference process can be pointed at one arbitrary image for a
  // diagnostic, but that must never be reported as a revision-controlled
  // comparison. The verified matrix uses the explicit directory mapping.
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
    if (!Object.hasOwn(expectedSources, record.requestedRevision)) return true;
    return record.result === "unsupported"
      || !record.bootSha256
      || record.bootSize !== CGB_BOOT_BYTES
      || !expectedSources[record.requestedRevision]?.has(record.bootSource);
  });
  return {
    verified: invalid.length === 0,
    reason: invalid.length
      ? `Boot mapping evidence is missing or unexpected for ${invalid.length} measured case(s).`
      : "Revision-aware boot directory mapping verified for every measured case.",
  };
}

function hasValidProtocolEvidence(result) {
  if (!["pass", "fail"].includes(result.result)) return true;
  const expected = result.result === "pass"
    ? [3, 5, 8, 13, 21, 34]
    : [0x42, 0x42, 0x42, 0x42, 0x42, 0x42];
  return result.opcode === 0x40
    && result.resultCode === (result.result === "pass" ? 0x50 : 0x46)
    && Array.isArray(result.registers)
    && result.registers.length === expected.length
    && result.registers.every((value, index) => value === expected[index]);
}

function runReference(options, romPath, revision, boot) {
  if (options.boot !== "none" && !boot.path) {
    return {
      result: "unsupported",
      error: boot.source.startsWith("invalid-size")
        ? `Boot image rejected for ${revision}: ${boot.source}.`
        : `No boot ROM available for ${revision}.`,
      cycles: 0,
      baseCycles: 0,
      processExit: null,
      signal: null,
    };
  }
  const args = ["--model", revision, "--base-cycles", String(options.cycles)];
  if (boot.path) args.push("--boot", boot.path);
  args.push(romPath);
  const child = spawnSync(options.runner, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: options.wallClockMs,
  });
  // On macOS Node may expose spawnSync's wall-clock kill as SIGTERM without
  // populating `error.code`; a missing exit status plus that signal is still a
  // timeout, not a reference-core crash or a revision mismatch.
  const timedOut = child.error?.code === "ETIMEDOUT"
    || (child.status === null && child.signal === "SIGTERM");
  const lines = (child.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  let payload = null;
  if (lines.length) {
    try { payload = JSON.parse(lines.at(-1)); } catch { /* classified below */ }
  }
  if (payload) {
    if (timedOut) {
      return {
        ...payload,
        result: "timeout",
        processExit: child.status,
        signal: child.signal,
        bootSource: boot.source,
        error: `Reference runner exceeded the ${options.wallClockMs} ms wall-clock limit.`,
        payload,
        stderr: (child.stderr || "").trim().slice(-500),
      };
    }
    const validResults = new Set(["pass", "fail", "timeout", "crash", "error", "protocol-error"]);
    if (!validResults.has(payload.result)) {
      return {
        result: "protocol-error",
        processExit: child.status,
        signal: child.signal,
        bootSource: boot.source,
        error: "Reference runner returned an unknown result status.",
        payload,
      };
    }
    // The adapter has a small exit-code contract: a pass/fail/timeout/protocol
    // record must agree with its process status. Do not let a stale/partial
    // JSON line turn a crashed adapter (or an exit-code mismatch) into a pass.
    const expectedExit = {
      pass: 0,
      fail: 1,
      timeout: 2,
      "protocol-error": 3,
    }[payload.result];
    if (child.signal || expectedExit === undefined || child.status !== expectedExit) {
      return {
        ...payload,
        result: child.signal ? "crash" : "error",
        processExit: child.status,
        signal: child.signal,
        bootSource: boot.source,
        error: child.signal
          ? `Reference runner terminated by ${child.signal}.`
          : `Reference runner exited ${child.status} after reporting ${payload.result}; expected ${expectedExit ?? "no exit code"}.`,
        payload,
        stderr: (child.stderr || "").trim().slice(-500),
      };
    }
    return {
      ...payload,
      processExit: child.status,
      signal: child.signal,
      bootSource: boot.source,
      stderr: (child.stderr || "").trim().slice(-500),
    };
  }
  return {
    result: timedOut
      ? "timeout"
      : child.signal ? "crash" : "error",
    processExit: child.status,
    signal: child.signal,
    bootSource: boot.source,
    error: child.error?.message,
    cycles: 0,
    baseCycles: 0,
    stderr: (child.stderr || "").trim().slice(-500),
  };
}

function marker(result) {
  return {
    pass: "PASS", fail: "FAIL", timeout: "TIME", crash: "CRASH", error: "ERR ",
    unsupported: "SKIP", "protocol-error": "PROTO",
  }[result] || "????";
}

const options = parseArguments(process.argv.slice(2));
const allFiles = collectRoms(options.root);
const isSgbPath = (path) => relative(options.root, path).toLowerCase().startsWith("sgb/");
const matches = (path) => !options.match || options.match.test(relative(options.root, path));
const excluded = allFiles.filter((path) => isSgbPath(path) && matches(path));
const files = allFiles.filter((path) => !isSgbPath(path) && matches(path));
if (!files.length) throw new Error("No matching non-SGB SameSuite ROMs found.");

let runnerSha256 = null;
try { runnerSha256 = sha256(readFileSync(options.runner)); } catch { /* report identity still shows path */ }
const cases = [];
for (const path of files) {
  const rom = new Uint8Array(readFileSync(path));
  let classification;
  let boot = { path: null, source: "unresolved" };
  let result;
  try {
    classification = classifySameSuiteRom(path, options.root);
    boot = bootForRevision(options, classification.revision);
    result = runReference(options, path, classification.revision, boot);
  } catch (error) {
    classification ||= {
      revision: null,
      source: "classification-error",
      rationale: "No revision was selected because the filename policy rejected this case.",
    };
    result = {
      result: "error",
      error: error instanceof Error ? error.message : String(error),
      processExit: null,
      signal: null,
      cycles: 0,
      baseCycles: 0,
      bootSource: boot.source,
      stderr: "",
    };
  }
  const documentedExpectation = documentedSameBoyExpectation(
    path,
    options.root,
    classification.revision,
  );
  const record = {
    ...result,
    path: relative(options.root, path),
    sha256: sha256(rom),
    bytes: rom.length,
    model: "cgb",
    requestedRevision: classification.revision,
    revisionCandidates: classification.revisions || (classification.revision ? [classification.revision] : []),
    classification: classification.source,
    rationale: classification.rationale,
    bootSource: boot.source,
    bootPath: boot.path,
    bootSha256: boot.path ? sha256(readFileSync(boot.path)) : null,
    bootSize: boot.size ?? null,
    documentedExpectation,
    referenceModel: result.model ?? null,
    referenceRequestedRevision: result.requestedRevision ?? null,
  };
  if (record.referenceModel && record.referenceModel !== "cgb") {
    record.result = "error";
    record.error = `Reference selected model ${record.referenceModel}, expected cgb.`;
  } else if (["pass", "fail"].includes(record.result)
    && (!record.referenceModel || !record.selectedRevision || !record.referenceRequestedRevision)) {
    record.result = "error";
    record.error = "Reference runner did not report the selected model and revision identity (requested and selected revisions).";
  } else if (["pass", "fail"].includes(record.result)
    && record.referenceRequestedRevision !== classification.revision) {
    record.result = "error";
    record.error = `Reference requested ${record.referenceRequestedRevision || "unknown"}, expected ${classification.revision}.`;
  } else if (record.result !== "unsupported"
    && record.selectedRevision
    && record.selectedRevision !== classification.revision) {
    record.result = "error";
    record.error = `Reference selected ${record.selectedRevision || "unknown"}, requested ${classification.revision}.`;
  }
  // Only classify marker evidence after identity checks. This preserves the
  // actionable model/revision error when an adapter selects the wrong target,
  // while still refusing to count an unverified pass/fail as a test result.
  if (["pass", "fail"].includes(record.result) && !hasValidProtocolEvidence(record)) {
    record.result = "protocol-error";
    record.error = "Reference runner reported pass/fail without the exact SameSuite marker evidence.";
  }
  record.unexpectedAgainstDocumentation = documentedExpectation.status === "pass"
    ? record.result !== "pass"
    : documentedExpectation.status === "documented-exception"
      ? record.result === "pass"
      : null;
  cases.push(record);
  if (!options.quiet) console.log(`${marker(record.result).padEnd(5)} ${(record.requestedRevision || "????").padEnd(4)} ${record.path}`);
}

const totals = cases.reduce((summary, record) => {
  summary[record.result] = (summary[record.result] || 0) + 1;
  return summary;
}, { pass: 0, fail: 0, timeout: 0, crash: 0, error: 0, unsupported: 0, "protocol-error": 0 });
const byRevision = {};
for (const record of cases) {
  const group = byRevision[record.requestedRevision] || {
    total: 0, pass: 0, fail: 0, timeout: 0, crash: 0, error: 0, unsupported: 0, "protocol-error": 0,
  };
  group.total += 1;
  group[record.result] += 1;
  byRevision[record.requestedRevision] = group;
}
const unexpectedAgainstDocumentation = cases.filter(
  (record) => record.unexpectedAgainstDocumentation === true,
);
const selectedRevisionMismatches = cases
  .filter((record) => record.result !== "unsupported"
    && record.selectedRevision
    && record.selectedRevision !== record.requestedRevision)
  .map((record) => ({
    path: record.path,
    requestedRevision: record.requestedRevision,
    selectedRevision: record.selectedRevision,
  }));
const bootVerification = bootPolicyVerification(options, cases);
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
const report = {
  harness: "sameboy-matrix",
  harnessVersion: 8,
  suite: "SameSuite",
  suiteCommit: gitCommit(options.root),
  romSource,
  romManifestSha256: sha256(Buffer.from(romManifest)),
  reference: {
    runner: options.runner,
    runnerSha256,
    sourceRoot: options.sourceRoot,
    sourceCommit: options.sourceRoot ? gitCommit(options.sourceRoot) : null,
    sourceVersion: sourceVersion(options.sourceRoot),
    sourceTree: options.sourceRoot ? repositorySnapshot(options.sourceRoot) : null,
  },
  policy: {
    model: "cgb",
    boot: options.boot,
    bootSha256: options.boot === "path"
      ? existsSync(options.bootPath) ? sha256(readFileSync(options.bootPath)) : null
      : options.boot === "dir"
        ? Object.fromEntries(["cgb0", "cgbA", "cgbB", "cgbC", "cgbD", "cgbE"].map((revision) => {
          const boot = bootForRevision(options, revision);
          return [revision, boot.path ? sha256(readFileSync(boot.path)) : null];
        }))
        : null,
    bootMapping: options.boot === "dir"
      ? "cgb0 uses cgb0_boot.bin; cgbA-D use cgb_boot.bin; cgbE uses cgbE_boot.bin when present or cgb_boot.bin as recorded fallback"
      : "single explicit image, directory policy, or no boot",
    cycleBudget: options.cycles,
    cycleUnit: "DMG base-clock T-cycles (4.194304 MHz equivalent)",
    passDetection: "SameSuite base.inc result byte ('P'/'F') plus Fibonacci registers at opcode 0x40; unknown combinations are protocol errors",
    wallClockMs: options.wallClockMs,
    documentation: "https://github.com/LIJI32/SameSuite/blob/master/apu/README.md",
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
  unexpectedAgainstDocumentation: unexpectedAgainstDocumentation.length,
  unexpectedCases: unexpectedAgainstDocumentation.map((record) => record.path),
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
