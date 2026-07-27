import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const htmlUrl = new URL("../public/gbc-lab.html", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname !== "/gbc-lab.html") return new Response("Not found", { status: 404 });
          return new Response(await readFile(htmlUrl), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("serves the complete emulator as one self-contained HTML file", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>GB\/C Lab — Browser Game Boy Emulator<\/title>/i);
  assert.match(html, /GB\/C LAB/);
  assert.match(html, /LOAD ROM/);
  assert.match(html, /LOAD.{0,120}BIOS/);
  assert.match(html, /Optional local BIOS/i);
  assert.match(html, /LCD response/i);
  assert.match(html, /Screen only/i);
  assert.match(html, /Keyboard button motion/i);
  assert.match(html, /Audio volume/i);
  assert.doesNotMatch(html, /<script[^>]+\bsrc=/i);
  assert.doesNotMatch(html, /<link[^>]+\brel=["']stylesheet["']/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps every hardware input and new option accessible", async () => {
  const html = await readFile(htmlUrl, "utf8");
  for (const label of ["Up", "Down", "Left", "Right", "A", "B", "Start", "Select"]) {
    assert.match(html, new RegExp(`(?:sub)?label.{0,5}${label}`, "i"));
  }
  assert.match(html, /LCD ghosting strength/i);
  assert.match(html, /Audio volume/i);
  assert.match(html, /Choose a Game Boy ROM/i);
  assert.match(html, /Color theme/i);
  assert.match(html, /Presentation mode/i);
});
