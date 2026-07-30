import assert from "node:assert/strict";
import test from "node:test";

import {
  createFallbackArtwork,
  identifyRomTitle,
  readRomTitle,
  sortLibraryRecords,
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

test("identifies a readable game name from dump filenames, headers, and the known catalogue", () => {
  const gbc = new Uint8Array(0x200);
  gbc.set(new TextEncoder().encode("POKEMON CRY"), 0x134);
  gbc[0x143] = 0x80;
  assert.equal(
    identifyRomTitle({
      bytes: gbc,
      fileName: "Pokemon Crystal Version (USA, Europe) (Rev 1).gbc",
      knownTitles: ["Pokémon Crystal Version", "Pokémon Gold Version"],
    }),
    "Pokémon Crystal Version",
  );

  const dmg = new Uint8Array(0x200);
  dmg.set(new TextEncoder().encode("MYSTERY GAME"), 0x134);
  assert.equal(
    identifyRomTitle({
      bytes: dmg,
      fileName: "mystery_game_(world)_[!].gb",
    }),
    "Mystery Game",
  );

  const abbreviatedHeader = new Uint8Array(0x200);
  abbreviatedHeader.set(new TextEncoder().encode("METROID2"), 0x134);
  assert.equal(
    identifyRomTitle({
      bytes: abbreviatedHeader,
      fileName: "Metroid II - Return of Samus (World).gb",
      knownTitles: ["METROID2", "Metroid II: Return of Samus"],
    }),
    "Metroid II: Return of Samus",
  );

  assert.equal(
    identifyRomTitle({
      bytes: dmg,
      fileName: "Yoda Stories (USA, Europe) (GB Compatible).gb",
    }),
    "Yoda Stories",
  );
});

test("generates deterministic offline artwork for GB and GBC cartridges", () => {
  const gbArtwork = createFallbackArtwork("LOCAL TEST", "gb", "aabbcc");
  const gbcArtwork = createFallbackArtwork("LOCAL TEST", "gbc", "aabbcc");

  assert.match(gbArtwork, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.match(decodeURIComponent(gbArtwork), /GAMEBOY LAB ARCHIVE/);
  assert.match(decodeURIComponent(gbArtwork), /LOCAL TEST/);
  assert.notEqual(gbArtwork, gbcArtwork);
  assert.equal(gbArtwork, createFallbackArtwork("LOCAL TEST", "gb", "aabbcc"));
  assert.notEqual(
    createFallbackArtwork("LOCAL TEST", "gb", "000001"),
    createFallbackArtwork("LOCAL TEST", "gb", "000002"),
  );
  const longArtwork = decodeURIComponent(createFallbackArtwork(
    "The Legend of Zelda Oracle of Seasons",
    "gbc",
    "000007",
  ));
  assert.match(longArtwork, /<tspan[^>]*>The Legend of<\/tspan>/);
  assert.match(longArtwork, /<tspan[^>]*>Zelda Oracle of<\/tspan>/);
  assert.match(longArtwork, /<tspan[^>]*>Seasons<\/tspan>/);
});

test("sorts library records consistently and always pins the inserted cartridge", () => {
  const records = [
    { id: "small", title: "Zelda", romSize: 32, addedAt: 50, lastPlayedAt: 0 },
    { id: "active", title: "Metroid II", romSize: 64, addedAt: 10, lastPlayedAt: 20 },
    { id: "large", title: "Alleyway", romSize: 128, addedAt: 30, lastPlayedAt: 40 },
  ];

  assert.deepEqual(
    sortLibraryRecords(records, "alphabetic", "active").map((record) => record.id),
    ["active", "large", "small"],
  );
  assert.deepEqual(
    sortLibraryRecords(records, "recent", "active").map((record) => record.id),
    ["active", "small", "large"],
  );
  assert.deepEqual(
    sortLibraryRecords(records, "size", "active").map((record) => record.id),
    ["active", "large", "small"],
  );
  assert.deepEqual(
    sortLibraryRecords(records, "size").map((record) => record.id),
    ["large", "active", "small"],
  );
  assert.deepEqual(records.map((record) => record.id), ["small", "active", "large"]);
});
