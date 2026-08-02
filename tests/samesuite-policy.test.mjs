/* global Buffer, process */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  classifySameSuiteRom,
  documentedSameBoyExpectation,
} from "../scripts/samesuite-policy.mjs";

const root = "/tmp/samesuite";

test("SameSuite policy records explicit revision families", () => {
  assert.equal(classifySameSuiteRom(`${root}/apu/channel_3_extra-cgbB.gb`, root).revision, "cgbB");
  assert.deepEqual(
    classifySameSuiteRom(`${root}/apu/channel_1_freq_change_timing-cgb0BC.gb`, root).revisions,
    ["cgb0", "cgbB", "cgbC"],
  );
  assert.deepEqual(
    classifySameSuiteRom(`${root}/apu/channel_1_freq_change_timing-cgbDE.gb`, root).revisions,
    ["cgbD", "cgbE"],
  );
  assert.equal(classifySameSuiteRom(`${root}/apu/channel_1_freq_change_timing-A.gb`, root).revision, "cgbA");
  assert.equal(classifySameSuiteRom(`${root}/apu/channel_1_freq_change_timing-cgb0BC.gb`, root).revision, "cgbC");
  assert.equal(classifySameSuiteRom(`${root}/apu/channel_1_freq_change_timing-cgbDE.gb`, root).revision, "cgbE");
  assert.equal(classifySameSuiteRom(`${root}/apu/channel_3_extra-cgb0.gb`, root).revision, "cgb0");
});

test("revision matrix rejects a compact or truncated directory boot image", () => {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-boot-size-"));
  const suiteRoot = join(root, "apu");
  const bootRoot = join(root, "boot");
  mkdirSync(suiteRoot);
  mkdirSync(bootRoot);
  writeFileSync(join(suiteRoot, "smoke.gb"), Buffer.alloc(0x8000));
  writeFileSync(join(bootRoot, "cgb_boot.bin"), Buffer.alloc(0x800));
  const reportPath = join(root, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/samesuite-matrix.mjs",
      "--boot-dir", bootRoot,
      "--report", reportPath,
      "--quiet",
      root,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.unsupported, 1);
    assert.equal(report.bootPolicyVerified, false);
    assert.match(report.cases[0].bootSource, /invalid-size/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LAB matrix classifies its host safety stop as a timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-wall-clock-"));
  const suiteRoot = join(root, "apu");
  const bootRoot = join(root, "boot");
  mkdirSync(suiteRoot);
  mkdirSync(bootRoot);
  writeFileSync(join(suiteRoot, "smoke.gb"), Buffer.alloc(0x8000));
  writeFileSync(join(bootRoot, "cgb_boot.bin"), Buffer.alloc(0x900));
  const reportPath = join(root, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/samesuite-matrix.mjs",
      "--boot-dir", bootRoot,
      "--cycles", "80000000",
      "--wall-clock-ms", "1",
      "--report", reportPath,
      "--quiet",
      root,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.timeout, 1);
    assert.equal(report.cases[0].result, "timeout");
    assert.match(report.cases[0].timeoutReason, /host safety/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsuffixed ROMs use only the documented suite baseline", () => {
  const classification = classifySameSuiteRom(`${root}/ppu/blocking_bgpi_increase.gb`, root);
  assert.equal(classification.revision, "cgbE");
  assert.equal(classification.source, "documented-default:ppu");
});

test("unknown roots and suffixes fail closed", () => {
  assert.throws(
    () => classifySameSuiteRom(`${root}/misc/new_hardware_test-cgbF.gb`, root),
    /No SameSuite revision policy/,
  );
  assert.throws(
    () => classifySameSuiteRom(`${root}/apu/new_hardware_test-cgbF.gb`, root),
    /No SameSuite revision policy/,
  );
  assert.throws(
    () => classifySameSuiteRom(`${root}/apu/new_hardware_test-cgb0BC-extra.gb`, root),
    /No SameSuite revision policy/,
  );
});

test("SGB cases are explicitly excluded, never classified as CGB", () => {
  const classification = classifySameSuiteRom(`${root}/SGB/command.gb`, root);
  assert.equal(classification.excluded, true);
  assert.equal(classification.revision, undefined);
});

test("documentation annotations do not alter measured outcomes", () => {
  assert.equal(
    documentedSameBoyExpectation(`${root}/apu/channel_4_freq_change.gb`, root, "cgbE").status,
    "documented-exception",
  );
  assert.equal(
    documentedSameBoyExpectation(`${root}/apu/channel_1_stop_div.gb`, root, "cgbE").status,
    "pass",
  );
  assert.equal(
    documentedSameBoyExpectation(`${root}/dma/hdma_mode0.gb`, root, "cgbE").status,
    "not-specified",
  );
});

test("CLI refuses an implicit boot policy", () => {
  const result = spawnSync(process.execPath, ["scripts/samesuite-matrix.mjs", "/tmp"], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit boot policy/i);
});

test("unknown revision policy is recorded as an error, never measured as CGB-E", () => {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-policy-"));
  const suiteRoot = join(root, "apu");
  const bootRoot = join(root, "boot");
  mkdirSync(suiteRoot);
  mkdirSync(bootRoot);
  writeFileSync(join(suiteRoot, "new_case-cgbF.gb"), Buffer.alloc(0x8000));
  writeFileSync(join(bootRoot, "cgb_boot.bin"), Buffer.alloc(0x900));
  const reportPath = join(root, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/samesuite-matrix.mjs",
      "--boot-dir", bootRoot,
      "--report", reportPath,
      "--quiet",
      root,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.error, 1);
    assert.equal(report.cases[0].revision, null);
    assert.equal(report.cases[0].result, "error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SameBoy adapter exit status must agree with its JSON result", () => {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-reference-"));
  const suiteRoot = join(root, "apu");
  const bootRoot = join(root, "boot");
  const runner = join(root, "runner.sh");
  mkdirSync(suiteRoot);
  mkdirSync(bootRoot);
  writeFileSync(join(suiteRoot, "smoke.gb"), Buffer.alloc(0x8000));
  writeFileSync(join(bootRoot, "cgb_boot.bin"), Buffer.alloc(0x900));
  writeFileSync(runner, "#!/bin/sh\nprintf '%s\\n' '{\"result\":\"pass\",\"model\":\"cgb\",\"requestedRevision\":\"cgbE\",\"selectedRevision\":\"cgbE\"}'\nexit 9\n");
  chmodSync(runner, 0o755);
  const reportPath = join(root, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/sameboy-matrix.mjs",
      "--runner", runner,
      "--boot-dir", bootRoot,
      "--report", reportPath,
      "--quiet",
      root,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.error, 1);
    assert.equal(report.cases[0].result, "error");
    assert.match(report.cases[0].error, /expected 0/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SameBoy matrix refuses a single unverified boot image as a revision score", () => {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-single-boot-"));
  const suiteRoot = join(root, "apu");
  const boot = join(root, "cgb_boot.bin");
  const runner = join(root, "runner.sh");
  mkdirSync(suiteRoot);
  writeFileSync(join(suiteRoot, "smoke.gb"), Buffer.alloc(0x8000));
  writeFileSync(boot, Buffer.from([0]));
  writeFileSync(runner, "#!/bin/sh\nprintf '%s\\n' '{\"result\":\"pass\",\"model\":\"cgb\",\"requestedRevision\":\"cgbE\",\"selectedRevision\":\"cgbE\"}'\nexit 0\n");
  chmodSync(runner, 0o755);
  const reportPath = join(root, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/sameboy-matrix.mjs",
      "--runner", runner,
      "--boot", "path",
      "--boot-path", boot,
      "--report", reportPath,
      "--quiet",
      root,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.cases[0].result, "unsupported");
    assert.equal(report.bootPolicyVerified, false);
    assert.match(report.bootPolicyReason, /--boot-dir/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SameBoy matrix refuses an invalid explicit boot image instead of running post-boot", () => {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-invalid-explicit-boot-"));
  const suiteRoot = join(root, "apu");
  const boot = join(root, "cgb_boot.bin");
  const runner = join(root, "runner.sh");
  mkdirSync(suiteRoot);
  writeFileSync(join(suiteRoot, "smoke.gb"), Buffer.alloc(0x8000));
  writeFileSync(boot, Buffer.alloc(0x800));
  writeFileSync(runner, "#!/bin/sh\nprintf '%s\\n' '{\"result\":\"pass\",\"model\":\"cgb\",\"requestedRevision\":\"cgbE\",\"selectedRevision\":\"cgbE\"}'\nexit 0\n");
  chmodSync(runner, 0o755);
  const reportPath = join(root, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/sameboy-matrix.mjs",
      "--runner", runner,
      "--boot", "path",
      "--boot-path", boot,
      "--report", reportPath,
      "--quiet",
      root,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.unsupported, 1);
    assert.equal(report.cases[0].result, "unsupported");
    assert.match(report.cases[0].error, /invalid-size/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SameBoy matrix requires the adapter to prove its selected model and revision", () => {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-identity-"));
  const suiteRoot = join(root, "apu");
  const bootRoot = join(root, "boot");
  const runner = join(root, "runner.sh");
  mkdirSync(suiteRoot);
  mkdirSync(bootRoot);
  writeFileSync(join(suiteRoot, "smoke.gb"), Buffer.alloc(0x8000));
  writeFileSync(join(bootRoot, "cgb_boot.bin"), Buffer.alloc(0x900));
  writeFileSync(runner, "#!/bin/sh\nprintf '%s\\n' '{\"result\":\"pass\"}'\nexit 0\n");
  chmodSync(runner, 0o755);
  const reportPath = join(root, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/sameboy-matrix.mjs",
      "--runner", runner,
      "--boot-dir", bootRoot,
      "--report", reportPath,
      "--quiet",
      root,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.error, 1);
    assert.equal(report.cases[0].result, "error");
    assert.match(report.cases[0].error, /selected model and revision/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SameBoy matrix rejects an adapter that was asked for a different revision", () => {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-requested-revision-"));
  const suiteRoot = join(root, "apu");
  const bootRoot = join(root, "boot");
  const runner = join(root, "runner.sh");
  mkdirSync(suiteRoot);
  mkdirSync(bootRoot);
  writeFileSync(join(suiteRoot, "smoke.gb"), Buffer.alloc(0x8000));
  writeFileSync(join(bootRoot, "cgb_boot.bin"), Buffer.alloc(0x900));
  writeFileSync(runner, "#!/bin/sh\nprintf '%s\\n' '{\"result\":\"pass\",\"model\":\"cgb\",\"requestedRevision\":\"cgbA\",\"selectedRevision\":\"cgbE\"}'\nexit 0\n");
  chmodSync(runner, 0o755);
  const reportPath = join(root, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/sameboy-matrix.mjs",
      "--runner", runner,
      "--boot-dir", bootRoot,
      "--report", reportPath,
      "--quiet",
      root,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.error, 1);
    assert.match(report.cases[0].error, /requested cgbA/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SameBoy wall-clock termination is classified as a timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-timeout-"));
  const suiteRoot = join(root, "apu");
  const bootRoot = join(root, "boot");
  const runner = join(root, "runner.sh");
  mkdirSync(suiteRoot);
  mkdirSync(bootRoot);
  writeFileSync(join(suiteRoot, "smoke.gb"), Buffer.alloc(0x8000));
  writeFileSync(join(bootRoot, "cgb_boot.bin"), Buffer.alloc(0x900));
  writeFileSync(runner, "#!/bin/sh\nsleep 1\n");
  chmodSync(runner, 0o755);
  const reportPath = join(root, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/sameboy-matrix.mjs",
      "--runner", runner,
      "--boot-dir", bootRoot,
      "--wall-clock-ms", "20",
      "--report", reportPath,
      "--quiet",
      root,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.timeout, 1);
    assert.equal(report.cases[0].result, "timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
