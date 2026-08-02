/* global process */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

function report(overrides = {}) {
  return {
    harnessVersion: 8,
    suite: "SameSuite",
    suiteCommit: "abcdef1234567890abcdef1234567890abcdef12",
    coreSource: {
      commit: "abcdef1234567890abcdef1234567890abcdef12",
      manifestSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      verified: true,
      files: [
        { path: "app/lib/gameboy.js", sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      ],
    },
    romSource: {
      commit: "abcdef1234567890abcdef1234567890abcdef12",
      totalRomFiles: 1,
      trackedRomCount: 1,
      untrackedRomCount: 0,
      ignoredRomCount: 0,
      manifestPinsAllBytes: true,
      verified: true,
    },
    bootPolicyVerified: true,
    romManifestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    total: 1,
    measured: 1,
    pass: 1,
    fail: 0,
    timeout: 0,
    crash: 0,
    error: 0,
    unsupported: 0,
    "protocol-error": 0,
    excluded: 0,
    passRate: 100,
    excludedCases: [],
    policy: {
      model: "cgb",
      boot: "dir",
      bootSha256: {
        cgb0: "1111111111111111111111111111111111111111111111111111111111111111",
        cgbA: "2222222222222222222222222222222222222222222222222222222222222222",
        cgbB: "3333333333333333333333333333333333333333333333333333333333333333",
        cgbC: "4444444444444444444444444444444444444444444444444444444444444444",
        cgbD: "5555555555555555555555555555555555555555555555555555555555555555",
        cgbE: "6666666666666666666666666666666666666666666666666666666666666666",
      },
      bootMapping: "controlled",
      cycleBudget: 80_000_000,
      cycleUnit: "DMG base-clock T-cycles (4.194304 MHz equivalent)",
      wallClockMs: 30_000,
      passDetection: "strict",
      excluded: { count: 0, reason: "none" },
    },
    cases: [{
      path: "apu/smoke.gb",
      sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      bytes: 0x8000,
      model: "cgb",
      revision: "cgbE",
      requestedRevision: "cgbE",
      revisionCandidates: ["cgbE"],
      selectedRevision: "cgbE",
      bootSource: "standard:cgbE->cgb",
      bootSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      bootSize: 0x900,
      baseCycles: 100,
      result: "pass",
    }],
    reference: {
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      runnerSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      sourceTree: {
        commit: "1234567890abcdef1234567890abcdef12345678",
        verified: true,
        dirtyPaths: [],
      },
    },
    ...overrides,
  };
}

function runCompare(left, right) {
  const root = mkdtempSync(join(tmpdir(), "gameboy-lab-compare-"));
  const labPath = join(root, "lab.json");
  const referencePath = join(root, "reference.json");
  const reportPath = join(root, "comparison.json");
  writeFileSync(labPath, JSON.stringify(left));
  writeFileSync(referencePath, JSON.stringify(right));
  const result = spawnSync(process.execPath, [
    "scripts/compare-conformance.mjs",
    "--lab-report", labPath,
    "--reference-report", referencePath,
    "--report", reportPath,
  ], { encoding: "utf8" });
  const output = JSON.parse(readFileSync(reportPath, "utf8"));
  rmSync(root, { recursive: true, force: true });
  return { result, output };
}

test("conformance comparator accepts identical controlled inputs", () => {
  const { result, output } = runCompare(report(), report());
  assert.equal(result.status, 0);
  assert.equal(output.comparable, true);
  assert.deepEqual(output.identityMismatches, []);
});

test("conformance comparator rejects a changed boot hash", () => {
  const { result, output } = runCompare(
    report(),
    report({
      policy: {
        ...report().policy,
        bootSha256: { cgb0: "wrong", cgbE: "bootE" },
      },
    }),
  );
  assert.notEqual(result.status, 0);
  assert.equal(output.comparable, false);
  assert.match(output.reasons.join(" "), /bootSha256/);
});

test("conformance comparator rejects an unverified ROM source snapshot", () => {
  const malformed = report({
    romSource: {
      ...report().romSource,
      verified: false,
    },
  });
  const { result, output } = runCompare(malformed, report());
  assert.notEqual(result.status, 0);
  assert.equal(output.comparable, false);
  assert.match(output.reasons.join(" "), /ROM source snapshot is not verified/i);
});

test("conformance comparator rejects a dirty reference source tree", () => {
  const malformed = report({
    reference: {
      ...report().reference,
      sourceTree: {
        ...report().reference.sourceTree,
        verified: false,
        dirtyPaths: ["Core/apu.c"],
      },
    },
  });
  const { result, output } = runCompare(report(), malformed);
  assert.notEqual(result.status, 0);
  assert.equal(output.comparable, false);
  assert.match(output.reasons.join(" "), /reference source tree is not clean/i);
});

test("conformance comparator rejects an unpinned LAB core source", () => {
  const malformed = report({ coreSource: null });
  const { result, output } = runCompare(malformed, report());
  assert.notEqual(result.status, 0);
  assert.equal(output.comparable, false);
  assert.match(output.reasons.join(" "), /core source/i);
});

test("conformance comparator rejects incomplete case identity instead of comparing undefined fields", () => {
  const malformed = report({
    cases: [{ ...report().cases[0], bootSize: undefined }],
  });
  const { result, output } = runCompare(malformed, report());
  assert.notEqual(result.status, 0);
  assert.equal(output.comparable, false);
  assert.match(output.reasons.join(" "), /boot hash without|boot size field/i);
});
