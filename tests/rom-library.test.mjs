import assert from "node:assert/strict";
import test from "node:test";

import {
  createFallbackArtwork,
  readRomTitle,
} from "../app/lib/romLibrary.js";

test("reads cartridge titles without leaking binary header fields", () => {
  const dmg = new Uint8Array(0x150);
  dmg.set(new TextEncoder().encode("SUPER MARIO LAND"), 0x134);
  assert.equal(readRomTitle(dmg), "SUPER MARIO LAND");

  const gbc = new Uint8Array(0x150);
  gbc.set(new TextEncoder().encode("POKEMON CRYS"), 0x134);
  gbc[0x143] = 0xc0;
  assert.equal(readRomTitle(gbc), "POKEMON CRY");
});

test("generates deterministic offline artwork for GB and GBC cartridges", () => {
  const gbArtwork = createFallbackArtwork("LOCAL TEST", "gb", "aabbcc");
  const gbcArtwork = createFallbackArtwork("LOCAL TEST", "gbc", "aabbcc");

  assert.match(gbArtwork, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.match(decodeURIComponent(gbArtwork), /GAMEBOY LAB ARCHIVE/);
  assert.match(decodeURIComponent(gbArtwork), /LOCAL TEST/);
  assert.notEqual(gbArtwork, gbcArtwork);
  assert.equal(gbArtwork, createFallbackArtwork("LOCAL TEST", "gb", "aabbcc"));
});
