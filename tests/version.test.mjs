import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APP_VERSION,
  compareVersions,
  findAvailableUpdate,
} from "../app/version.js";

test("semantic versions compare numerically", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("v1.0.0", "1.0"), 0);
  assert.equal(compareVersions("0.9.9", "1.0.0"), -1);
});

test("release discovery returns only a newer standalone asset", async () => {
  const update = await findAvailableUpdate(async () => ({
    ok: true,
    json: async () => ({
      version: "v2.0.1",
      downloadUrl: "https://example.test/gbc-lab.html",
      notesUrl: "https://example.test/release",
      changes: ["Faster renderer", "", 42, "Clearer updates"],
    }),
  }));
  assert.deepEqual(update, {
    version: "2.0.1",
    downloadUrl: "https://example.test/gbc-lab.html",
    notesUrl: "https://example.test/release",
    changes: ["Faster renderer", "Clearer updates"],
  });

  const current = await findAvailableUpdate(async () => ({
    ok: true,
    json: async () => ({
      version: `v${APP_VERSION}`,
      downloadUrl: "https://example.test/gbc-lab.html",
    }),
  }));
  assert.equal(current, null);
});

test("release manifest matches the embedded application version and asset", () => {
  const manifest = JSON.parse(readFileSync(
    new URL("../release/update-manifest.json", import.meta.url),
    "utf8",
  ));
  assert.equal(manifest.version, APP_VERSION);
  assert.match(
    manifest.downloadUrl,
    new RegExp(`/v${APP_VERSION.replaceAll(".", "\\.")}/gbc-lab\\.html$`),
  );
  assert.match(
    manifest.notesUrl,
    new RegExp(`/tag/v${APP_VERSION.replaceAll(".", "\\.")}$`),
  );
  assert.ok(manifest.changes.length > 0 && manifest.changes.length <= 6);
});
