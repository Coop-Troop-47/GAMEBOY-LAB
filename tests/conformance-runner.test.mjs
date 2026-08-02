/* global Buffer, process */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("generic conformance runner rejects a boot image for the wrong model", () => {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-conformance-"));
  const suite = join(root, "suite");
  const boot = join(root, "cgb_boot.bin");
  const reportPath = join(root, "report.json");
  mkdirSync(suite);
  writeFileSync(join(suite, "smoke.gb"), Buffer.alloc(0x8000));
  writeFileSync(boot, Buffer.alloc(0x900));
  try {
    const result = spawnSync(process.execPath, [
      "scripts/core-conformance.mjs",
      "--suite", "mooneye",
      "--model", "dmg",
      "--boot-path", boot,
      "--limit", "1",
      "--report", reportPath,
      "--quiet",
      suite,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.total, 0);
    assert.equal(report.unsupported, 1);
    assert.match(report.unsupportedCases[0].reason, /requires 256 bytes/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SameBoy marker inspection cannot mutate the emulated data bus", () => {
  const source = readFileSync("scripts/reference/sameboy-conformance-runner.c", "utf8");
  const execute = source.match(/static void execute\([\s\S]*?\n}\n\nstatic GB_model_t parse_model/);
  assert.ok(execute, "marker callback should remain a named, reviewable block");
  assert.match(execute[0], /gb->ram\[0x0FFE\]/);
  assert.doesNotMatch(execute[0], /GB_read_memory\s*\(/);
});
