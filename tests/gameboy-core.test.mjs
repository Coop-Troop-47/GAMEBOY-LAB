import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CGB_COMPATIBILITY_PALETTES, GameBoy } from "../app/lib/gameboy.js";
import { EMBEDDED_BIOS_INFO, getEmbeddedBootROM } from "../app/lib/embeddedBios.js";

const logo = [
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83,
  0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
  0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63,
  0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
];

function makeRom(program = [], { banks = 2, type = 0, cgb = 0, ram = 0 } = {}) {
  const rom = new Uint8Array(banks * 0x4000);
  rom.fill(0);
  rom.set([0xc3, 0x50, 0x01], 0x100);
  rom.set(logo, 0x104);
  rom.set(new TextEncoder().encode("CORETEST"), 0x134);
  rom[0x143] = cgb;
  rom[0x147] = type;
  rom[0x148] = banks <= 2 ? 0 : Math.log2(banks) - 1;
  rom[0x149] = ram;
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

test("locks the CPU on unassigned SM83 opcodes while peripherals keep running", () => {
  const gb = new GameBoy("dmg");
  gb.loadROM(makeRom([0xd3, 0x04]));
  gb.pc = 0x150;
  const startCycles = gb.cycles;
  assert.equal(gb.step(), 4);
  assert.equal(gb.locked, true);
  assert.equal(gb.pc, 0x151);
  gb.ie = 1;
  gb.iflag = 1;
  gb.ime = true;
  assert.equal(gb.step(), 4);
  assert.equal(gb.pc, 0x151);
  assert.equal(gb.b, 0);
  assert.equal(gb.iflag & 1, 1, "interrupts cannot unlock the CPU");
  assert.equal(gb.cycles, startCycles + 8);
});

test("keeps interrupt-entry bus cycles observable and permits IE-push cancellation", () => {
  const gb = new GameBoy("dmg");
  gb.loadROM(makeRom());
  gb.pc = 0x0200;
  gb.sp = 0x0000;
  gb.ie = 0x04;
  gb.iflag = 0x04;
  gb.ime = true;

  assert.equal(gb.serviceInterrupt(), 20);
  assert.equal(gb.ie, 0x02, "high PC byte is written through SP=$FFFF");
  assert.equal(gb.iflag & 0x1f, 0x04, "cancelled interrupt is not acknowledged");
  assert.equal(gb.pc, 0x0000, "cancelled dispatch uses the hardware cancellation vector");
  assert.equal(gb.sp, 0xfffe);
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

test("clocks serial transfers bit-by-bit from the free-running divider phase", () => {
  const gb = new GameBoy("dmg");
  gb.loadROM(makeRom());
  gb.divCounter = 0;
  gb.writeIO(0x01, 0xa5);
  gb.writeIO(0x02, 0x81);

  gb.tick(507);
  assert.equal(gb.serialData, 0xa5);
  gb.tick(1);
  assert.equal(gb.serialData, 0x4b, "first disconnected-link bit is pulled high");
  gb.tick(7 * 512);
  assert.equal(gb.serialData, 0xff);
  assert.equal(gb.serialControl & 0x80, 0);
  assert.equal(gb.iflag & 0x08, 0x08);
  assert.equal(gb.serialOutput, String.fromCharCode(0xa5));
});

test("aliases DMG DMA sources above DFFF and gates joypad IRQs by selected lines", () => {
  const gb = new GameBoy("dmg");
  gb.loadROM(makeRom());
  gb.wram[0x1e00] = 0x5a;
  gb.wram[0x1f00] = 0xa5;
  assert.equal(gb.readDmaSource(0xfe00), 0x5a);
  assert.equal(gb.readDmaSource(0xff00), 0xa5);

  gb.iflag = 0;
  gb.setButton("a", true);
  assert.equal(gb.iflag & 0x10, 0, "unselected action line does not request JOYP");
  gb.setButton("a", false);
  gb.writeIO(0x00, 0x10);
  gb.setButton("a", true);
  assert.equal(gb.iflag & 0x10, 0x10);
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

test("preserves mapper-specific bank-zero behavior and direct cartridge RAM", () => {
  const mbc5Rom = makeRom([], { banks: 4, type: 0x1b, ram: 2 });
  mbc5Rom[0x0000] = 0x55;
  mbc5Rom[0x4000] = 0x11;
  const mbc5 = new GameBoy("dmg");
  mbc5.loadROM(mbc5Rom);
  assert.equal(mbc5.read8(0x4000), 0x11);
  mbc5.write8(0x2000, 0);
  assert.equal(mbc5.read8(0x4000), 0x55, "MBC5 may map bank zero in the switch window");

  const directRam = new GameBoy("dmg");
  directRam.loadROM(makeRom([], { type: 0x09, ram: 2 }));
  directRam.write8(0xa000, 0x7b);
  assert.equal(directRam.read8(0xa000), 0x7b);
});

test("round-trips complete save states without confusing them with cartridge saves", () => {
  const gb = new GameBoy("dmg");
  gb.loadROM(makeRom([0x18, 0xfe], { type: 3, ram: 2 }));
  gb.ramEnabled = true;
  gb.write8(0xa123, 0x5a);
  gb.a = 0x42;
  gb.pc = 0x2345;
  gb.ppuDot = 191;
  gb.ly = 77;
  gb.framebuffer[1234] = 91;
  const cartridgeSave = gb.exportBattery();
  const state = gb.exportState();

  gb.write8(0xa123, 0x11);
  gb.a = 0;
  gb.pc = 0x100;
  gb.ppuDot = 0;
  gb.ly = 0;
  gb.framebuffer[1234] = 0;
  assert.equal(gb.importState(state), true);
  assert.equal(gb.read8(0xa123), 0x5a);
  assert.equal(gb.a, 0x42);
  assert.equal(gb.pc, 0x2345);
  assert.equal(gb.ppuDot, 191);
  assert.equal(gb.ly, 77);
  assert.equal(gb.framebuffer[1234], 91);
  assert.equal(cartridgeSave.length, 0x2000);
  assert.equal(state.memory.framebuffer.length, 160 * 144 * 4);

  const other = new GameBoy("cgb");
  other.loadROM(makeRom([], { type: 3, ram: 2 }));
  assert.equal(other.importState(state), false);
});

test("persists battery RAM and RTC metadata while preserving standard .sav bytes", () => {
  const mbc3 = new GameBoy("dmg");
  mbc3.loadROM(makeRom([], { type: 0x10, ram: 2 }));
  mbc3.ramEnabled = true;
  mbc3.write8(0xa000, 0x7c);
  mbc3.writeRTC(0x08, 37);
  const stored = mbc3.exportBatteryState();
  assert.equal(stored.ram[0], 0x7c);
  assert.equal(stored.rtc.seconds, 37);
  assert.equal(mbc3.exportBattery()[0], 0x7c);

  const restored = new GameBoy("dmg");
  restored.loadROM(makeRom([], { type: 0x10, ram: 2 }), stored);
  restored.ramEnabled = true;
  assert.equal(restored.read8(0xa000), 0x7c);
  assert.equal(restored.rtc.seconds, 37);

  const mbc2 = new GameBoy("dmg");
  mbc2.loadROM(makeRom([], { type: 0x06 }));
  mbc2.write8(0x0000, 0x0a);
  mbc2.write8(0xa000, 0xab);
  assert.equal(mbc2.read8(0xa000), 0xfb);
});

test("advances, latches, halts, and overflows the MBC3 real-time clock", () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const gb = new GameBoy("dmg");
    gb.loadROM(makeRom([], { type: 0x10, ram: 2 }));
    gb.ramEnabled = true;
    gb.writeRTC(0x08, 58);
    gb.writeRTC(0x09, 59);
    gb.writeRTC(0x0a, 23);
    gb.writeRTC(0x0b, 0xff);
    gb.writeRTC(0x0c, 0x01);

    now += 3000;
    gb.updateRTC();
    assert.equal(gb.rtc.seconds, 1);
    assert.equal(gb.rtc.minutes, 0);
    assert.equal(gb.rtc.hours, 0);
    assert.equal(gb.rtc.days, 0);
    assert.equal(gb.rtc.carry, true);

    gb.latchRTC();
    now += 2000;
    assert.equal(gb.readRTC(0x08), 1);
    gb.latchedRTC = null;
    assert.equal(gb.readRTC(0x08), 3);

    gb.writeRTC(0x0c, 0xc0);
    now += 5000;
    gb.latchedRTC = null;
    assert.equal(gb.readRTC(0x08), 3);
    gb.writeRTC(0x0c, 0x80);
    now += 1000;
    assert.equal(gb.readRTC(0x08), 4);
  } finally {
    Date.now = originalNow;
  }
});

test("maps timer-only MBC3 cartridges and rejects invalid RTC bank selections", () => {
  const timerOnly = new GameBoy("dmg");
  timerOnly.loadROM(makeRom([], { type: 0x0f }));
  timerOnly.write8(0x0000, 0x0a);
  timerOnly.write8(0x4000, 0x08);
  timerOnly.write8(0xa000, 42);
  timerOnly.write8(0x6000, 0);
  timerOnly.write8(0x6000, 1);
  assert.equal(timerOnly.read8(0xa000), 42);
  assert.equal(timerOnly.batteryDirty, true);

  const withRam = new GameBoy("dmg");
  withRam.loadROM(makeRom([], { type: 0x10, ram: 2 }));
  withRam.write8(0x0000, 0x0a);
  withRam.write8(0x4000, 0);
  withRam.write8(0xa000, 0x66);
  withRam.write8(0x4000, 0x07);
  withRam.write8(0xa000, 0x99);
  assert.equal(withRam.read8(0xa000), 0xff);
  withRam.write8(0x4000, 0);
  assert.equal(withRam.read8(0xa000), 0x66, "invalid RTC selections do not alias RAM bank zero");
});

test("keeps PPU and APU at base clock in GBC double-speed mode", () => {
  const gb = new GameBoy("cgb");
  gb.loadROM(makeRom([0x18, 0xfe], { cgb: 0x80 }));
  gb.doubleSpeed = true;
  const startCycles = gb.cycles;
  assert.equal(gb.runFrame(), true);
  assert.ok(gb.cycles - startCycles > 120000);
  assert.equal(gb.frameNumber, 1);
  const audio = gb.drainAudio();
  assert.ok(audio.length > 1200 && audio.length < 1800);
});

test("advances one hardware frame when LCDC is disabled instead of running twice as fast", () => {
  for (const doubleSpeed of [false, true]) {
    const gb = new GameBoy("cgb");
    gb.loadROM(makeRom([0x18, 0xfe], { cgb: 0x80 }));
    gb.io[0x40] = 0;
    gb.doubleSpeed = doubleSpeed;
    gb.speedSubcycle = 0;
    const startCpu = gb.cycles;
    const startBase = gb.baseCycles;
    assert.equal(gb.runFrame(), false, "an LCD-off interval has no VBlank");
    const baseElapsed = gb.baseCycles - startBase;
    const cpuElapsed = gb.cycles - startCpu;
    assert.ok(baseElapsed >= 70224 && baseElapsed <= 70244);
    if (doubleSpeed) {
      assert.ok(cpuElapsed >= 140448 && cpuElapsed <= 140488);
    } else {
      assert.ok(cpuElapsed >= 70224 && cpuElapsed <= 70244);
    }
  }
});

test("stalls the GBC CPU for general and HBlank VRAM DMA transfers", () => {
  const gdma = new GameBoy("cgb");
  gdma.loadROM(makeRom([], { cgb: 0x80 }));
  gdma.io[0x40] = 0;
  for (let index = 0; index < 0x20; index += 1) gdma.wram[index] = 0x80 + index;
  gdma.writeIO(0x51, 0xc0);
  gdma.writeIO(0x52, 0x00);
  gdma.writeIO(0x53, 0x00);
  gdma.writeIO(0x54, 0x00);
  const startCycles = gdma.cycles;
  gdma.writeIO(0x55, 0x01);
  assert.deepEqual(Array.from(gdma.vram.subarray(0, 0x20)), Array.from(gdma.wram.subarray(0, 0x20)));
  assert.equal(gdma.cycles - startCycles, 68, "four setup clocks plus 32 dots per block");
  assert.equal(gdma.readIO(0x55), 0xff);

  const hdma = new GameBoy("cgb");
  hdma.loadROM(makeRom([], { cgb: 0x80 }));
  for (let index = 0; index < 0x10; index += 1) hdma.wram[index] = 0x40 + index;
  hdma.writeIO(0x51, 0xc0);
  hdma.writeIO(0x52, 0x00);
  hdma.writeIO(0x53, 0x00);
  hdma.writeIO(0x54, 0x00);
  hdma.writeIO(0x55, 0x80);
  hdma.ppuMode = 3;
  hdma.ppuDot = hdma.ppuMode3End - 1;
  hdma.tickPPU();
  assert.deepEqual(Array.from(hdma.vram.subarray(0, 0x10)), Array.from(hdma.wram.subarray(0, 0x10)));
  assert.equal(hdma.hdmaStallCycles, 32);
  const beforeStall = hdma.cycles;
  assert.equal(hdma.step(), 32);
  assert.equal(hdma.cycles - beforeStall, 32);
  assert.equal(hdma.readIO(0x55), 0xff);
});

test("holds the GBC CPU and divider for the hardware speed-switch interval", () => {
  const gb = new GameBoy("cgb");
  gb.loadROM(makeRom([0x10, 0x00, 0x04], { cgb: 0x80 }));
  gb.pc = 0x150;
  gb.speedSwitchArmed = true;
  gb.divCounter = 0x1234;
  const startDot = gb.ppuDot;
  const startLine = gb.ly;
  assert.equal(gb.step(), 8);
  assert.equal(gb.stopped, true);
  assert.equal(gb.doubleSpeed, false);
  assert.equal(gb.divCounter, 0);
  const beforeStall = gb.cycles;
  assert.equal(gb.step(), 8200);
  assert.equal(gb.cycles - beforeStall, 8200);
  assert.equal(gb.divCounter, 0, "DIV remains frozen during the switch");
  assert.equal(gb.doubleSpeed, true);
  assert.equal(gb.stopped, false);
  assert.notDeepEqual(
    [gb.ly, gb.ppuDot],
    [startLine, startDot],
    "the PPU continues at its base clock",
  );
  gb.step();
  assert.equal(gb.b, 1);
});

test("matches audio generation to the host sample rate without per-sample mixer allocation", () => {
  const gb = new GameBoy("dmg");
  assert.equal(gb.setAudioSampleRate(44100), true);
  assert.equal(gb.audioRate, 44100);
  gb.io[0x26] = 0x80;
  gb.audioClock = 4194304 - 44100;
  gb.tickAPU();
  assert.equal(gb.drainAudio().length, 2);
  assert.equal(gb.audioMix instanceof Float64Array, true);
  assert.equal(gb.audioSamples instanceof Float32Array, true);
  assert.equal(gb.audioSampleCount, 0);
  assert.equal(gb.setAudioSampleRate(Number.NaN), false);
  assert.equal(gb.audioRate, 44100);
});

test("clocks the noise channel at the hardware NR43 rate used by impact effects", () => {
  const gb = new GameBoy("dmg");
  gb.io[0x26] = 0x80;
  gb.io[0x24] = 0x77;
  gb.io[0x25] = 0x88;
  gb.writeAPU(0x21, 0xf0);
  gb.writeAPU(0x22, 0x00);
  gb.writeAPU(0x23, 0x80);
  const initialLfsr = gb.ch4.lfsr;
  for (let cycle = 0; cycle < 8; cycle += 1) gb.tickAPU();
  assert.notEqual(gb.ch4.lfsr, initialLfsr);
  assert.equal(gb.ch4.timer, 8);

  gb.writeAPU(0x22, 0xe0);
  gb.writeAPU(0x23, 0x80);
  const lockedLfsr = gb.ch4.lfsr;
  for (let cycle = 0; cycle < 128; cycle += 1) gb.tickAPU();
  assert.equal(gb.ch4.lfsr, lockedLfsr);
});

test("keeps zero-period envelopes silent and clocks channel-one frequency sweep", () => {
  const gb = new GameBoy("dmg");
  gb.io[0x26] = 0x80;
  gb.writeAPU(0x16, 0);
  gb.writeAPU(0x17, 0x08);
  gb.writeAPU(0x19, 0x80);
  assert.equal(gb.ch2.volume, 0);
  assert.equal(gb.ch2.envCounter, 8);
  for (let index = 0; index < 8; index += 1) gb.clockEnvelopes();
  assert.equal(gb.ch2.volume, 0);

  gb.writeAPU(0x10, 0x11);
  gb.writeAPU(0x12, 0xf0);
  gb.writeAPU(0x13, 0x00);
  gb.writeAPU(0x14, 0x85);
  assert.equal(gb.ch1.enabled, true);
  gb.clockSweeps();
  assert.equal(gb.squareFrequency(0x13, 0x14), 0x780);
  assert.equal(gb.ch1.enabled, false);
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

test("raises the GBC line-144 OAM STAT source one M-cycle before VBlank", () => {
  const cgb = new GameBoy("cgb");
  cgb.loadROM(makeRom([], { cgb: 0x80 }));
  cgb.io[0x40] = 0x80;
  cgb.io[0x41] = 0xa0;
  cgb.ly = 143;
  cgb.ppuDot = 451;
  cgb.ppuMode = 0;
  cgb.statSignal = false;
  cgb.iflag = 0;
  cgb.tickPPU();
  assert.equal(cgb.ppuDot, 452);
  assert.equal(cgb.iflag & 0x02, 0x02);
  assert.equal(cgb.ppuMode, 0, "the quirk does not expose mode 2 through STAT");

  const dmg = new GameBoy("dmg");
  dmg.loadROM(makeRom());
  dmg.io[0x40] = 0x80;
  dmg.io[0x41] = 0xa0;
  dmg.ly = 143;
  dmg.ppuDot = 451;
  dmg.ppuMode = 0;
  dmg.statSignal = false;
  dmg.iflag = 0;
  dmg.tickPPU();
  assert.equal(dmg.iflag & 0x02, 0);
});

test("implements GBC undocumented hardware registers and compatibility-mode masks", () => {
  const native = new GameBoy("cgb");
  native.loadROM(makeRom([], { cgb: 0x80 }));
  native.writeIO(0x72, 0x12);
  native.writeIO(0x73, 0x34);
  native.writeIO(0x75, 0xff);
  assert.equal(native.readIO(0x72), 0x12);
  assert.equal(native.readIO(0x73), 0x34);
  assert.equal(native.readIO(0x75), 0xff);
  native.writeIO(0x75, 0);
  assert.equal(native.readIO(0x75), 0x8f);

  const compatibility = new GameBoy("cgb");
  compatibility.loadROM(makeRom());
  compatibility.writeIO(0x4d, 1);
  compatibility.writeIO(0x02, 0x83);
  assert.equal(compatibility.readIO(0x4d), 0xff, "KEY1 is hidden in compatibility mode");
  assert.equal(compatibility.readIO(0x02), 0xff, "fast serial is hidden in compatibility mode");
  assert.equal(compatibility.readIO(0x4f), 0xfe, "VBK remains a physical GBC register");
  assert.equal(compatibility.readIO(0x68), 0x40, "palette indices remain readable");
  assert.equal(compatibility.readIO(0x69), 0xff, "palette RAM data is locked");
});

test("clocks serial transfers from either clock owner and supports a link endpoint", () => {
  const master = new GameBoy("dmg");
  master.loadROM(makeRom());
  const incoming = 0x3c;
  const outgoingBits = [];
  let bit = 7;
  master.setSerialEndpoint((outgoing) => {
    outgoingBits.push(outgoing);
    const result = (incoming >> bit) & 1;
    bit -= 1;
    return result;
  });
  master.writeIO(0x01, 0xa5);
  master.writeIO(0x02, 0x81);
  for (let index = 0; index < 8; index += 1) master.clockSerialMaster();
  assert.equal(master.serialData, incoming);
  assert.deepEqual(outgoingBits, [1, 0, 1, 0, 0, 1, 0, 1]);
  assert.equal(master.serialControl & 0x80, 0);
  assert.equal(master.iflag & 0x08, 0x08);

  const external = new GameBoy("dmg");
  external.loadROM(makeRom());
  external.writeIO(0x01, 0x96);
  external.writeIO(0x02, 0x80);
  const externalOutgoing = [];
  for (let index = 7; index >= 0; index -= 1) {
    externalOutgoing.push(external.clockSerialExternal((0x69 >> index) & 1));
  }
  assert.deepEqual(externalOutgoing, [1, 0, 0, 1, 0, 1, 1, 0]);
  assert.equal(external.serialData, 0x69);
  assert.equal(external.clockSerialExternal(), null, "completed transfers ignore extra clocks");
});

test("models the GBC infrared port without exposing it on DMG hardware", () => {
  const cgb = new GameBoy("cgb");
  cgb.loadROM(makeRom([], { cgb: 0x80 }));
  const outputs = [];
  cgb.setInfraredOutputHandler((active) => outputs.push(active));
  cgb.writeIO(0x56, 0xc1);
  assert.deepEqual(outputs, [true]);
  assert.equal(cgb.readIO(0x56), 0xfd, "enabled sensor sees the local emitter");
  cgb.writeIO(0x56, 0xc0);
  assert.deepEqual(outputs, [true, false]);
  assert.equal(cgb.readIO(0x56), 0xfe);
  cgb.setInfraredInput(true);
  assert.equal(cgb.readIO(0x56), 0xfc, "external IR activity pulls the sensor bit low");

  const dmg = new GameBoy("dmg");
  dmg.loadROM(makeRom());
  dmg.writeIO(0x56, 0xc1);
  assert.equal(dmg.readIO(0x56), 0xff);
});

test("packs framebuffer pixels without changing their RGBA bytes", () => {
  const gb = new GameBoy("dmg");
  assert.equal(gb.framebuffer32.buffer, gb.framebuffer.buffer);

  const dmgColor = gb.dmgColor(0xe4, 2, gb.dmgBgPalette);
  gb.setPackedPixel(7, 9, gb.dmgPackedColor(0xe4, 2, gb.dmgBgPalettePacked));
  let offset = (9 * 160 + 7) * 4;
  assert.deepEqual(
    Array.from(gb.framebuffer.subarray(offset, offset + 4)),
    [...dmgColor, 255],
  );

  gb.bgPalette[0] = 0x1f;
  gb.bgPalette[1] = 0x00;
  const cgbColor = Array.from(gb.cgbColor(gb.bgPalette, 0, 0));
  gb.setPackedPixel(8, 9, gb.cgbPackedColor(gb.bgPalette, 0, 0));
  offset = (9 * 160 + 8) * 4;
  assert.deepEqual(
    Array.from(gb.framebuffer.subarray(offset, offset + 4)),
    [...cgbColor, 255],
  );
});

test("distinguishes native GBC mode and the GBC compatibility palette", () => {
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
  assert.deepEqual(compatibility.dmgPalette[1], [230, 216, 54]);
  assert.equal(CGB_COMPATIBILITY_PALETTES.length, 13);

  assert.equal(compatibility.setCompatibilityPalette("blue"), true);
  assert.notDeepEqual(compatibility.dmgBgPalette, compatibility.dmgObj0Palette);
  assert.equal(compatibility.setCompatibilityPalette("not-a-palette"), false);
});

test("maps and executes DMG and GBC boot ROMs", () => {
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

test("embeds the supplied production BIOS revisions byte-for-byte", () => {
  const expected = {
    dmg: ["cf053eccb4ccafff9e67339d4e78e98dce7d1ed59be819d2a1ba2232c6fce1c7", 0x100],
    cgb: ["b4f2e416a35eef52cba161b159c7c8523a92594facb924b3ede0d722867c50c7", 0x900],
  };
  for (const [model, [hash, size]] of Object.entries(expected)) {
    const bios = getEmbeddedBootROM(model);
    assert.equal(bios.length, size);
    assert.equal(EMBEDDED_BIOS_INFO[model].size, size);
    assert.equal(createHash("sha256").update(bios).digest("hex"), hash);
  }
});

test("boots through both embedded production BIOS images", () => {
  for (const [model, cgb] of [["dmg", 0], ["cgb", 0], ["cgb", 0x80]]) {
    const gb = new GameBoy(model);
    gb.setBootROM(getEmbeddedBootROM(model));
    gb.loadROM(makeRom([0x18, 0xfe], { cgb }));
    let frames = 0;
    while (gb.bootEnabled && frames < 400) {
      gb.runFrame();
      frames += 1;
    }
    assert.equal(gb.bootEnabled, false, `${model} BIOS did not hand off`);
    assert.ok(gb.pc >= 0x0100);
  }
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

test("validates and starts every cartridge in the built-in ROM folder", () => {
  const cartridgeRoot = fileURLToPath(new URL("../SELECT_ROMS/", import.meta.url));
  const cartridgeFiles = readdirSync(cartridgeRoot)
    .filter((fileName) => /\.(gb|gbc)$/i.test(fileName))
    .sort((left, right) => left.localeCompare(right));
  assert.equal(cartridgeFiles.length, 40);
  for (const fileName of cartridgeFiles) {
    const rom = new Uint8Array(readFileSync(`${cartridgeRoot}/${fileName}`));
    const model = rom[0x143] === 0xc0 ? "cgb" : "dmg";
    const gb = new GameBoy(model);
    const header = gb.loadROM(rom);
    assert.equal(header.logoValid, true, `${fileName}: Nintendo logo`);
    assert.equal(header.checksumValid, true, `${fileName}: header checksum`);
    assert.doesNotMatch(header.mapper, /^Unsupported/, `${fileName}: mapper`);
    gb.runFrame();
    assert.equal(gb.runFrameCalls, 1, `${fileName}: first host run`);
    assert.ok(gb.cycles > 0, `${fileName}: CPU advanced`);
  }
});

test("boots, renders, accepts input, and deterministically restores Super Mario Land", () => {
  const cartridgePath = fileURLToPath(
    new URL("../SELECT_ROMS/Super Mario Land (World) (Rev 1).gb", import.meta.url),
  );
  assert.equal(existsSync(cartridgePath), true);
  const rom = new Uint8Array(readFileSync(cartridgePath));
  const gb = new GameBoy("dmg");
  gb.setBootROM(getEmbeddedBootROM("dmg"));
  const header = gb.loadROM(rom);
  assert.equal(header.title, "SUPER MARIOLAND");
  assert.equal(header.mapper, "MBC1");
  assert.equal(header.checksumValid, true);
  let titlePeak = 0;
  for (let frame = 0; frame < 370; frame += 1) {
    gb.runFrame();
    const audio = gb.drainAudio();
    if (frame >= 350) {
      for (const sample of audio) titlePeak = Math.max(titlePeak, Math.abs(sample));
    }
  }
  assert.equal(titlePeak, 0, "Mario title should not turn $08 silence into noise");
  gb.setButton("start", true);
  let gameplayPeak = 0;
  for (let frame = 0; frame < 3; frame += 1) {
    gb.runFrame();
    for (const sample of gb.drainAudio()) gameplayPeak = Math.max(gameplayPeak, Math.abs(sample));
  }
  gb.setButton("start", false);
  for (let frame = 0; frame < 30; frame += 1) {
    gb.runFrame();
    for (const sample of gb.drainAudio()) gameplayPeak = Math.max(gameplayPeak, Math.abs(sample));
  }
  assert.ok(gameplayPeak > 0.05, "Mario gameplay should produce tonal APU output");

  const state = gb.exportState();
  for (let frame = 0; frame < 12; frame += 1) gb.runFrame();
  const expected = {
    pc: gb.pc,
    frame: gb.frameNumber,
    framebuffer: createHash("sha256").update(gb.framebuffer).digest("hex"),
  };
  assert.equal(gb.importState(state), true);
  for (let frame = 0; frame < 12; frame += 1) gb.runFrame();
  assert.equal(gb.pc, expected.pc);
  assert.equal(gb.frameNumber, expected.frame);
  assert.equal(createHash("sha256").update(gb.framebuffer).digest("hex"), expected.framebuffer);
});
