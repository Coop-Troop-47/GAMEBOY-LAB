import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the emulator shell and production metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>GB\/C Lab — Browser Game Boy Emulator<\/title>/i);
  assert.match(html, /GB\/C LAB/);
  assert.match(html, /LOAD ROM/);
  assert.match(html, /LOAD[\s\S]{0,80}DMG[\s\S]{0,80}BIOS/);
  assert.match(html, /Optional local BIOS/i);
  assert.match(html, /LCD response/i);
  assert.match(html, /DMG/);
  assert.match(html, /CGB/);
  assert.match(html, /Choose a legally obtained ROM/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("exposes accessible controls for every hardware input", async () => {
  const response = await render();
  const html = await response.text();
  for (const label of ["Up", "Down", "Left", "Right", "A", "B", "Start", "Select"]) {
    assert.match(html, new RegExp(`aria-label="${label}"`, "i"));
  }
  assert.match(html, /aria-label="LCD ghosting strength"/i);
  assert.match(html, /aria-label="Audio volume"/i);
  assert.match(html, /aria-label="Choose a Game Boy ROM"/i);
});
