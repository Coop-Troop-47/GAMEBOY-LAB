import assert from "node:assert/strict";
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
      version: "v1.2.0",
      downloadUrl: "https://example.test/gbc-lab.html",
      notesUrl: "https://example.test/release",
      changes: ["Faster renderer", "", 42, "Clearer updates"],
    }),
  }));
  assert.deepEqual(update, {
    version: "1.2.0",
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
