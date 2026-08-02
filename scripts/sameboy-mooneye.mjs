/* global console, process */

/*
 * Run the Mooneye acceptance snapshot through a pinned SameBoy adapter.
 * Mooneye's filename policy is intentionally repeated here instead of
 * guessing a CGB model for an unknown suffix. Unsupported SGB/AGB cases are
 * recorded separately from failures and timeouts.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

const DEFAULT_CYCLES = 80_000_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
  return files.sort((left, right) => left.localeCompare(right));
}

function classify(path) {
  const name = basename(path, extname(path));
  if (/(?:^|[-_])(?:C|cgb(?:0|A|B|C|D|E|ABCDE)?)$/i.test(name)) return "cgb";
  if (/(?:^|[-_])(?:A|agb|ags)$/i.test(name)) return null;
  if (/(?:^|[-_])S(?:$|[-_])/i.test(name) || /sgb/i.test(name)) return null;
  if (/-dmg0$/i.test(name)) return "dmg0";
  if (/-mgb$/i.test(name)) return "mgb";
  return "dmg";
}

function parseArguments(argv) {
  const options = {
    biosDir: null,
    cycles: DEFAULT_CYCLES,
    reportPath: null,
    runner: null,
    suite: null,
    wallClockMs: 30_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--runner") options.runner = resolve(argv[++index]);
    else if (argument === "--suite") options.suite = resolve(argv[++index]);
    else if (argument === "--bios-dir") options.biosDir = resolve(argv[++index]);
    else if (argument === "--cycles") options.cycles = Number(argv[++index]);
    else if (argument === "--wall-clock-ms") options.wallClockMs = Number(argv[++index]);
    else if (argument === "--report") options.reportPath = resolve(argv[++index]);
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/sameboy-mooneye.mjs --runner PATH --suite DIR --bios-dir DIR [options]");
      process.exit(0);
    }
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.runner || !options.suite || !options.biosDir) {
    throw new Error("Provide --runner, --suite, and --bios-dir.");
  }
  return options;
}

function biosPath(directory, profile) {
  const names = {
    dmg: ["dmg_boot.bin", "gb_bios.bin"],
    dmg0: ["dmg0_boot.bin", "dmg0_rom.bin"],
    mgb: ["mgb_boot.bin"],
    cgb: ["cgb_boot.bin", "gbc_bios.bin"],
  }[profile];
  const selected = names.map((name) => join(directory, name)).find(existsSync);
  return selected || null;
}

function run(options, romPath, profile) {
  const boot = biosPath(options.biosDir, profile);
  if (!boot) return { result: "unsupported", error: `No ${profile} boot ROM was supplied.` };
  const model = profile === "mgb" ? "mgb" : profile === "cgb" ? "cgb" : "dmg";
  const child = spawnSync(options.runner, [
    "--model", model,
    "--boot", boot,
    "--base-cycles", String(options.cycles),
    romPath,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: options.wallClockMs });
  const lines = (child.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  let payload = null;
  if (lines.length) {
    try { payload = JSON.parse(lines.at(-1)); } catch { /* protocol error below */ }
  }
  const timedOut = child.error?.code === "ETIMEDOUT"
    || (child.status === null && child.signal === "SIGTERM");
  const result = timedOut ? "timeout"
    : payload?.result || (child.signal ? "crash" : payload ? "error" : "protocol-error");
  return {
    ...payload,
    result,
    bootPath: relative(options.biosDir, boot),
    bootSha256: sha256(readFileSync(boot)),
    processExit: child.status,
    signal: child.signal,
    error: child.error?.message || null,
  };
}

const options = parseArguments(process.argv.slice(2));
const cases = [];
const unsupportedCases = [];
for (const path of collect(options.suite)) {
  const profile = classify(path);
  const rom = readFileSync(path);
  if (!profile) {
    unsupportedCases.push({
      path: relative(options.suite, path),
      sha256: sha256(rom),
      reason: "Mooneye filename identifies an unsupported AGB/SGB target.",
    });
    continue;
  }
  cases.push({
    path: relative(options.suite, path),
    sha256: sha256(rom),
    profile,
    ...run(options, path, profile),
  });
}
const count = (status) => cases.filter((item) => item.result === status).length;
const report = {
  harness: "sameboy-mooneye-matrix",
  harnessVersion: 1,
  backend: "SameBoy",
  referenceVersion: "1.0.3",
  suite: "Mooneye acceptance",
  total: cases.length,
  unsupported: unsupportedCases.length,
  pass: count("pass"),
  fail: count("fail"),
  timeout: count("timeout"),
  crash: count("crash"),
  error: count("error") + count("protocol-error"),
  passRate: Number((count("pass") / Math.max(1, cases.length) * 100).toFixed(2)),
  policy: {
    cycleBudget: options.cycles,
    cycleUnit: "DMG base-clock T-cycles (4.194304 MHz equivalent)",
    passDetection: "opcode 0x40 plus exact Fibonacci registers",
    modelSelection: "Mooneye filename policy; SGB/AGB targets excluded",
  },
  unsupportedCases,
  cases,
};
if (options.reportPath) writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  backend: report.backend,
  total: report.total,
  unsupported: report.unsupported,
  pass: report.pass,
  fail: report.fail,
  timeout: report.timeout,
  crash: report.crash,
  error: report.error,
  passRate: report.passRate,
}, null, 2));
