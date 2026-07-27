import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { GameBoy } from "../app/lib/gameboy.js";

const logo = [
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83,
  0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
  0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63,
  0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
];

function makeRom(program = [], { banks = 2, type = 0, cgb = 0 } = {}) {
  const rom = new Uint8Array(banks * 0x4000);
  rom.fill(0);
  rom.set([0xc3, 0x50, 0x01], 0x100);
  rom.set(logo, 0x104);
  rom.set(new TextEncoder().encode("CORETEST"), 0x134);
  rom[0x143] = cgb;
  rom[0x147] = type;
  rom[0x148] = banks <= 2 ? 0 : Math.log2(banks) - 1;
  rom.set(program, 0x150);
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i += 1) checksum = (checksum - rom[i] - 1) & 0xff;
  rom[0x14d] = checksum;
  return rom;
}

test("validates cartridge headers and executes arithmetic, memory, and CB opcodes", () => {
  const rom = makeRom([
    0x3e, 0x0f,       // LD A,$0F
    0xc6, 0x01,       // ADD A,$01
    0x06, 0x80,       // LD B,$80
    0xcb, 0x00,       // RLC B
    0xea, 0x00, 0xc0, // LD ($C000),A
    0x76,             // HALT
  ]);
  const gb = new GameBoy("dmg");
  const header = gb.loadROM(rom);
  assert.equal(header.logoValid, true);
  assert.equal(header.checksumValid, true);
  assert.equal(header.title, "CORETEST");
  for (let i = 0; i < 7; i += 1) gb.step();
  assert.equal(gb.a, 0x10);
  assert.equal(gb.b, 0x01);
  assert.equal(gb.f & 0x10, 0x10);
  assert.equal(gb.read8(0xc000), 0x10);
});

test("bases unconditional relative jumps on the byte after their displacement", () => {
  const gb = new GameBoy("dmg");
  gb.loadROM(makeRom([
    0x18, 0x02, // JR +2: skip both increment instructions below
    0x04,       // INC B
    0x04,       // INC B
    0x0c,       // INC C
    0x76,       // HALT
  ]));

  gb.step(); // Cartridge entry jump.
  gb.step(); // Relative jump under test.
  assert.equal(gb.pc, 0x0154);
  gb.step();
  assert.equal(gb.b, 0x00);
  assert.equal(gb.c, 0x14);
});

test("reproduces the HALT bug when IME is clear and an interrupt is pending", () => {
  const gb = new GameBoy("dmg");
  gb.loadROM(makeRom([0x76, 0x04, 0x00]));
  gb.pc = 0x150;
  gb.ime = false;
  gb.ie = 1;
  gb.iflag = 1;
  gb.b = 0;
  gb.step();
  assert.equal(gb.haltBug, true);
  gb.step();
  assert.equal(gb.b, 1);
  assert.equal(gb.pc, 0x151);
  gb.step();
  assert.equal(gb.b, 2);
});

test("models timer falling edges, DIV-write glitches, and delayed TIMA reload", () => {
  const gb = new GameBoy("dmg");
  gb.loadROM(makeRom());
  gb.tac = 0x05;
  gb.tima = 1;
  gb.divCounter = 0x000f;
  gb.tick(1);
  assert.equal(gb.tima, 2);

  gb.tima = 0;
  gb.divCounter = 0x0008;
  gb.writeIO(0x04, 0);
  assert.equal(gb.tima, 1);

  gb.divCounter = 0;
  gb.tima = 0xff;
  gb.tma = 0x42;
  gb.iflag = 0;
  gb.incrementTima();
  assert.equal(gb.tima, 0);
  gb.tick(4);
  assert.equal(gb.tima, 0x42);
  assert.equal(gb.iflag & 4, 4);
});

test("handles MBC1 ROM-bank selection without exposing bank zero in the switch window", () => {
  const rom = makeRom([], { banks: 4, type: 1 });
  rom[0x4000] = 0x11;
  rom[0x8000] = 0x22;
  rom[0xc000] = 0x33;
  const gb = new GameBoy("dmg");
  gb.loadROM(rom);
  assert.equal(gb.read8(0x4000), 0x11);
  gb.write8(0x2000, 2);
  assert.equal(gb.read8(0x4000), 0x22);
  gb.write8(0x2000, 0);
  assert.equal(gb.read8(0x4000), 0x11);
});

test("renders a complete 160×144 frame and raises VBlank", () => {
  const gb = new GameBoy("dmg");
  gb.loadROM(makeRom([0x18, 0xfe]));
  gb.io[0x47] = 0xe4;
  gb.vram[0] = 0xff;
  gb.vram[1] = 0xff;
  gb.vram[0x1800] = 0;
  const ready = gb.runFrame();
  assert.equal(ready, true);
  assert.equal(gb.framebuffer.length, 160 * 144 * 4);
  assert.equal(gb.iflag & 1, 1);
  assert.ok(gb.frameNumber >= 1);
});

test("distinguishes native CGB mode and the CGB compatibility palette", () => {
  const native = new GameBoy("cgb");
  native.loadROM(makeRom([], { cgb: 0x80 }));
  assert.equal(native.cgbMode, true);

  const tetrisHeader = makeRom();
  tetrisHeader.set(new TextEncoder().encode("TETRIS\0\0"), 0x134);
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i += 1) checksum = (checksum - tetrisHeader[i] - 1) & 0xff;
  tetrisHeader[0x14d] = checksum;
  const compatibility = new GameBoy("cgb");
  compatibility.loadROM(tetrisHeader);
  assert.equal(compatibility.cgbMode, false);
  assert.deepEqual(compatibility.dmgPalette[1], [241, 211, 52]);
});

test("maps and executes user-supplied DMG and CGB boot ROMs without bundling one", () => {
  const dmgBoot = new Uint8Array(0x100);
  dmgBoot.set([0xc3, 0xfc, 0x00], 0);
  dmgBoot.set([0x3e, 0x01, 0xe0, 0x50], 0xfc);
  const dmg = new GameBoy("dmg");
  dmg.setBootROM(dmgBoot);
  dmg.loadROM(makeRom([0x00]));
  assert.equal(dmg.pc, 0);
  assert.equal(dmg.read8(0), 0xc3);
  dmg.step();
  dmg.step();
  dmg.step();
  assert.equal(dmg.bootEnabled, false);
  assert.equal(dmg.pc, 0x100);
  assert.equal(dmg.read8(0x100), 0xc3);

  const cgbBoot = new Uint8Array(0x900);
  cgbBoot[0x200] = 0x5a;
  const cgb = new GameBoy("cgb");
  cgb.setBootROM(cgbBoot);
  cgb.loadROM(makeRom([], { cgb: 0x80 }));
  assert.equal(cgb.read8(0x200), 0x5a);
  assert.throws(() => new GameBoy("dmg").setBootROM(new Uint8Array(255)), /256 bytes/);
});

test("boots and renders the supplied Tetris cartridge in both console models", () => {
  const cartridgePath = fileURLToPath(new URL("../Tetris (JUE) (V1.1) [!].gb", import.meta.url));
  if (!existsSync(cartridgePath)) return;
  const rom = new Uint8Array(readFileSync(cartridgePath));
  for (const model of ["dmg", "cgb"]) {
    const gb = new GameBoy(model);
    const header = gb.loadROM(rom);
    assert.equal(header.title, "TETRIS");
    assert.equal(header.checksumValid, true);
    for (let frame = 0; frame < 120; frame += 1) gb.runFrame();
    assert.ok(gb.frameNumber > 100);
    assert.notEqual(gb.pc, 0x100);
    const colors = new Set();
    for (let index = 0; index < gb.framebuffer.length; index += 4) {
      colors.add(`${gb.framebuffer[index]},${gb.framebuffer[index + 1]},${gb.framebuffer[index + 2]}`);
    }
    assert.ok(colors.size >= 2);

    if (model === "dmg") {
      // Exercise the full timed startup, title initialization, audio driver,
      // joypad edge detection, and transition into Tetris's first menu.
      for (let frame = 120; frame < 530; frame += 1) gb.runFrame();
      assert.equal(gb.hram[0x61], 0x07);
      gb.setButton("start", true);
      for (let frame = 0; frame < 3; frame += 1) gb.runFrame();
      gb.setButton("start", false);
      for (let frame = 0; frame < 45; frame += 1) gb.runFrame();
      assert.equal(gb.hram[0x61], 0x0e);
      assert.equal(gb.sp, 0xcfff);
    }
  }
});
