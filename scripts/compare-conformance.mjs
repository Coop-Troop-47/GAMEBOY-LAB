/* global console, process */

// Validate the inputs before comparing a GAMEBOY LAB matrix with a reference
// matrix. This is deliberately a separate gate: a pass-rate subtraction is
// meaningless if the ROM set, revision, BIOS, or timeout policy differs.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_HARNESS_VERSION = 8;
const VALID_RESULTS = new Set([
  "pass", "fail", "timeout", "crash", "error", "unsupported", "protocol-error",
]);
const VALID_REVISIONS = new Set(["cgb0", "cgbA", "cgbB", "cgbC", "cgbD", "cgbE"]);

function parseArguments(argv) {
  const options = { lab: null, reference: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/compare-conformance.mjs --lab-report PATH --reference-report PATH [--report PATH]");
      process.exit(0);
    }
    if (argument === "--lab-report") options.lab = resolve(argv[++index]);
    else if (argument === "--reference-report") options.reference = resolve(argv[++index]);
    else if (argument === "--report") options.report = resolve(argv[++index]);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.lab || !options.reference) {
    throw new Error("Provide --lab-report and --reference-report.");
  }
  return options;
}

function readReport(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isIntegerLike(value) {
  return Number.isInteger(value)
    || (typeof value === "string" && /^[0-9]+$/.test(value));
}

function validateReport(report, side) {
  const errors = [];
  const prefix = `${side} report`;
  const isLab = side.toLowerCase() === "lab";
  if (!report || typeof report !== "object") return [`${prefix} is not an object.`];
  if (report.harnessVersion < REQUIRED_HARNESS_VERSION) {
    errors.push(`${prefix} must use harness version ${REQUIRED_HARNESS_VERSION} or newer.`);
  }
  if (report.suite !== "SameSuite") errors.push(`${prefix} does not identify SameSuite.`);
  if (typeof report.suiteCommit !== "string" || !/^[0-9a-f]{7,64}$/i.test(report.suiteCommit)) {
    errors.push(`${prefix} has no pinned SameSuite commit.`);
  }
  const romSource = report.romSource;
  if (!romSource || typeof romSource !== "object") {
    errors.push(`${prefix} has no ROM source snapshot.`);
  } else {
    if (romSource.commit !== report.suiteCommit) {
      errors.push(`${prefix} ROM source commit does not match suiteCommit.`);
    }
    if (romSource.manifestPinsAllBytes !== true) {
      errors.push(`${prefix} ROM source snapshot does not pin every ROM byte.`);
    }
    if (romSource.verified !== true) {
      errors.push(`${prefix} ROM source snapshot is not verified.`);
    }
    for (const key of ["totalRomFiles", "trackedRomCount", "untrackedRomCount", "ignoredRomCount"]) {
      if (!Number.isInteger(romSource[key]) || romSource[key] < 0) {
        errors.push(`${prefix} ROM source snapshot has invalid ${key}.`);
      }
    }
    if (Number.isInteger(romSource.totalRomFiles)
      && Number.isInteger(report.total)
      && Number.isInteger(report.excluded)
      && romSource.totalRomFiles !== report.total + report.excluded) {
      errors.push(`${prefix} ROM source snapshot does not cover every tested/excluded ROM.`);
    }
    if (Number.isInteger(romSource.totalRomFiles)
      && Number.isInteger(romSource.trackedRomCount)
      && Number.isInteger(romSource.untrackedRomCount)
      && Number.isInteger(romSource.ignoredRomCount)
      && romSource.trackedRomCount + romSource.untrackedRomCount + romSource.ignoredRomCount
        !== romSource.totalRomFiles) {
      errors.push(`${prefix} ROM source snapshot counts do not add up.`);
    }
  }
  if (!Array.isArray(report.cases)) errors.push(`${prefix} has no cases array.`);
  if (!isSha256(report.romManifestSha256)) errors.push(`${prefix} has no valid ROM manifest hash.`);
  const policy = report.policy;
  if (!policy || typeof policy !== "object") {
    errors.push(`${prefix} has no policy object.`);
  } else {
    for (const key of ["model", "boot", "bootSha256", "cycleBudget", "cycleUnit", "passDetection", "wallClockMs"]) {
      if (!Object.hasOwn(policy, key)) errors.push(`${prefix} is missing policy.${key}.`);
    }
    if (policy.model !== "cgb") errors.push(`${prefix} policy model is not cgb.`);
    if (!isIntegerLike(policy.cycleBudget) || Number(policy.cycleBudget) < 1) {
      errors.push(`${prefix} has an invalid cycle budget.`);
    }
    if (!isIntegerLike(policy.wallClockMs) || Number(policy.wallClockMs) < 1) {
      errors.push(`${prefix} has an invalid wall-clock budget.`);
    }
    if (!Object.hasOwn(policy, "bootMapping")) errors.push(`${prefix} is missing policy.bootMapping.`);
    if (!["dir", "path", "none"].includes(policy.boot)) {
      errors.push(`${prefix} has an invalid boot policy.`);
    }
    if (policy.bootSha256 !== null && (typeof policy.bootSha256 !== "object" || Array.isArray(policy.bootSha256))) {
      errors.push(`${prefix} has an invalid policy.bootSha256 map.`);
    } else if (policy.bootSha256 && policy.boot === "dir") {
      for (const revision of VALID_REVISIONS) {
        if (!isSha256(policy.bootSha256[revision])) {
          errors.push(`${prefix} policy.bootSha256.${revision} is missing or invalid.`);
        }
      }
    } else if (policy.bootSha256 && policy.boot !== "dir") {
      const values = Object.values(policy.bootSha256);
      if (!values.length || values.some((value) => !isSha256(value))) {
        errors.push(`${prefix} has invalid single-image boot hashes.`);
      }
    }
  }
  if (!isLab) {
    if (!report.reference || typeof report.reference !== "object") {
      errors.push(`${prefix} has no pinned reference identity.`);
    } else {
      if (typeof report.reference.sourceCommit !== "string"
        || !/^[0-9a-f]{7,64}$/i.test(report.reference.sourceCommit)) {
        errors.push(`${prefix} has no pinned reference source commit.`);
      }
      if (!isSha256(report.reference.runnerSha256)) {
        errors.push(`${prefix} has no pinned reference runner hash.`);
      }
      const sourceTree = report.reference.sourceTree;
      if (!sourceTree || typeof sourceTree !== "object") {
        errors.push(`${prefix} has no reference source-tree snapshot.`);
      } else {
        if (sourceTree.commit !== report.reference.sourceCommit) {
          errors.push(`${prefix} reference source-tree commit does not match sourceCommit.`);
        }
        if (sourceTree.verified !== true) {
          errors.push(`${prefix} reference source tree is not clean and verified.`);
        }
        if (!Array.isArray(sourceTree.dirtyPaths) || sourceTree.dirtyPaths.length) {
          errors.push(`${prefix} reference source tree has dirty-path evidence.`);
        }
      }
    }
  } else {
    const coreSource = report.coreSource;
    if (!coreSource || typeof coreSource !== "object") {
      errors.push(`${prefix} has no content-addressed GAMEBOY LAB core source.`);
    } else {
      if (typeof coreSource.commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(coreSource.commit)) {
        errors.push(`${prefix} has no pinned GAMEBOY LAB core commit.`);
      }
      if (!isSha256(coreSource.manifestSha256)) {
        errors.push(`${prefix} has no valid GAMEBOY LAB core source manifest.`);
      }
      if (coreSource.verified !== true) {
        errors.push(`${prefix} GAMEBOY LAB core source is not content-addressed.`);
      }
      if (!Array.isArray(coreSource.files) || !coreSource.files.length) {
        errors.push(`${prefix} has no GAMEBOY LAB core source file hashes.`);
      } else {
        const paths = new Set();
        for (const file of coreSource.files) {
          if (!file || typeof file.path !== "string" || !isSha256(file.sha256)) {
            errors.push(`${prefix} has an invalid GAMEBOY LAB core source file hash.`);
          } else if (paths.has(file.path)) {
            errors.push(`${prefix} contains duplicate GAMEBOY LAB core source file hashes.`);
          } else {
            paths.add(file.path);
          }
        }
      }
    }
  }
  if (!Array.isArray(report.cases)) return errors;
  if (!Number.isInteger(report.total) || report.total !== report.cases.length) {
    errors.push(`${prefix} total does not match its cases.`);
  }
  const counts = Object.fromEntries([...VALID_RESULTS].map((status) => [status, 0]));
  const paths = new Set();
  for (const record of report.cases) {
    if (!record || typeof record !== "object") {
      errors.push(`${prefix} contains a non-object case.`);
      continue;
    }
    if (typeof record.path !== "string" || !record.path) errors.push(`${prefix} contains a case without a path.`);
    if (paths.has(record.path)) errors.push(`${prefix} contains duplicate case ${record.path}.`);
    paths.add(record.path);
    if (!isSha256(record.sha256)) errors.push(`${prefix} case ${record.path} has no valid ROM hash.`);
    if (!Number.isInteger(record.bytes) || record.bytes < 1) errors.push(`${prefix} case ${record.path} has invalid ROM size.`);
    if (record.model !== "cgb") errors.push(`${prefix} case ${record.path} is not tagged cgb.`);
    if (!VALID_RESULTS.has(record.result)) {
      errors.push(`${prefix} case ${record.path} has invalid result ${String(record.result)}.`);
    } else counts[record.result] += 1;
    if (!Object.hasOwn(record, "baseCycles") || !isIntegerLike(record.baseCycles)) {
      errors.push(`${prefix} case ${record.path} has no normalized base-cycle count.`);
    }
    if (!Object.hasOwn(record, "bootSource")) errors.push(`${prefix} case ${record.path} has no boot source.`);
    if (!Object.hasOwn(record, "bootSha256")) errors.push(`${prefix} case ${record.path} has no boot hash field.`);
    if (!Object.hasOwn(record, "bootSize")) errors.push(`${prefix} case ${record.path} has no boot size field.`);
    if (record.bootSha256 !== null && !isSha256(record.bootSha256)) {
      errors.push(`${prefix} case ${record.path} has an invalid boot hash.`);
    }
    if (record.bootSha256 !== null && (!Number.isInteger(record.bootSize) || record.bootSize !== 0x900)) {
      errors.push(`${prefix} case ${record.path} has a boot hash without a 0x900-byte boot image.`);
    }
    const revision = isLab ? record.revision : record.requestedRevision;
    if (!VALID_REVISIONS.has(revision)) errors.push(`${prefix} case ${record.path} has no valid requested revision.`);
    if (!Array.isArray(record.revisionCandidates)
      || !record.revisionCandidates.length
      || record.revisionCandidates.some((candidate) => !VALID_REVISIONS.has(candidate))
      || !record.revisionCandidates.includes(revision)) {
      errors.push(`${prefix} case ${record.path} has invalid revision-family evidence.`);
    }
    if (!Object.hasOwn(record, "selectedRevision")) errors.push(`${prefix} case ${record.path} has no selected revision field.`);
    if (["pass", "fail"].includes(record.result) && record.selectedRevision !== revision) {
      errors.push(`${prefix} case ${record.path} does not prove the selected revision.`);
    }
  }
  for (const status of VALID_RESULTS) {
    if (report[status] !== counts[status]) {
      errors.push(`${prefix} ${status} count does not match its cases.`);
    }
  }
  const measured = report.cases.length - counts.unsupported;
  if (report.measured !== measured) errors.push(`${prefix} measured count does not match its cases.`);
  if (report.passRate !== Number((counts.pass / (measured || 1) * 100).toFixed(2))) {
    errors.push(`${prefix} pass rate does not match its cases.`);
  }
  return errors;
}

function caseIdentity(record, side) {
  return {
    path: record.path,
    sha256: record.sha256,
    bytes: record.bytes,
    model: record.model,
    revision: side === "lab" ? record.revision : record.requestedRevision,
    revisionCandidates: record.revisionCandidates,
    selectedRevision: record.selectedRevision,
    classification: record.classification,
    bootSource: record.bootSource,
    bootSha256: record.bootSha256,
    bootSize: record.bootSize,
  };
}

function indexCases(report) {
  const index = new Map();
  for (const record of report.cases || []) {
    if (index.has(record.path)) throw new Error(`Duplicate case path in ${report.harness || "report"}: ${record.path}`);
    index.set(record.path, record);
  }
  return index;
}

function compareReports(lab, reference) {
  const reasons = [];
  const validationErrors = [
    ...validateReport(lab, "LAB"),
    ...validateReport(reference, "reference"),
  ];
  if (validationErrors.length) {
    return {
      comparable: false,
      reasons: validationErrors,
      manifest: lab?.romManifestSha256 ?? null,
      totals: {
        lab: { pass: lab?.pass ?? null, fail: lab?.fail ?? null, measured: lab?.measured ?? null },
        reference: { pass: reference?.pass ?? null, fail: reference?.fail ?? null, measured: reference?.measured ?? null },
      },
      identityMismatches: [],
      invalidStatuses: [],
    };
  }
  if (lab.suite !== "SameSuite" || reference.suite !== "SameSuite") {
    reasons.push("Both reports must identify the SameSuite suite.");
  }
  if (lab.suiteCommit !== reference.suiteCommit) {
    reasons.push("SameSuite source commits differ.");
  }
  if (!same(lab.romSource, reference.romSource)) {
    reasons.push("ROM source snapshots differ.");
  }
  if (lab.harnessVersion < REQUIRED_HARNESS_VERSION || reference.harnessVersion < REQUIRED_HARNESS_VERSION) {
    reasons.push(`Both reports must use harness version ${REQUIRED_HARNESS_VERSION} or newer.`);
  }
  if (!lab.bootPolicyVerified || !reference.bootPolicyVerified) {
    reasons.push("Both reports must prove their revision-aware boot mapping.");
  }
  if (!same(lab.romManifestSha256, reference.romManifestSha256)) {
    reasons.push("ROM manifest hashes differ.");
  }
  const sharedPolicy = ["model", "boot", "bootSha256", "bootMapping", "cycleBudget", "cycleUnit", "wallClockMs", "passDetection"];
  for (const key of sharedPolicy) {
    if (!same(lab.policy?.[key], reference.policy?.[key])) {
      reasons.push(`Policy field differs: ${key}.`);
    }
  }
  if (!same(lab.policy?.excluded, reference.policy?.excluded)
    || !same(lab.excludedCases, reference.excludedCases)) {
    reasons.push("Excluded ROM policy differs.");
  }
  const labCases = indexCases(lab);
  const referenceCases = indexCases(reference);
  if (labCases.size !== referenceCases.size) reasons.push("Case counts differ.");
  const identityMismatches = [];
  for (const [path, labCase] of labCases) {
    const referenceCase = referenceCases.get(path);
    if (!referenceCase) {
      identityMismatches.push({ path, reason: "missing from reference" });
      continue;
    }
    const left = caseIdentity(labCase, "lab");
    const right = caseIdentity(referenceCase, "reference");
    if (!same(left, right)) identityMismatches.push({ path, lab: left, reference: right });
  }
  for (const path of referenceCases.keys()) {
    if (!labCases.has(path)) identityMismatches.push({ path, reason: "missing from LAB" });
  }
  if (identityMismatches.length) reasons.push(`${identityMismatches.length} case identity mismatch(es).`);
  const invalidStatuses = (report, side) => (report.cases || [])
    .filter((record) => !["pass", "fail"].includes(record.result))
    .map((record) => `${side}:${record.path}:${record.result}`);
  const invalid = [...invalidStatuses(lab, "lab"), ...invalidStatuses(reference, "reference")];
  if (invalid.length) reasons.push("A measured report contains a timeout, crash, error, unsupported, or protocol-error status.");
  return {
    comparable: reasons.length === 0,
    reasons,
    manifest: lab.romManifestSha256,
    totals: {
      lab: { pass: lab.pass, fail: lab.fail, measured: lab.measured },
      reference: { pass: reference.pass, fail: reference.fail, measured: reference.measured },
    },
    identityMismatches,
    invalidStatuses: invalid,
  };
}

const options = parseArguments(process.argv.slice(2));
const lab = readReport(options.lab);
const reference = readReport(options.reference);
const comparison = compareReports(lab, reference);
const output = {
  harness: "compare-conformance",
  harnessVersion: 1,
  labReport: options.lab,
  referenceReport: options.reference,
  ...comparison,
};
if (options.report) writeFileSync(options.report, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (!comparison.comparable) process.exitCode = 1;
