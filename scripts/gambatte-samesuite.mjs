/* global console, process */

/*
 * Run SameSuite through the local Gambatte diagnostic adapter. Gambatte has a
 * generic CGB mode but no API for selecting CGB-0/A/B/C/D/E silicon, and its
 * public API does not expose the CPU register signature used by SameSuite.
 * Those cases are therefore recorded as diagnostic-only, never as a strict
 * accuracy score.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { classifySameSuiteRom } from "./samesuite-policy.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function collect(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (extname(entry).toLowerCase() === ".gb") files.push(path);
    }
  };
  walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

const argv = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const suiteRoot = resolve(readArg("--suite"));
const runner = resolve(readArg("--runner"));
const bootDir = resolve(readArg("--boot-dir"));
const reportPath = readArg("--report");
if (!suiteRoot || !runner || !bootDir) {
  throw new Error("Usage: node scripts/gambatte-samesuite.mjs --runner PATH --boot-dir DIR --suite DIR --report PATH");
}

const files = collect(suiteRoot).filter((path) => !relative(suiteRoot, path).toLowerCase().startsWith("sgb/"));
const cases = [];
for (const path of files) {
  const rom = readFileSync(path);
  const classification = classifySameSuiteRom(path, suiteRoot);
  const bootPath = join(bootDir, classification.revision === "cgb0" ? "cgb0_boot.bin" : "cgb_boot.bin");
  const comparable = classification.revision === "cgbE";
  const child = spawnSync(runner, [
    "--revision", classification.revision,
    "--boot", bootPath,
    "--base-cycles", "80000000",
    path,
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  const lines = (child.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  let diagnostic = null;
  if (lines.length) {
    try { diagnostic = JSON.parse(lines.at(-1)); } catch { /* recorded below */ }
  }
  const timedOut = child.error?.code === "ETIMEDOUT" || (child.status === null && child.signal === "SIGTERM");
  const diagnosticResult = timedOut ? "timeout" : diagnostic?.result || (child.signal ? "crash" : "error");
  cases.push({
    path: relative(suiteRoot, path),
    sha256: sha256(rom),
    bytes: rom.length,
    requestedRevision: classification.revision,
    classification: classification.source,
    bootPath,
    bootSha256: sha256(readFileSync(bootPath)),
    strictComparable: comparable,
    result: comparable && diagnosticResult === "pass" ? "diagnostic-pass"
      : comparable && diagnosticResult === "fail" ? "diagnostic-fail"
        : "unsupported",
    diagnosticResult,
    diagnostic,
    stderr: (child.stderr || "").trim().slice(-500),
  });
}

const count = (value) => cases.filter((record) => record.result === value).length;
const report = {
  harness: "gambatte-samesuite",
  harnessVersion: 1,
  suite: "SameSuite",
  backend: "Gambatte-libretro",
  strictComparable: false,
  reason: "Gambatte exposes generic CGB mode, not revision selection or SameSuite CPU-register callbacks. Results are diagnostic only.",
  policy: {
    model: "generic-cgb",
    boot: "revision-aware files supplied, generic CGB core",
    cycleBudget: 80_000_000,
    cycleUnit: "DMG base-clock T-cycles (frame-quantised adapter budget)",
    passDetection: "SameSuite CFFE P/F byte only; CPU-register marker cannot be verified through Gambatte's public API",
  },
  total: cases.length,
  diagnosticPass: count("diagnostic-pass"),
  diagnosticFail: count("diagnostic-fail"),
  unsupported: count("unsupported"),
  cases,
};
if (reportPath) writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  backend: report.backend,
  total: report.total,
  diagnosticPass: report.diagnosticPass,
  diagnosticFail: report.diagnosticFail,
  unsupported: report.unsupported,
  strictComparable: report.strictComparable,
}, null, 2));
