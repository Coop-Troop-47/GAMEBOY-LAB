import assert from "node:assert/strict";
import test from "node:test";
import {
  createSaveArchive,
  parseSaveArchive,
  replaceSaveArchive,
} from "../app/lib/saveArchive.js";

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("backs up every battery save and save state without bundling preferences", () => {
  const storage = new MemoryStorage([
    ["gbc-lab-preferences", "{\"theme\":\"dark\"}"],
    ["gbc-lab-save:32768:deadbeef", JSON.stringify({
      version: 2,
      ram: "AA==",
      rtc: { seconds: 12 },
    })],
    ["gbc-lab-state:32768:deadbeef:0", JSON.stringify({
      version: 1,
      romKey: "32768:deadbeef",
      title: "TEST",
      model: "dmg",
      savedAt: 1234,
      state: { title: "TEST" },
    })],
  ]);
  const { archive, summary } = createSaveArchive(
    storage,
    new Map([["32768:deadbeef", "Test Game"]]),
  );

  assert.equal(summary.games, 1);
  assert.equal(summary.batterySaves, 1);
  assert.equal(summary.saveStates, 1);
  assert.equal(summary.records, 2);
  assert.equal(archive.entries.every((entry) => entry.title === "Test Game"), true);
  assert.equal(JSON.stringify(archive).includes("gbc-lab-preferences"), false);
});

test("validates and transactionally replaces save records while preserving app settings", () => {
  const source = new MemoryStorage([
    ["gbc-lab-save:65536:cafebabe", "AQID"],
    ["gbc-lab-state:65536:cafebabe:2", JSON.stringify({
      version: 1,
      romKey: "65536:cafebabe",
      title: "RESTORED",
      model: "cgb",
      savedAt: 5678,
      state: { title: "RESTORED" },
    })],
  ]);
  const parsed = parseSaveArchive(JSON.stringify(createSaveArchive(source).archive));
  const target = new MemoryStorage([
    ["gbc-lab-preferences", "{\"volume\":70}"],
    ["gbc-lab-save:old", "OLD"],
  ]);

  const summary = replaceSaveArchive(target, parsed.archive);

  assert.equal(summary.records, 2);
  assert.equal(target.getItem("gbc-lab-save:old"), null);
  assert.equal(target.getItem("gbc-lab-save:65536:cafebabe"), "AQID");
  assert.match(target.getItem("gbc-lab-state:65536:cafebabe:2"), /RESTORED/);
  assert.equal(target.getItem("gbc-lab-preferences"), "{\"volume\":70}");
});

test("rejects malformed or duplicate backup records before storage changes", () => {
  assert.throws(
    () => parseSaveArchive("{\"format\":\"wrong\"}"),
    /format or version/i,
  );
  const validState = {
    type: "state",
    romKey: "32768:deadbeef",
    slot: 0,
    value: JSON.stringify({
      romKey: "32768:deadbeef",
      savedAt: 1,
      state: { title: "TEST" },
    }),
  };
  assert.throws(
    () => parseSaveArchive(JSON.stringify({
      format: "gameboy-lab-save-archive",
      version: 1,
      entries: [validState, validState],
    })),
    /duplicate/i,
  );
});
