const SCREEN_WIDTH = 160;
const SCREEN_HEIGHT = 144;
const FRAME_CYCLES = 70224;
const CPU_CLOCK = 4194304;
const AUDIO_RATE = 48000;
const STATE_VERSION = 1;

const DUTY_PATTERNS = [
  new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]),
  new Uint8Array([1, 0, 0, 0, 0, 0, 0, 1]),
  new Uint8Array([1, 0, 0, 0, 0, 1, 1, 1]),
  new Uint8Array([0, 1, 1, 1, 1, 1, 1, 0]),
];
const NOISE_DIVISORS = new Float64Array([0.5, 1, 2, 3, 4, 5, 6, 7]);
const NOISE_STEP_8_LONG = new Uint16Array(0x8000);
const NOISE_STEP_8_SHORT = new Uint16Array(0x8000);
for (let state = 0; state < 0x8000; state += 1) {
  let longState = state;
  let shortState = state;
  for (let step = 0; step < 8; step += 1) {
    let bit = (longState & 1) ^ ((longState >> 1) & 1);
    longState = (longState >> 1) | (bit << 14);
    bit = (shortState & 1) ^ ((shortState >> 1) & 1);
    shortState = (shortState >> 1) | (bit << 14);
    shortState = (shortState & ~(1 << 6)) | (bit << 6);
  }
  NOISE_STEP_8_LONG[state] = longState;
  NOISE_STEP_8_SHORT[state] = shortState;
}

const FLAG_Z = 0x80;
const FLAG_N = 0x40;
const FLAG_H = 0x20;
const FLAG_C = 0x10;

const DMG_GREEN_PALETTE = [
  [202, 220, 159],
  [139, 172, 88],
  [52, 104, 86],
  [20, 46, 42],
];

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;

function packRGBA(red, green, blue) {
  return LITTLE_ENDIAN
    ? ((0xff000000 | (blue << 16) | (green << 8) | red) >>> 0)
    : (((red << 24) | (green << 16) | (blue << 8) | 0xff) >>> 0);
}

function packPalette(palette) {
  return new Uint32Array(palette.map((color) => packRGBA(color[0], color[1], color[2])));
}

// Color conversion used to be recomputed with six Math.pow calls for almost
// every CGB pixel. Hardware only exposes 32,768 RGB555 colors, so a compact
// lookup table makes the exact same transform allocation-free in the hot PPU
// path.
const CGB_COLOR_LUT = new Uint8Array(0x8000 * 3);
const CGB_COLOR_LUT_PACKED = new Uint32Array(0x8000);
for (let value = 0; value < 0x8000; value += 1) {
  const r = value & 31;
  const g = (value >> 5) & 31;
  const b = (value >> 10) & 31;
  const rr = Math.pow(r / 31, 1.42);
  const gg = Math.pow(g / 31, 1.42);
  const bb = Math.pow(b / 31, 1.42);
  const offset = value * 3;
  CGB_COLOR_LUT[offset] = Math.min(255, Math.round(245 * (rr * 0.82 + gg * 0.12 + bb * 0.02)));
  CGB_COLOR_LUT[offset + 1] = Math.min(255, Math.round(245 * (gg * 0.78 + rr * 0.10 + bb * 0.08)));
  CGB_COLOR_LUT[offset + 2] = Math.min(255, Math.round(245 * (bb * 0.74 + gg * 0.18 + rr * 0.04)));
  CGB_COLOR_LUT_PACKED[value] = packRGBA(
    CGB_COLOR_LUT[offset],
    CGB_COLOR_LUT[offset + 1],
    CGB_COLOR_LUT[offset + 2],
  );
}

const STATE_SCALARS = [
  "a", "f", "b", "c", "d", "e", "h", "l", "sp", "pc",
  "ime", "imeDelay", "halted", "stopped", "haltBug", "ie", "iflag",
  "joypad", "joypSelect", "divCounter", "tima", "tma", "tac",
  "timerReload", "timerReloading", "serialData", "serialControl", "serialCycles",
  "vramBank", "wramBank", "romBank", "ramBank", "ramEnabled", "mbc1Mode",
  "mbc1High", "rtcSelect", "rtcLatchValue", "dmaCycles", "dmaSource",
  "dmaIndex", "dmaSubcycle", "hdmaSource", "hdmaDestination", "hdmaBlocks",
  "hdmaActive", "bgPaletteIndex", "objPaletteIndex", "opri", "ppuDot", "ly",
  "ppuMode", "ppuMode3End", "statSignal", "windowLine", "frameReady",
  "frameNumber", "cycles", "bootEnabled", "doubleSpeed", "speedSwitchArmed",
  "speedSubcycle", "audioClock", "audioFrameStep", "cgbMode",
];

// Production CGB boot-ROM palette dictionary in RGB555 form. Compatibility
// mode uses independent background, OBJ0, and OBJ1 palettes just like hardware.
const CGB_COMPATIBILITY_COLORS = [
  [0x7fff, 0x32bf, 0x00d0, 0x0000],
  [0x639f, 0x4279, 0x15b0, 0x04cb],
  [0x7fff, 0x6e31, 0x454a, 0x0000],
  [0x7fff, 0x1bef, 0x0200, 0x0000],
  [0x7fff, 0x421f, 0x1cf2, 0x0000],
  [0x7fff, 0x5294, 0x294a, 0x0000],
  [0x7fff, 0x03ff, 0x012f, 0x0000],
  [0x7fff, 0x03ef, 0x01d6, 0x0000],
  [0x7fff, 0x42b5, 0x3dc8, 0x0000],
  [0x7e74, 0x03ff, 0x0180, 0x0000],
  [0x67ff, 0x77ac, 0x1a13, 0x2d6b],
  [0x7ed6, 0x4bff, 0x2175, 0x0000],
  [0x53ff, 0x4a5f, 0x7e52, 0x0000],
  [0x4fff, 0x7ed2, 0x3a4c, 0x1ce0],
  [0x03ed, 0x7fff, 0x255f, 0x0000],
  [0x036a, 0x021f, 0x03ff, 0x7fff],
  [0x7fff, 0x01df, 0x0112, 0x0000],
  [0x231f, 0x035f, 0x00f2, 0x0009],
  [0x7fff, 0x03ea, 0x011f, 0x0000],
  [0x299f, 0x001a, 0x000c, 0x0000],
  [0x7fff, 0x027f, 0x001f, 0x0000],
  [0x7fff, 0x03e0, 0x0206, 0x0120],
  [0x7fff, 0x7eeb, 0x001f, 0x7c00],
  [0x7fff, 0x3fff, 0x7e00, 0x001f],
  [0x7fff, 0x03ff, 0x001f, 0x0000],
  [0x03ff, 0x001f, 0x000c, 0x0000],
  [0x7fff, 0x033f, 0x0193, 0x0000],
  [0x0000, 0x4200, 0x037f, 0x7fff],
  [0x7fff, 0x7e8c, 0x7c00, 0x0000],
  [0x7fff, 0x1bef, 0x6180, 0x0000],
];

const CGB_MANUAL_PALETTES = [
  { id: "blue", label: "Blue", buttons: "LEFT", combination: [4, 3, 28] },
  { id: "dark-blue", label: "Dark Blue", buttons: "LEFT + A", combination: [4, 0, 2] },
  { id: "gray", label: "Gray", buttons: "LEFT + B", combination: [5, 5, 5] },
  { id: "green", label: "Green", buttons: "RIGHT", combination: [18, 18, 18] },
  { id: "dark-green", label: "Dark Green", buttons: "RIGHT + A", combination: [4, 4, 29] },
  { id: "reverse", label: "Reverse", buttons: "RIGHT + B", combination: [27, 27, 27] },
  { id: "brown", label: "Brown", buttons: "UP", combination: [0, 0, 0] },
  { id: "red", label: "Red", buttons: "UP + A", combination: [3, 28, 4] },
  { id: "dark-brown", label: "Dark Brown", buttons: "UP + B", combination: [0, 0, 1] },
  { id: "pastel", label: "Pastel Mix", buttons: "DOWN", combination: [12, 12, 12] },
  { id: "orange", label: "Orange", buttons: "DOWN + A", combination: [24, 24, 24] },
  { id: "yellow", label: "Yellow", buttons: "DOWN + B", combination: [28, 3, 6] },
];

function rgb555Preview(value) {
  return [
    Math.round((value & 31) * 255 / 31),
    Math.round(((value >> 5) & 31) * 255 / 31),
    Math.round(((value >> 10) & 31) * 255 / 31),
  ];
}

export const CGB_COMPATIBILITY_PALETTES = Object.freeze([
  Object.freeze({ id: "auto", label: "Auto (cartridge)", buttons: "BOOT ROM", colors: [] }),
  ...CGB_MANUAL_PALETTES.map((palette) => Object.freeze({
    id: palette.id,
    label: palette.label,
    buttons: palette.buttons,
    colors: Object.freeze(CGB_COMPATIBILITY_COLORS[palette.combination[2]].map(rgb555Preview)),
  })),
]);

const NINTENDO_LOGO = [
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83,
  0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
  0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63,
  0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
];

function signed8(value) {
  return value < 0x80 ? value : value - 0x100;
}

function clamp16(value) {
  return value & 0xffff;
}

function cartridgeName(type) {
  const names = {
    0x00: "ROM",
    0x01: "MBC1",
    0x02: "MBC1 + RAM",
    0x03: "MBC1 + RAM + BATTERY",
    0x05: "MBC2",
    0x06: "MBC2 + BATTERY",
    0x08: "ROM + RAM",
    0x09: "ROM + RAM + BATTERY",
    0x0f: "MBC3 + TIMER + BATTERY",
    0x10: "MBC3 + TIMER + RAM + BATTERY",
    0x11: "MBC3",
    0x12: "MBC3 + RAM",
    0x13: "MBC3 + RAM + BATTERY",
    0x19: "MBC5",
    0x1a: "MBC5 + RAM",
    0x1b: "MBC5 + RAM + BATTERY",
    0x1c: "MBC5 + RUMBLE",
    0x1d: "MBC5 + RUMBLE + RAM",
    0x1e: "MBC5 + RUMBLE + RAM + BATTERY",
  };
  return names[type] || `Unsupported (0x${type.toString(16).padStart(2, "0")})`;
}

export class GameBoy {
  constructor(model = "dmg") {
    this.model = model;
    this.bootRom = null;
    this.rom = new Uint8Array(0x8000);
    this.romBanks = 2;
    this.vram = new Uint8Array(0x4000);
    this.wram = new Uint8Array(0x8000);
    this.eram = new Uint8Array(0x2000);
    this.oam = new Uint8Array(0xa0);
    this.hram = new Uint8Array(0x7f);
    this.io = new Uint8Array(0x80);
    this.bgPalette = new Uint8Array(0x40);
    this.objPalette = new Uint8Array(0x40);
    this.framebuffer = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
    this.framebuffer32 = new Uint32Array(this.framebuffer.buffer);
    this.lineBgColors = new Uint8Array(SCREEN_WIDTH);
    this.lineBgPriority = new Uint8Array(SCREEN_WIDTH);
    this.lineSprites = [];
    this.colorScratch = new Uint8Array(3);
    this.audioMix = new Float64Array(4);
    this.audioSamples = new Float32Array(4096);
    this.audioSampleCount = 0;
    this.audioRate = AUDIO_RATE;
    this.compatibilityPaletteId = "auto";
    this.capturedCompatibilityPalette = null;
    this.dmgBgPalette = DMG_GREEN_PALETTE.map((color) => [...color]);
    this.dmgObj0Palette = DMG_GREEN_PALETTE.map((color) => [...color]);
    this.dmgObj1Palette = DMG_GREEN_PALETTE.map((color) => [...color]);
    this.dmgPalette = this.dmgBgPalette;
    this.refreshPackedDmgPalettes();
    this.onFrame = null;
    this.onBatterySave = null;
    this.hasROM = false;
    this.reset();
  }

  setBootROM(input) {
    if (!input) {
      this.bootRom = null;
      return null;
    }
    const bytes = input instanceof Uint8Array ? input.slice() : new Uint8Array(input);
    const valid = this.model === "dmg"
      ? bytes.length === 0x100
      : bytes.length === 0x800 || bytes.length === 0x900;
    if (!valid) {
      const expected = this.model === "dmg"
        ? "256 bytes"
        : "2,048 bytes (compact) or 2,304 bytes (address-padded)";
      throw new Error(`${this.model.toUpperCase()} boot ROM must be ${expected}.`);
    }
    this.bootRom = bytes;
    return { model: this.model, size: bytes.length };
  }

  setAudioSampleRate(rate) {
    if (!Number.isFinite(rate)) return false;
    this.audioRate = Math.max(8000, Math.min(192000, Math.round(rate)));
    this.audioClock = 0;
    this.audioSampleCount = 0;
    this.refreshAudioSteps();
    return true;
  }

  readBootROM(address) {
    if (!this.bootEnabled || !this.bootRom) return null;
    if (address < 0x100) return this.bootRom[address];
    if (this.model === "cgb" && address >= 0x200 && address < 0x900) {
      const index = this.bootRom.length === 0x900 ? address : address - 0x100;
      return this.bootRom[index] ?? 0xff;
    }
    return null;
  }

  loadROM(input, batteryData = null) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 0x150) throw new Error("This file is too small to be a Game Boy cartridge.");
    let logoValid = true;
    for (let i = 0; i < NINTENDO_LOGO.length; i += 1) {
      if (bytes[0x104 + i] !== NINTENDO_LOGO[i]) logoValid = false;
    }
    let headerChecksum = 0;
    for (let i = 0x134; i <= 0x14c; i += 1) {
      headerChecksum = (headerChecksum - bytes[i] - 1) & 0xff;
    }

    this.rom = bytes.slice();
    this.romBanks = Math.max(2, Math.ceil(bytes.length / 0x4000));
    this.cartType = bytes[0x147];
    this.mapper =
      [0x01, 0x02, 0x03].includes(this.cartType) ? 1 :
      [0x05, 0x06].includes(this.cartType) ? 2 :
      [0x0f, 0x10, 0x11, 0x12, 0x13].includes(this.cartType) ? 3 :
      this.cartType >= 0x19 && this.cartType <= 0x1e ? 5 : 0;
    this.hasBattery = [0x03, 0x06, 0x09, 0x0f, 0x10, 0x13, 0x1b, 0x1e].includes(this.cartType);
    this.hasRTC = [0x0f, 0x10].includes(this.cartType);
    const ramCode = bytes[0x149];
    const ramSizes = { 0: 0, 1: 0x800, 2: 0x2000, 3: 0x8000, 4: 0x20000, 5: 0x10000 };
    const ramSize = this.mapper === 2 ? 0x200 : (ramSizes[ramCode] || 0);
    this.eram = new Uint8Array(ramSize || 0x2000);
    const batteryRam = batteryData && !(batteryData instanceof ArrayBuffer) && !ArrayBuffer.isView(batteryData)
      ? batteryData.ram
      : batteryData;
    if (batteryRam) this.eram.set(new Uint8Array(batteryRam).subarray(0, this.eram.length));

    const titleBytes = bytes.slice(0x134, (bytes[0x143] & 0x80) ? 0x13f : 0x144);
    this.title = Array.from(titleBytes)
      .filter((value) => value > 31 && value < 127)
      .map((value) => String.fromCharCode(value))
      .join("")
      .trim() || "UNTITLED";
    this.cgbCartridge = (bytes[0x143] & 0x80) !== 0;
    this.cgbOnly = bytes[0x143] === 0xc0;
    this.header = {
      title: this.title,
      cgb: this.cgbCartridge,
      cgbOnly: this.cgbOnly,
      mapper: cartridgeName(this.cartType),
      romSize: bytes.length,
      ramSize,
      battery: this.hasBattery,
      rtc: this.hasRTC,
      logoValid,
      checksumValid: headerChecksum === bytes[0x14d],
    };
    this.hasROM = true;
    this.reset();
    if (batteryData?.rtc && this.hasRTC) {
      this.rtc = { ...this.rtc, ...batteryData.rtc, last: Number(batteryData.rtc.last) || Date.now() };
    }
    return this.header;
  }

  setModel(model) {
    if (model !== "dmg" && model !== "cgb") return;
    this.model = model;
    if (this.hasROM) this.reset();
  }

  cgbRegistersAvailable() {
    return this.model === "cgb" && (this.cgbMode || this.bootEnabled);
  }

  reset() {
    const useBootRom = !!this.bootRom;
    this.cgbMode = this.model === "cgb" && !!this.cgbCartridge;
    this.bootEnabled = useBootRom;
    this.capturedCompatibilityPalette = null;
    this.dmgBgPalette = DMG_GREEN_PALETTE.map((color) => [...color]);
    this.dmgObj0Palette = DMG_GREEN_PALETTE.map((color) => [...color]);
    this.dmgObj1Palette = DMG_GREEN_PALETTE.map((color) => [...color]);
    this.dmgPalette = this.dmgBgPalette;
    this.refreshPackedDmgPalettes();
    this.doubleSpeed = false;
    this.speedSwitchArmed = false;
    this.speedSubcycle = 0;
    this.a = this.cgbMode ? 0x11 : 0x01;
    this.f = 0xb0;
    this.b = 0x00;
    this.c = 0x13;
    this.d = 0x00;
    this.e = 0xd8;
    this.h = 0x01;
    this.l = 0x4d;
    this.sp = 0xfffe;
    this.pc = 0x0100;
    this.ime = false;
    this.imeDelay = 0;
    this.halted = false;
    this.stopped = false;
    this.haltBug = false;
    this.ie = 0;
    this.iflag = 0xe1;
    this.joypad = 0xff;
    this.joypSelect = 0x30;
    this.divCounter = 0xabcc;
    this.tima = 0;
    this.tma = 0;
    this.tac = 0xf8;
    this.timerReload = 0;
    this.timerReloading = false;
    this.serialData = 0;
    this.serialControl = 0x7e;
    this.serialCycles = 0;
    this.serialOutput = "";
    this.vramBank = 0;
    this.wramBank = 1;
    this.romBank = 1;
    this.ramBank = 0;
    this.ramEnabled = false;
    this.mbc1Mode = 0;
    this.mbc1High = 0;
    this.rtcSelect = 0;
    this.rtcLatchValue = 0;
    this.rtc = { seconds: 0, minutes: 0, hours: 0, days: 0, halt: false, carry: false, last: Date.now() };
    this.dmaCycles = 0;
    this.dmaSource = 0;
    this.dmaIndex = 0;
    this.dmaSubcycle = 0;
    this.hdmaSource = 0;
    this.hdmaDestination = 0x8000;
    this.hdmaBlocks = 0;
    this.hdmaActive = false;
    this.bgPaletteIndex = 0;
    this.objPaletteIndex = 0;
    this.opri = this.cgbMode ? 0 : 1;
    this.ppuDot = 0;
    this.ly = 0;
    this.ppuMode = 2;
    this.ppuMode3End = 252;
    this.statSignal = false;
    this.windowLine = 0;
    this.frameReady = false;
    this.frameNumber = 0;
    this.runFrameCalls = 0;
    this.cycles = 0;
    this.batteryDirty = false;
    this.io.fill(0);
    this.vram.fill(0);
    this.wram.fill(0);
    this.oam.fill(0);
    this.hram.fill(0);
    this.bgPalette.fill(0xff);
    this.objPalette.fill(0xff);
    this.framebuffer.fill(0xff);
    if (this.model === "cgb" && !this.cgbCartridge) this.applyCompatibilityPalette();
    this.io[0x40] = 0x91;
    this.io[0x41] = 0x80;
    this.io[0x42] = 0;
    this.io[0x43] = 0;
    this.io[0x45] = 0;
    this.io[0x47] = 0xfc;
    this.io[0x48] = 0xff;
    this.io[0x49] = 0xff;
    this.io[0x4a] = 0;
    this.io[0x4b] = 0;
    this.io[0x26] = 0xf1;
    this.io[0x24] = 0x77;
    this.io[0x25] = 0xf3;
    this.apuReset();
    if (useBootRom) {
      this.a = 0;
      this.f = 0;
      this.b = 0;
      this.c = 0;
      this.d = 0;
      this.e = 0;
      this.h = 0;
      this.l = 0;
      this.sp = 0;
      this.pc = 0;
      this.ime = false;
      this.imeDelay = 0;
      this.ie = 0;
      this.iflag = 0xe0;
      this.divCounter = 0;
      this.io.fill(0);
      this.io[0x41] = 0x80;
      this.ppuMode = 0;
      this.statSignal = false;
    }
    this.updateStat();
  }

  compatibilityPalette() {
    if (this.compatibilityPaletteId !== "auto") {
      return CGB_MANUAL_PALETTES.find((palette) => palette.id === this.compatibilityPaletteId)?.combination
        ?? [4, 4, 29];
    }
    // The production CGB boot ROM maps Tetris to the orange combination.
    if (this.title === "TETRIS") return [24, 24, 24];
    return [4, 4, 29];
  }

  setCompatibilityPalette(id) {
    if (id !== "auto" && !CGB_MANUAL_PALETTES.some((palette) => palette.id === id)) return false;
    this.compatibilityPaletteId = id;
    if (this.model === "cgb" && !this.cgbCartridge) this.applyCompatibilityPalette();
    return true;
  }

  writeCompatibilityPalette(target, paletteIndex) {
    const palette = CGB_COMPATIBILITY_COLORS[paletteIndex] ?? CGB_COMPATIBILITY_COLORS[0];
    for (let color = 0; color < 4; color += 1) {
      target[color * 2] = palette[color] & 0xff;
      target[color * 2 + 1] = palette[color] >> 8;
    }
  }

  captureCompatibilityPalettes() {
    this.capturedCompatibilityPalette = {
      bg: this.bgPalette.slice(0, 8),
      obj0: this.objPalette.slice(0, 8),
      obj1: this.objPalette.slice(8, 16),
    };
  }

  updateCompatibilityPaletteAliases() {
    const convert = (memory, palette) => [0, 1, 2, 3]
      .map((color) => Array.from(this.cgbColor(memory, palette, color)));
    this.dmgBgPalette = convert(this.bgPalette, 0);
    this.dmgObj0Palette = convert(this.objPalette, 0);
    this.dmgObj1Palette = convert(this.objPalette, 1);
    this.dmgPalette = this.dmgBgPalette;
    this.refreshPackedDmgPalettes();
  }

  refreshPackedDmgPalettes() {
    this.dmgBgPalettePacked = packPalette(this.dmgBgPalette);
    this.dmgObj0PalettePacked = packPalette(this.dmgObj0Palette);
    this.dmgObj1PalettePacked = packPalette(this.dmgObj1Palette);
    this.dmgPalettePacked = this.dmgBgPalettePacked;
  }

  applyCompatibilityPalette() {
    if (
      this.compatibilityPaletteId === "auto" &&
      this.capturedCompatibilityPalette
    ) {
      this.bgPalette.set(this.capturedCompatibilityPalette.bg, 0);
      this.objPalette.set(this.capturedCompatibilityPalette.obj0, 0);
      this.objPalette.set(this.capturedCompatibilityPalette.obj1, 8);
    } else {
      const [obj0, obj1, bg] = this.compatibilityPalette();
      this.writeCompatibilityPalette(this.bgPalette.subarray(0, 8), bg);
      this.writeCompatibilityPalette(this.objPalette.subarray(0, 8), obj0);
      this.writeCompatibilityPalette(this.objPalette.subarray(8, 16), obj1);
    }
    this.updateCompatibilityPaletteAliases();
  }

  apuReset() {
    this.audioSampleCount = 0;
    this.audioClock = 0;
    this.audioFrameStep = 0;
    this.ch1 = {
      enabled: false,
      phase: 0,
      length: 0,
      volume: 0,
      envCounter: 0,
      envRunning: false,
      sweepCounter: 0,
      sweepEnabled: false,
      sweepNegated: false,
      shadow: 0,
      phaseStep: 0,
    };
    this.ch2 = {
      enabled: false,
      phase: 0,
      length: 0,
      volume: 0,
      envCounter: 0,
      envRunning: false,
      phaseStep: 0,
    };
    this.ch3 = { enabled: false, phase: 0, phaseStep: 0, length: 0 };
    this.ch4 = {
      enabled: false,
      phase: 0,
      length: 0,
      volume: 0,
      envCounter: 0,
      envRunning: false,
      lfsr: 0x7fff,
      phaseStep: 0,
    };
  }

  getAF() { return (this.a << 8) | this.f; }
  getBC() { return (this.b << 8) | this.c; }
  getDE() { return (this.d << 8) | this.e; }
  getHL() { return (this.h << 8) | this.l; }
  setAF(value) { this.a = (value >> 8) & 0xff; this.f = value & 0xf0; }
  setBC(value) { this.b = (value >> 8) & 0xff; this.c = value & 0xff; }
  setDE(value) { this.d = (value >> 8) & 0xff; this.e = value & 0xff; }
  setHL(value) { this.h = (value >> 8) & 0xff; this.l = value & 0xff; }

  getPair(index) {
    return [this.getBC(), this.getDE(), this.getHL(), this.sp][index];
  }

  setPair(index, value) {
    value &= 0xffff;
    if (index === 0) this.setBC(value);
    else if (index === 1) this.setDE(value);
    else if (index === 2) this.setHL(value);
    else this.sp = value;
  }

  getStackPair(index) {
    return index === 3 ? this.getAF() : this.getPair(index);
  }

  setStackPair(index, value) {
    if (index === 3) this.setAF(value);
    else this.setPair(index, value);
  }

  fetch8() {
    const value = this.cpuRead(this.pc);
    if (!this.haltBug) this.pc = (this.pc + 1) & 0xffff;
    else this.haltBug = false;
    return value;
  }

  fetch16() {
    const low = this.fetch8();
    return low | (this.fetch8() << 8);
  }

  readReg(index) {
    if (index === 0) return this.b;
    if (index === 1) return this.c;
    if (index === 2) return this.d;
    if (index === 3) return this.e;
    if (index === 4) return this.h;
    if (index === 5) return this.l;
    if (index === 6) return this.cpuRead(this.getHL());
    return this.a;
  }

  writeReg(index, value) {
    value &= 0xff;
    if (index === 0) this.b = value;
    else if (index === 1) this.c = value;
    else if (index === 2) this.d = value;
    else if (index === 3) this.e = value;
    else if (index === 4) this.h = value;
    else if (index === 5) this.l = value;
    else if (index === 6) this.cpuWrite(this.getHL(), value);
    else this.a = value;
  }

  push16(value) {
    this.sp = (this.sp - 1) & 0xffff;
    this.cpuWrite(this.sp, value >> 8);
    this.sp = (this.sp - 1) & 0xffff;
    this.cpuWrite(this.sp, value);
  }

  pop16() {
    const low = this.cpuRead(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const high = this.cpuRead(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return low | (high << 8);
  }

  selectedRomBank0() {
    if (this.mapper !== 1 || this.mbc1Mode === 0) return 0;
    return ((this.mbc1High << 5) % this.romBanks) & ~0x1f;
  }

  selectedRomBank() {
    let bank = this.romBank;
    if (this.mapper === 1) {
      bank = (this.romBank & 0x1f) | (this.mbc1High << 5);
      if ((bank & 0x1f) === 0) bank += 1;
    }
    bank %= this.romBanks;
    return bank || (this.romBanks > 1 ? 1 : 0);
  }

  selectedRamBank() {
    if (this.mapper === 1) return this.mbc1Mode ? this.mbc1High : 0;
    return this.ramBank;
  }

  read8(address, direct = false) {
    address &= 0xffff;
    const bootValue = this.readBootROM(address);
    if (bootValue !== null) return bootValue;
    if (address < 0x4000) {
      const offset = this.selectedRomBank0() * 0x4000 + address;
      return this.rom[offset % this.rom.length] ?? 0xff;
    }
    if (address < 0x8000) {
      const offset = this.selectedRomBank() * 0x4000 + (address - 0x4000);
      return this.rom[offset % this.rom.length] ?? 0xff;
    }
    if (address < 0xa000) {
      if (!direct && (this.io[0x40] & 0x80) && this.ppuMode === 3) return 0xff;
      return this.vram[(this.vramBank * 0x2000) + address - 0x8000];
    }
    if (address < 0xc000) {
      if (!this.ramEnabled || this.eram.length === 0) return 0xff;
      if (this.mapper === 3 && this.rtcSelect >= 0x08 && this.rtcSelect <= 0x0c) {
        return this.readRTC(this.rtcSelect);
      }
      const offset = (this.selectedRamBank() * 0x2000 + address - 0xa000) % this.eram.length;
      return this.mapper === 2 ? 0xf0 | this.eram[offset] : this.eram[offset];
    }
    if (address < 0xd000) return this.wram[address - 0xc000];
    if (address < 0xe000) return this.wram[this.wramBank * 0x1000 + address - 0xd000];
    if (address < 0xfe00) return this.read8(address - 0x2000, direct);
    if (address < 0xfea0) {
      if (!direct && (this.dmaCycles > 0 || ((this.io[0x40] & 0x80) && (this.ppuMode === 2 || this.ppuMode === 3)))) return 0xff;
      return this.oam[address - 0xfe00];
    }
    if (address < 0xff00) return 0xff;
    if (address === 0xffff) return this.ie | 0xe0;
    if (address >= 0xff80) return this.hram[address - 0xff80];
    return this.readIO(address & 0x7f);
  }

  cpuRead(address) {
    const blocked = this.dmaCycles > 0 && address < 0xff80;
    const value = blocked ? 0xff : this.read8(address);
    this.tick(4);
    this.instructionTicks += 4;
    return value;
  }

  cpuWrite(address, value) {
    const blocked = this.dmaCycles > 0 && address < 0xff80 && address !== 0xff46;
    if (!blocked) this.write8(address, value);
    this.tick(4);
    this.instructionTicks += 4;
  }

  write8(address, value, direct = false) {
    address &= 0xffff;
    value &= 0xff;
    if (address < 0x8000) {
      this.writeMapper(address, value);
      return;
    }
    if (address < 0xa000) {
      if (direct || !(this.io[0x40] & 0x80) || this.ppuMode !== 3) {
        this.vram[this.vramBank * 0x2000 + address - 0x8000] = value;
      }
      return;
    }
    if (address < 0xc000) {
      if (!this.ramEnabled || this.eram.length === 0) return;
      if (this.mapper === 3 && this.rtcSelect >= 0x08 && this.rtcSelect <= 0x0c) {
        this.writeRTC(this.rtcSelect, value);
      } else {
        const offset = (this.selectedRamBank() * 0x2000 + address - 0xa000) % this.eram.length;
        this.eram[offset] = this.mapper === 2 ? value & 0x0f : value;
        if (this.hasBattery) this.batteryDirty = true;
      }
      return;
    }
    if (address < 0xd000) {
      this.wram[address - 0xc000] = value;
      return;
    }
    if (address < 0xe000) {
      this.wram[this.wramBank * 0x1000 + address - 0xd000] = value;
      return;
    }
    if (address < 0xfe00) {
      this.write8(address - 0x2000, value, direct);
      return;
    }
    if (address < 0xfea0) {
      if (direct || (!(this.dmaCycles > 0) && (!(this.io[0x40] & 0x80) || (this.ppuMode !== 2 && this.ppuMode !== 3)))) {
        this.oam[address - 0xfe00] = value;
      }
      return;
    }
    if (address < 0xff00) return;
    if (address === 0xffff) {
      this.ie = value & 0x1f;
      return;
    }
    if (address >= 0xff80) {
      this.hram[address - 0xff80] = value;
      return;
    }
    this.writeIO(address & 0x7f, value);
  }

  writeMapper(address, value) {
    if (this.mapper === 0) return;
    if (this.mapper === 1) {
      if (address < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
      else if (address < 0x4000) this.romBank = value & 0x1f || 1;
      else if (address < 0x6000) this.mbc1High = value & 0x03;
      else this.mbc1Mode = value & 1;
    } else if (this.mapper === 2) {
      if (address < 0x4000) {
        if (address & 0x0100) this.romBank = value & 0x0f || 1;
        else this.ramEnabled = (value & 0x0f) === 0x0a;
      }
    } else if (this.mapper === 3) {
      if (address < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
      else if (address < 0x4000) this.romBank = value & 0x7f || 1;
      else if (address < 0x6000) {
        this.ramBank = value & 0x03;
        this.rtcSelect = value;
      } else {
        if (this.rtcLatchValue === 0 && value === 1) this.latchRTC();
        this.rtcLatchValue = value;
      }
    } else if (this.mapper === 5) {
      if (address < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
      else if (address < 0x3000) this.romBank = (this.romBank & 0x100) | value;
      else if (address < 0x4000) this.romBank = (this.romBank & 0xff) | ((value & 1) << 8);
      else if (address < 0x6000) this.ramBank = value & 0x0f;
    }
  }

  readIO(register) {
    if (register === 0x00) return this.readJoypad();
    if (register === 0x01) return this.serialData;
    if (register === 0x02) return this.serialControl | 0x7c;
    if (register === 0x04) return (this.divCounter >> 8) & 0xff;
    if (register === 0x05) return this.tima;
    if (register === 0x06) return this.tma;
    if (register === 0x07) return this.tac | 0xf8;
    if (register === 0x0f) return this.iflag | 0xe0;
    if (register === 0x41) {
      const displayLy = this.displayLy();
      return (this.io[0x41] & 0xf8) | (displayLy === this.io[0x45] ? 4 : 0) | ((this.io[0x40] & 0x80) ? this.ppuMode : 0);
    }
    if (register === 0x44) return this.displayLy();
    if (register === 0x4d) return (this.doubleSpeed ? 0x80 : 0) | (this.speedSwitchArmed ? 1 : 0) | 0x7e;
    if (register === 0x4f) return this.cgbRegistersAvailable() ? 0xfe | this.vramBank : 0xff;
    if (register === 0x50) return this.bootEnabled ? 0x00 : 0xff;
    if (register === 0x55) return this.cgbRegistersAvailable()
      ? (this.hdmaActive ? 0 : 0x80) | Math.max(0, this.hdmaBlocks - 1)
      : 0xff;
    if (register === 0x68) return this.cgbRegistersAvailable() ? this.bgPaletteIndex | 0x40 : 0xff;
    if (register === 0x69) return !this.cgbRegistersAvailable() || this.ppuMode === 3
      ? 0xff
      : this.bgPalette[this.bgPaletteIndex & 0x3f];
    if (register === 0x6a) return this.cgbRegistersAvailable() ? this.objPaletteIndex | 0x40 : 0xff;
    if (register === 0x6b) return !this.cgbRegistersAvailable() || this.ppuMode === 3
      ? 0xff
      : this.objPalette[this.objPaletteIndex & 0x3f];
    if (register === 0x6c) return this.cgbRegistersAvailable() ? 0xfe | this.opri : 0xff;
    if (register === 0x70) return this.cgbRegistersAvailable() ? 0xf8 | this.wramBank : 0xff;
    if (register >= 0x10 && register <= 0x3f) return this.readAPU(register);
    return this.io[register] ?? 0xff;
  }

  writeIO(register, value) {
    if (register === 0x00) {
      const before = this.readJoypad();
      this.joypSelect = value & 0x30;
      if ((before & 0x0f) === 0x0f && (this.readJoypad() & 0x0f) !== 0x0f) this.requestInterrupt(4);
      return;
    }
    if (register === 0x01) { this.serialData = value; return; }
    if (register === 0x02) {
      this.serialControl = value;
      if ((value & 0x81) === 0x81) this.serialCycles = this.cgbMode && (value & 2) ? 128 : 4096;
      return;
    }
    if (register === 0x04) {
      const before = this.timerSignal();
      const apuBefore = this.apuDividerSignal();
      this.divCounter = 0;
      if (before && !this.timerSignal()) this.incrementTima();
      if (apuBefore && !this.apuDividerSignal()) this.clockAPUFrameSequencer();
      return;
    }
    if (register === 0x05) {
      if (this.timerReload === 1) return;
      this.tima = value;
      if (this.timerReload > 1) this.timerReload = 0;
      return;
    }
    if (register === 0x06) {
      this.tma = value;
      if (this.timerReload === 1) this.tima = value;
      return;
    }
    if (register === 0x07) {
      const before = this.timerSignal();
      this.tac = value & 0x07;
      if (before && !this.timerSignal()) this.incrementTima();
      return;
    }
    if (register === 0x0f) { this.iflag = value & 0x1f; return; }
    if (register >= 0x10 && register <= 0x3f) {
      this.writeAPU(register, value);
      return;
    }
    if (register === 0x40) {
      const wasEnabled = !!(this.io[0x40] & 0x80);
      this.io[0x40] = value;
      const enabled = !!(value & 0x80);
      if (wasEnabled && !enabled) {
        this.ly = 0;
        this.ppuDot = 0;
        this.ppuMode = 0;
        this.windowLine = 0;
        this.statSignal = false;
      } else if (!wasEnabled && enabled) {
        this.ly = 0;
        this.ppuDot = 0;
        this.ppuMode = 2;
        this.windowLine = 0;
      }
      this.updateStat();
      return;
    }
    if (register === 0x41) {
      if (this.model === "dmg" && (this.ppuMode !== 3 || this.displayLy() === this.io[0x45])) {
        this.requestInterrupt(1);
      }
      this.io[0x41] = (value & 0x78) | 0x80;
      this.updateStat();
      return;
    }
    if (register === 0x44) return;
    if (register === 0x45) {
      this.io[0x45] = value;
      this.updateStat();
      return;
    }
    if (register === 0x46) {
      this.io[0x46] = value;
      this.dmaSource = value << 8;
      this.dmaCycles = 640;
      this.dmaIndex = 0;
      this.dmaSubcycle = 0;
      return;
    }
    if (register === 0x4d) {
      if (this.model === "cgb") this.speedSwitchArmed = !!(value & 1);
      return;
    }
    if (register === 0x4f) {
      if (this.cgbRegistersAvailable()) this.vramBank = value & 1;
      return;
    }
    if (register === 0x50) {
      if (value !== 0 && this.bootEnabled) {
        if (this.model === "cgb" && !this.cgbCartridge) this.captureCompatibilityPalettes();
        this.bootEnabled = false;
        if (this.model === "cgb" && !this.cgbCartridge) {
          if (this.compatibilityPaletteId !== "auto") this.applyCompatibilityPalette();
          else this.updateCompatibilityPaletteAliases();
        }
      }
      this.io[0x50] = value;
      return;
    }
    if (register >= 0x51 && register <= 0x55) {
      if (this.cgbRegistersAvailable()) this.writeHDMA(register, value);
      return;
    }
    if (register === 0x68) { if (this.cgbRegistersAvailable()) this.bgPaletteIndex = value & 0xbf; return; }
    if (register === 0x69) {
      if (this.cgbRegistersAvailable() && this.ppuMode !== 3) {
        this.bgPalette[this.bgPaletteIndex & 0x3f] = value;
        if (this.bgPaletteIndex & 0x80) this.bgPaletteIndex = 0x80 | ((this.bgPaletteIndex + 1) & 0x3f);
      }
      return;
    }
    if (register === 0x6a) { if (this.cgbRegistersAvailable()) this.objPaletteIndex = value & 0xbf; return; }
    if (register === 0x6b) {
      if (this.cgbRegistersAvailable() && this.ppuMode !== 3) {
        this.objPalette[this.objPaletteIndex & 0x3f] = value;
        if (this.objPaletteIndex & 0x80) this.objPaletteIndex = 0x80 | ((this.objPaletteIndex + 1) & 0x3f);
      }
      return;
    }
    if (register === 0x6c) { if (this.cgbRegistersAvailable()) this.opri = value & 1; return; }
    if (register === 0x70) { if (this.cgbRegistersAvailable()) this.wramBank = value & 7 || 1; return; }
    this.io[register] = value;
  }

  readJoypad() {
    let lower = 0x0f;
    if (!(this.joypSelect & 0x10)) lower &= this.joypad & 0x0f;
    if (!(this.joypSelect & 0x20)) lower &= (this.joypad >> 4) & 0x0f;
    return 0xc0 | this.joypSelect | lower;
  }

  setButton(button, pressed) {
    const bits = { right: 0, left: 1, up: 2, down: 3, a: 4, b: 5, select: 6, start: 7 };
    const bit = bits[button];
    if (bit === undefined) return;
    const before = this.joypad;
    if (pressed) this.joypad &= ~(1 << bit);
    else this.joypad |= 1 << bit;
    if ((before & (1 << bit)) && !(this.joypad & (1 << bit))) {
      this.requestInterrupt(4);
      this.stopped = false;
    }
  }

  requestInterrupt(bit) {
    this.iflag |= 1 << bit;
  }

  timerSignal() {
    if (!(this.tac & 4)) return false;
    const bits = [9, 3, 5, 7];
    return !!(this.divCounter & (1 << bits[this.tac & 3]));
  }

  apuDividerSignal() {
    return !!(this.divCounter & (1 << (this.doubleSpeed ? 13 : 12)));
  }

  incrementTima() {
    if (this.timerReload) return;
    if (this.tima === 0xff) {
      this.tima = 0;
      this.timerReload = 4;
    } else this.tima = (this.tima + 1) & 0xff;
  }

  tick(cycles) {
    for (let i = 0; i < cycles; i += 1) {
      if (!this.stopped) {
        const before = this.timerSignal();
        const apuBefore = this.apuDividerSignal();
        this.divCounter = (this.divCounter + 1) & 0xffff;
        if (before && !this.timerSignal()) this.incrementTima();
        if (apuBefore && !this.apuDividerSignal()) this.clockAPUFrameSequencer();
      }
      if (this.timerReload > 0) {
        this.timerReload -= 1;
        if (this.timerReload === 0) {
          this.timerReloading = true;
          this.tima = this.tma;
          this.requestInterrupt(2);
          this.timerReloading = false;
        }
      }
      if (this.serialCycles > 0) {
        this.serialCycles -= 1;
        if (this.serialCycles === 0) {
          this.serialOutput += String.fromCharCode(this.serialData);
          this.serialData = 0xff;
          this.serialControl &= 0x7f;
          this.requestInterrupt(3);
        }
      }
      if (this.dmaCycles > 0) {
        this.dmaCycles -= 1;
        this.dmaSubcycle += 1;
        if (this.dmaSubcycle >= 4) {
          this.dmaSubcycle = 0;
          if (this.dmaIndex < 0xa0) {
            this.oam[this.dmaIndex] = this.read8(this.dmaSource + this.dmaIndex, true);
            this.dmaIndex += 1;
          }
        }
      }
      // In CGB double-speed mode the CPU, divider, serial unit, and OAM DMA
      // receive two clocks per PPU/APU dot. Keeping the base-clock domains
      // separate fixes half-speed video and pitched-up audio after KEY1/STOP.
      this.speedSubcycle = (this.speedSubcycle + 1) & 1;
      if (!this.doubleSpeed || this.speedSubcycle === 0) {
        this.tickPPU();
        this.tickAPU();
      }
      this.cycles += 1;
    }
  }

  displayLy() {
    return this.ly === 153 && this.ppuDot >= 4 ? 0 : this.ly;
  }

  tickPPU() {
    if (!(this.io[0x40] & 0x80)) return;
    this.ppuDot += 1;
    if (this.ly < 144 && this.ppuDot === 1) this.ppuMode3End = this.calculateMode3End(this.ly);

    let newMode = this.ppuMode;
    if (this.ly >= 144) newMode = 1;
    else if (this.ppuDot < 80) newMode = 2;
    else if (this.ppuDot < this.ppuMode3End) newMode = 3;
    else newMode = 0;

    if (newMode !== this.ppuMode) {
      const previous = this.ppuMode;
      this.ppuMode = newMode;
      if (previous === 3 && newMode === 0 && this.ly < 144) {
        this.renderLine(this.ly);
        if (this.hdmaActive) this.transferHDMABlock();
      }
      this.updateStat();
    }

    if (this.ppuDot >= 456) {
      this.ppuDot = 0;
      this.ly += 1;
      if (this.ly === 144) {
        this.ppuMode = 1;
        this.requestInterrupt(0);
        this.frameReady = true;
        this.frameNumber += 1;
        if (this.onFrame) this.onFrame(this.framebuffer);
      } else if (this.ly > 153) {
        this.ly = 0;
        this.ppuMode = 2;
        this.windowLine = 0;
      } else if (this.ly < 144) {
        this.ppuMode = 2;
      }
      this.updateStat();
    } else if (this.ly === 153 && this.ppuDot === 4) {
      this.updateStat();
    }
  }

  updateStat() {
    if (!(this.io[0x40] & 0x80)) {
      this.statSignal = false;
      return;
    }
    const stat = this.io[0x41];
    const signal =
      ((this.displayLy() === this.io[0x45]) && !!(stat & 0x40)) ||
      (this.ppuMode === 2 && !!(stat & 0x20)) ||
      (this.ppuMode === 1 && !!(stat & 0x10)) ||
      (this.ppuMode === 0 && !!(stat & 0x08));
    if (signal && !this.statSignal) this.requestInterrupt(1);
    this.statSignal = signal;
  }

  calculateMode3End(line) {
    const lcdc = this.io[0x40];
    let selected = 0;
    let visibleSprites = 0;
    if (lcdc & 0x02) {
      const spriteHeight = lcdc & 0x04 ? 16 : 8;
      for (let index = 0; index < 40 && selected < 10; index += 1) {
        const y = this.oam[index * 4] - 16;
        if (line < y || line >= y + spriteHeight) continue;
        selected += 1;
        const x = this.oam[index * 4 + 1];
        if (x > 0 && x < 168) visibleSprites += 1;
      }
    }
    const windowStarts = !!(lcdc & 0x20)
      && line >= this.io[0x4a]
      && this.io[0x4b] <= 166;
    // The exact FIFO penalty depends on alignment and fetch collisions. This
    // bounded model preserves the documented 172-dot baseline, SCX discard,
    // window restart, and per-object stalls instead of the old fixed Mode 3.
    return Math.min(369, 252 + (this.io[0x43] & 7) + visibleSprites * 6 + (windowStarts ? 6 : 0));
  }

  renderLine(line) {
    const lcdc = this.io[0x40];
    const cgbRendering = this.cgbMode || (this.model === "cgb" && this.bootEnabled);
    const cgbCompatibility = this.model === "cgb" && !cgbRendering;
    const scrollY = this.io[0x42];
    const scrollX = this.io[0x43];
    const windowY = this.io[0x4a];
    const windowX = this.io[0x4b] - 7;
    const bgEnabled = cgbRendering || !!(lcdc & 1);
    const windowEnabled = bgEnabled && !!(lcdc & 0x20) && line >= windowY && windowX < 160;
    const bgColors = this.lineBgColors;
    const bgPriority = this.lineBgPriority;
    bgColors.fill(0);
    bgPriority.fill(0);

    for (let x = 0; x < 160; x += 1) {
      let colorIndex = 0;
      let palette = 0;
      let priority = 0;
      let useWindow = false;
      if (bgEnabled) {
        useWindow = windowEnabled && x >= Math.max(0, windowX);
        const pixelX = useWindow ? x - windowX : (x + scrollX) & 0xff;
        const pixelY = useWindow ? this.windowLine : (line + scrollY) & 0xff;
        const mapBase = useWindow ? ((lcdc & 0x40) ? 0x1c00 : 0x1800) : ((lcdc & 0x08) ? 0x1c00 : 0x1800);
        const mapOffset = mapBase + ((pixelY >> 3) * 32) + (pixelX >> 3);
        const tileNumber = this.vram[mapOffset];
        const attr = cgbRendering ? this.vram[0x2000 + mapOffset] : 0;
        let tileX = pixelX & 7;
        let tileY = pixelY & 7;
        if (attr & 0x20) tileX = 7 - tileX;
        if (attr & 0x40) tileY = 7 - tileY;
        let tileAddress;
        if (lcdc & 0x10) tileAddress = tileNumber * 16;
        else tileAddress = 0x1000 + signed8(tileNumber) * 16;
        const bank = cgbRendering && (attr & 0x08) ? 0x2000 : 0;
        const low = this.vram[bank + tileAddress + tileY * 2];
        const high = this.vram[bank + tileAddress + tileY * 2 + 1];
        const bit = 7 - tileX;
        colorIndex = ((high >> bit) & 1) * 2 + ((low >> bit) & 1);
        palette = attr & 7;
        priority = (attr >> 7) & 1;
      }
      bgColors[x] = colorIndex;
      bgPriority[x] = priority;
      const packedColor = cgbRendering
        ? this.cgbPackedColor(this.bgPalette, palette, colorIndex)
        : cgbCompatibility
          ? this.cgbCompatibilityPackedColor(this.bgPalette, 0, this.io[0x47], colorIndex)
          : this.dmgPackedColor(this.io[0x47], colorIndex, this.dmgBgPalettePacked);
      this.setPackedPixel(x, line, packedColor);
    }

    if (windowEnabled && Math.max(0, windowX) < 160) this.windowLine += 1;
    if (!(lcdc & 0x02)) return;

    const spriteHeight = lcdc & 0x04 ? 16 : 8;
    const sprites = this.lineSprites;
    sprites.length = 0;
    for (let i = 0; i < 40 && sprites.length < 10; i += 1) {
      const y = this.oam[i * 4] - 16;
      if (line >= y && line < y + spriteHeight) {
        sprites.push({ index: i, y, x: this.oam[i * 4 + 1] - 8, tile: this.oam[i * 4 + 2], attr: this.oam[i * 4 + 3] });
      }
    }
    if (!cgbRendering || this.opri) sprites.sort((left, right) => left.x - right.x || left.index - right.index);

    for (let x = 0; x < 160; x += 1) {
      for (const sprite of sprites) {
        if (x < sprite.x || x >= sprite.x + 8) continue;
        let tileX = x - sprite.x;
        let tileY = line - sprite.y;
        if (sprite.attr & 0x20) tileX = 7 - tileX;
        if (sprite.attr & 0x40) tileY = spriteHeight - 1 - tileY;
        let tile = sprite.tile;
        if (spriteHeight === 16) tile = (tile & 0xfe) + (tileY >= 8 ? 1 : 0);
        tileY &= 7;
        const bank = cgbRendering && (sprite.attr & 0x08) ? 0x2000 : 0;
        const low = this.vram[bank + tile * 16 + tileY * 2];
        const high = this.vram[bank + tile * 16 + tileY * 2 + 1];
        const bit = 7 - tileX;
        const colorIndex = ((high >> bit) & 1) * 2 + ((low >> bit) & 1);
        if (colorIndex === 0) continue;

        const bgOpaque = bgColors[x] !== 0;
        const bgMasterPriority = !!(lcdc & 1);
        const hiddenByBg = cgbRendering
          ? bgMasterPriority && bgOpaque && (bgPriority[x] || (sprite.attr & 0x80))
          : bgOpaque && !!(sprite.attr & 0x80);
        if (!hiddenByBg) {
          const objectPalette = (sprite.attr & 0x10) ? 1 : 0;
          const objectRegister = this.io[objectPalette ? 0x49 : 0x48];
          const packedColor = cgbRendering
            ? this.cgbPackedColor(this.objPalette, sprite.attr & 7, colorIndex)
            : cgbCompatibility
              ? this.cgbCompatibilityPackedColor(
                  this.objPalette,
                  objectPalette,
                  objectRegister,
                  colorIndex,
                )
              : this.dmgPackedColor(
                  objectRegister,
                  colorIndex,
                  objectPalette ? this.dmgObj1PalettePacked : this.dmgObj0PalettePacked,
                );
          this.setPackedPixel(x, line, packedColor);
        }
        break;
      }
    }
  }

  dmgColor(register, colorIndex, palette = this.dmgPalette) {
    return palette[(register >> (colorIndex * 2)) & 3];
  }

  dmgPackedColor(register, colorIndex, palette = this.dmgPalettePacked) {
    return palette[(register >> (colorIndex * 2)) & 3];
  }

  cgbCompatibilityColor(memory, palette, register, colorIndex) {
    const mappedColor = (register >> (colorIndex * 2)) & 3;
    return this.cgbColor(memory, palette, mappedColor);
  }

  cgbCompatibilityPackedColor(memory, palette, register, colorIndex) {
    const mappedColor = (register >> (colorIndex * 2)) & 3;
    return this.cgbPackedColor(memory, palette, mappedColor);
  }

  cgbColor(memory, palette, colorIndex) {
    const offset = palette * 8 + colorIndex * 2;
    const value = memory[offset] | (memory[offset + 1] << 8);
    const lutOffset = (value & 0x7fff) * 3;
    this.colorScratch[0] = CGB_COLOR_LUT[lutOffset];
    this.colorScratch[1] = CGB_COLOR_LUT[lutOffset + 1];
    this.colorScratch[2] = CGB_COLOR_LUT[lutOffset + 2];
    return this.colorScratch;
  }

  cgbPackedColor(memory, palette, colorIndex) {
    const offset = palette * 8 + colorIndex * 2;
    return CGB_COLOR_LUT_PACKED[
      (memory[offset] | (memory[offset + 1] << 8)) & 0x7fff
    ];
  }

  setPixel(x, y, rgb) {
    const offset = (y * 160 + x) * 4;
    this.framebuffer[offset] = rgb[0];
    this.framebuffer[offset + 1] = rgb[1];
    this.framebuffer[offset + 2] = rgb[2];
    this.framebuffer[offset + 3] = 255;
  }

  setPackedPixel(x, y, color) {
    this.framebuffer32[y * SCREEN_WIDTH + x] = color;
  }

  writeHDMA(register, value) {
    if (!this.cgbRegistersAvailable()) return;
    this.io[register] = value;
    if (register < 0x55) return;
    if (this.hdmaActive && !(value & 0x80)) {
      this.hdmaActive = false;
      return;
    }
    this.hdmaSource = ((this.io[0x51] << 8) | (this.io[0x52] & 0xf0)) & 0xfff0;
    this.hdmaDestination = 0x8000 | (((this.io[0x53] & 0x1f) << 8) | (this.io[0x54] & 0xf0));
    this.hdmaBlocks = (value & 0x7f) + 1;
    if (value & 0x80) this.hdmaActive = true;
    else {
      while (this.hdmaBlocks > 0) this.transferHDMABlock();
    }
  }

  transferHDMABlock() {
    if (this.hdmaBlocks <= 0) {
      this.hdmaActive = false;
      return;
    }
    for (let i = 0; i < 0x10; i += 1) {
      const source = (this.hdmaSource + i) & 0xffff;
      const destination = 0x8000 | ((this.hdmaDestination + i - 0x8000) & 0x1fff);
      this.write8(destination, this.read8(source, true), true);
    }
    this.hdmaSource = (this.hdmaSource + 0x10) & 0xffff;
    this.hdmaDestination = 0x8000 | ((this.hdmaDestination + 0x10 - 0x8000) & 0x1fff);
    this.hdmaBlocks -= 1;
    if (this.hdmaBlocks <= 0) this.hdmaActive = false;
  }

  updateRTC() {
    if (this.rtc.halt) return;
    const now = Date.now();
    let elapsed = Math.floor((now - this.rtc.last) / 1000);
    if (elapsed <= 0) return;
    this.rtc.last += elapsed * 1000;
    let total = this.rtc.seconds + this.rtc.minutes * 60 + this.rtc.hours * 3600 + this.rtc.days * 86400 + elapsed;
    this.rtc.days = Math.floor(total / 86400);
    total %= 86400;
    this.rtc.hours = Math.floor(total / 3600);
    total %= 3600;
    this.rtc.minutes = Math.floor(total / 60);
    this.rtc.seconds = total % 60;
    if (this.rtc.days > 511) {
      this.rtc.days %= 512;
      this.rtc.carry = true;
    }
  }

  latchRTC() {
    this.updateRTC();
    this.latchedRTC = { ...this.rtc };
  }

  readRTC(register) {
    this.updateRTC();
    const rtc = this.latchedRTC || this.rtc;
    if (register === 0x08) return rtc.seconds;
    if (register === 0x09) return rtc.minutes;
    if (register === 0x0a) return rtc.hours;
    if (register === 0x0b) return rtc.days & 0xff;
    return ((rtc.days >> 8) & 1) | (rtc.halt ? 0x40 : 0) | (rtc.carry ? 0x80 : 0);
  }

  writeRTC(register, value) {
    this.updateRTC();
    if (register === 0x08) this.rtc.seconds = value % 60;
    else if (register === 0x09) this.rtc.minutes = value % 60;
    else if (register === 0x0a) this.rtc.hours = value % 24;
    else if (register === 0x0b) this.rtc.days = (this.rtc.days & 0x100) | value;
    else {
      this.rtc.days = (this.rtc.days & 0xff) | ((value & 1) << 8);
      this.rtc.halt = !!(value & 0x40);
      this.rtc.carry = !!(value & 0x80);
    }
    this.rtc.last = Date.now();
    this.batteryDirty = true;
  }

  readAPU(register) {
    if (register === 0x26) {
      return (this.io[0x26] & 0x80) | 0x70 |
        (this.ch1.enabled ? 1 : 0) | (this.ch2.enabled ? 2 : 0) |
        (this.ch3.enabled ? 4 : 0) | (this.ch4.enabled ? 8 : 0);
    }
    const masks = {
      0x10: 0x80, 0x11: 0x3f, 0x13: 0xff, 0x14: 0xbf,
      0x16: 0x3f, 0x18: 0xff, 0x19: 0xbf, 0x1a: 0x7f,
      0x1b: 0xff, 0x1c: 0x9f, 0x1d: 0xff, 0x1e: 0xbf,
      0x20: 0xff, 0x23: 0xbf,
    };
    return (this.io[register] || 0) | (masks[register] ?? 0);
  }

  writeAPU(register, value) {
    if (register === 0x26) {
      if (!(value & 0x80)) {
        for (let i = 0x10; i <= 0x25; i += 1) this.io[i] = 0;
        this.apuReset();
        this.io[0x26] = 0;
      } else {
        this.io[0x26] = 0x80;
        this.refreshAudioSteps();
      }
      return;
    }
    if (!(this.io[0x26] & 0x80) && register < 0x30) return;
    const previous = this.io[register];
    if (
      register === 0x10
      && this.ch1.sweepNegated
      && (previous & 0x08)
      && !(value & 0x08)
    ) {
      this.ch1.enabled = false;
    }
    this.io[register] = value;
    if (register === 0x13 || register === 0x14) {
      this.updateSquareStep(this.ch1, 0x13, 0x14);
    }
    if (register === 0x18 || register === 0x19) {
      this.updateSquareStep(this.ch2, 0x18, 0x19);
    }
    if (register === 0x1d || register === 0x1e) this.updateWaveStep();
    if (register === 0x22) this.updateNoiseStep();
    if (register === 0x11) this.ch1.length = 64 - (value & 0x3f);
    if (register === 0x16) this.ch2.length = 64 - (value & 0x3f);
    if (register === 0x1b) this.ch3.length = 256 - value;
    if (register === 0x20) this.ch4.length = 64 - (value & 0x3f);
    if (register === 0x12 && (value & 0xf8) === 0) this.ch1.enabled = false;
    if (register === 0x17 && (value & 0xf8) === 0) this.ch2.enabled = false;
    if (register === 0x1a && !(value & 0x80)) this.ch3.enabled = false;
    if (register === 0x21 && (value & 0xf8) === 0) this.ch4.enabled = false;
    if (register === 0x14) {
      if (value & 0x80) this.triggerSquare(this.ch1, 0x12);
      this.applyLengthControl(this.ch1, previous, value, 64, !!(value & 0x80));
    }
    if (register === 0x19) {
      if (value & 0x80) this.triggerSquare(this.ch2, 0x17);
      this.applyLengthControl(this.ch2, previous, value, 64, !!(value & 0x80));
    }
    if (register === 0x1e && (value & 0x80)) {
      this.ch3.enabled = !!(this.io[0x1a] & 0x80);
      if (this.ch3.length === 0) this.ch3.length = 256;
      this.ch3.phase = 0;
    }
    if (register === 0x1e) {
      this.applyLengthControl(this.ch3, previous, value, 256, !!(value & 0x80));
    }
    if (register === 0x23 && (value & 0x80)) {
      this.updateNoiseStep();
      this.ch4.enabled = (this.io[0x21] & 0xf8) !== 0;
      if (this.ch4.length === 0) this.ch4.length = 64;
      this.ch4.volume = this.io[0x21] >> 4;
      this.ch4.envCounter = (this.io[0x21] & 7) || 8;
      this.ch4.envRunning = (this.io[0x21] & 7) !== 0;
      this.ch4.lfsr = 0x7fff;
      this.ch4.phase = 0;
    }
    if (register === 0x23) {
      this.applyLengthControl(this.ch4, previous, value, 64, !!(value & 0x80));
    }
  }

  applyLengthControl(channel, previous, value, maximum, triggered) {
    const wasEnabled = !!(previous & 0x40);
    const enabled = !!(value & 0x40);
    // The frame-sequencer step stored here is the next step to run. Odd steps
    // do not clock length, so enabling length on one performs the hardware's
    // immediate extra clock.
    const nextStepDoesNotClockLength = (this.audioFrameStep & 1) === 1;
    if (!wasEnabled && enabled && nextStepDoesNotClockLength && channel.length > 0) {
      channel.length -= 1;
      if (channel.length === 0 && !triggered) channel.enabled = false;
    }
    // A trigger that reloads an expired length on the same odd sequencer phase
    // starts at max - 1 rather than max.
    if (triggered && enabled && nextStepDoesNotClockLength && channel.length === maximum) {
      channel.length = maximum - 1;
    }
  }

  triggerSquare(channel, envelopeRegister) {
    channel.enabled = (this.io[envelopeRegister] & 0xf8) !== 0;
    if (channel.length === 0) channel.length = 64;
    channel.volume = this.io[envelopeRegister] >> 4;
    channel.envCounter = (this.io[envelopeRegister] & 7) || 8;
    channel.envRunning = (this.io[envelopeRegister] & 7) !== 0;
    // Trigger resets the period timer but not the duty step counter.
    channel.phase = Math.floor(channel.phase * 8) / 8;
    if (channel === this.ch1) {
      channel.shadow = this.squareFrequency(0x13, 0x14);
      const pace = (this.io[0x10] >> 4) & 7;
      const shift = this.io[0x10] & 7;
      channel.sweepCounter = pace || 8;
      channel.sweepEnabled = pace !== 0 || shift !== 0;
      channel.sweepNegated = false;
      if (shift && this.calculateSweep() > 0x7ff) channel.enabled = false;
    }
  }

  squareFrequency(lowRegister, highRegister) {
    return this.io[lowRegister] | ((this.io[highRegister] & 7) << 8);
  }

  updateSquareStep(channel, lowRegister, highRegister) {
    if (!channel) return;
    const frequency = this.squareFrequency(lowRegister, highRegister);
    channel.phaseStep = 131072 / Math.max(1, 2048 - frequency) / this.audioRate;
  }

  updateWaveStep() {
    if (!this.ch3) return;
    const frequency = this.squareFrequency(0x1d, 0x1e);
    this.ch3.phaseStep = 65536 / Math.max(1, 2048 - frequency) / this.audioRate;
  }

  updateNoiseStep() {
    if (!this.ch4) return;
    const nr43 = this.io[0x22];
    const shift = nr43 >> 4;
    this.ch4.phaseStep = shift >= 14
      ? 0
      : 262144 / NOISE_DIVISORS[nr43 & 7] / (1 << shift) / this.audioRate;
  }

  refreshAudioSteps() {
    this.updateSquareStep(this.ch1, 0x13, 0x14);
    this.updateSquareStep(this.ch2, 0x18, 0x19);
    this.updateWaveStep();
    this.updateNoiseStep();
  }

  tickAPU() {
    if (!(this.io[0x26] & 0x80)) return;
    this.audioClock += this.audioRate;
    if (this.audioClock >= CPU_CLOCK) {
      this.audioClock -= CPU_CLOCK;
      this.mixAudioSample();
    }
  }

  clockAPUFrameSequencer() {
    if (!(this.io[0x26] & 0x80)) return;
    const step = this.audioFrameStep;
    if ((step & 1) === 0) this.clockLengths();
    if (step === 2 || step === 6) this.clockSweeps();
    if (step === 7) this.clockEnvelopes();
    this.audioFrameStep = (step + 1) & 7;
  }

  calculateSweep() {
    const shift = this.io[0x10] & 7;
    const delta = this.ch1.shadow >> shift;
    if (this.io[0x10] & 0x08) {
      this.ch1.sweepNegated = true;
      return this.ch1.shadow - delta;
    }
    return this.ch1.shadow + delta;
  }

  clockSweeps() {
    const channel = this.ch1;
    channel.sweepCounter -= 1;
    if (channel.sweepCounter > 0) return;
    const pace = (this.io[0x10] >> 4) & 7;
    channel.sweepCounter = pace || 8;
    if (!channel.sweepEnabled || pace === 0) return;
    const shift = this.io[0x10] & 7;
    const frequency = this.calculateSweep();
    if (frequency > 0x7ff) {
      channel.enabled = false;
      return;
    }
    if (shift === 0) return;
    channel.shadow = frequency;
    this.io[0x13] = frequency & 0xff;
    this.io[0x14] = (this.io[0x14] & 0xf8) | (frequency >> 8);
    this.updateSquareStep(this.ch1, 0x13, 0x14);
    if (this.calculateSweep() > 0x7ff) channel.enabled = false;
  }

  clockLengths() {
    const clocks = [
      [this.ch1, !!(this.io[0x14] & 0x40)],
      [this.ch2, !!(this.io[0x19] & 0x40)],
      [this.ch3, !!(this.io[0x1e] & 0x40)],
      [this.ch4, !!(this.io[0x23] & 0x40)],
    ];
    for (const [channel, enabled] of clocks) {
      if (enabled && channel.length > 0) {
        channel.length -= 1;
        if (channel.length === 0) channel.enabled = false;
      }
    }
  }

  clockEnvelopes() {
    const channels = [[this.ch1, 0x12], [this.ch2, 0x17], [this.ch4, 0x21]];
    for (const [channel, register] of channels) {
      const period = this.io[register] & 7;
      if (!channel.enabled || !channel.envRunning || period === 0) continue;
      channel.envCounter -= 1;
      if (channel.envCounter <= 0) {
        channel.envCounter = period;
        const delta = (this.io[register] & 8) ? 1 : -1;
        const volume = channel.volume + delta;
        if (volume >= 0 && volume <= 15) channel.volume = volume;
        else channel.envRunning = false;
      }
    }
  }

  mixAudioSample() {
    const outputs = this.audioMix;
    outputs[0] = 0;
    outputs[1] = 0;
    outputs[2] = 0;
    outputs[3] = 0;
    for (let index = 0; index < 2; index += 1) {
      const channel = index === 0 ? this.ch1 : this.ch2;
      const dutyRegister = index === 0 ? 0x11 : 0x16;
      if (!channel.enabled) continue;
      channel.phase = (channel.phase + channel.phaseStep) % 1;
      const duty = this.io[dutyRegister] >> 6;
      outputs[index] = (
        DUTY_PATTERNS[duty][Math.floor(channel.phase * 8)] ? 1 : -1
      ) * (channel.volume / 15);
    }

    if (this.ch3.enabled && (this.io[0x1a] & 0x80)) {
      this.ch3.phase = (this.ch3.phase + this.ch3.phaseStep) % 1;
      const wavePosition = Math.floor(this.ch3.phase * 32);
      const byte = this.io[0x30 + (wavePosition >> 1)];
      let sample = (wavePosition & 1) ? (byte & 0x0f) : (byte >> 4);
      const level = (this.io[0x1c] >> 5) & 3;
      sample = level === 0 ? 0 : sample >> (level - 1);
      outputs[2] = sample / 7.5 - 1;
    }

    if (this.ch4.enabled) {
      const nr43 = this.io[0x22];
      this.ch4.phase += this.ch4.phaseStep;
      let clocks = Math.floor(this.ch4.phase);
      this.ch4.phase -= clocks;
      const shortMode = !!(nr43 & 8);
      const step8 = shortMode ? NOISE_STEP_8_SHORT : NOISE_STEP_8_LONG;
      while (clocks >= 8) {
        this.ch4.lfsr = step8[this.ch4.lfsr];
        clocks -= 8;
      }
      while (clocks > 0) {
        const bit = (this.ch4.lfsr & 1) ^ ((this.ch4.lfsr >> 1) & 1);
        this.ch4.lfsr = (this.ch4.lfsr >> 1) | (bit << 14);
        if (shortMode) this.ch4.lfsr = (this.ch4.lfsr & ~(1 << 6)) | (bit << 6);
        clocks -= 1;
      }
      outputs[3] = ((~this.ch4.lfsr & 1) ? 1 : -1) * (this.ch4.volume / 15);
    }

    const routing = this.io[0x25];
    const volume = this.io[0x24];
    let left = 0;
    let right = 0;
    for (let i = 0; i < 4; i += 1) {
      if (routing & (1 << i)) right += outputs[i];
      if (routing & (1 << (i + 4))) left += outputs[i];
    }
    left *= (((volume >> 4) & 7) + 1) / 32;
    right *= ((volume & 7) + 1) / 32;
    if (this.audioSampleCount + 2 > this.audioSamples.length) {
      const maximum = this.audioRate * 4;
      if (this.audioSamples.length >= maximum) {
        const keep = Math.min(this.audioRate * 2, this.audioSampleCount) & ~1;
        this.audioSamples.copyWithin(0, this.audioSampleCount - keep, this.audioSampleCount);
        this.audioSampleCount = keep;
      } else {
        const capacity = Math.min(
          maximum,
          Math.max(this.audioSamples.length * 2, this.audioSampleCount + 2),
        );
        const expanded = new Float32Array(capacity);
        expanded.set(this.audioSamples.subarray(0, this.audioSampleCount));
        this.audioSamples = expanded;
      }
    }
    this.audioSamples[this.audioSampleCount] = Math.max(-1, Math.min(1, left));
    this.audioSamples[this.audioSampleCount + 1] = Math.max(-1, Math.min(1, right));
    this.audioSampleCount += 2;
  }

  drainAudio() {
    if (this.audioSampleCount === 0) return new Float32Array(0);
    const samples = this.audioSamples.slice(0, this.audioSampleCount);
    this.audioSampleCount = 0;
    return samples;
  }

  alu(operation, value) {
    let result;
    let carry;
    if (operation === 0) {
      result = this.a + value;
      this.f = ((result & 0xff) === 0 ? FLAG_Z : 0) | (((this.a & 0xf) + (value & 0xf) > 0xf) ? FLAG_H : 0) | (result > 0xff ? FLAG_C : 0);
      this.a = result & 0xff;
    } else if (operation === 1) {
      carry = (this.f & FLAG_C) ? 1 : 0;
      result = this.a + value + carry;
      this.f = ((result & 0xff) === 0 ? FLAG_Z : 0) | (((this.a & 0xf) + (value & 0xf) + carry > 0xf) ? FLAG_H : 0) | (result > 0xff ? FLAG_C : 0);
      this.a = result & 0xff;
    } else if (operation === 2) {
      result = this.a - value;
      this.f = ((result & 0xff) === 0 ? FLAG_Z : 0) | FLAG_N | ((this.a & 0xf) < (value & 0xf) ? FLAG_H : 0) | (this.a < value ? FLAG_C : 0);
      this.a = result & 0xff;
    } else if (operation === 3) {
      carry = (this.f & FLAG_C) ? 1 : 0;
      result = this.a - value - carry;
      this.f = ((result & 0xff) === 0 ? FLAG_Z : 0) | FLAG_N | ((this.a & 0xf) < ((value & 0xf) + carry) ? FLAG_H : 0) | (this.a < value + carry ? FLAG_C : 0);
      this.a = result & 0xff;
    } else if (operation === 4) {
      this.a &= value;
      this.f = (this.a === 0 ? FLAG_Z : 0) | FLAG_H;
    } else if (operation === 5) {
      this.a ^= value;
      this.f = this.a === 0 ? FLAG_Z : 0;
    } else if (operation === 6) {
      this.a |= value;
      this.f = this.a === 0 ? FLAG_Z : 0;
    } else {
      result = this.a - value;
      this.f = ((result & 0xff) === 0 ? FLAG_Z : 0) | FLAG_N | ((this.a & 0xf) < (value & 0xf) ? FLAG_H : 0) | (this.a < value ? FLAG_C : 0);
    }
  }

  condition(index) {
    if (index === 0) return !(this.f & FLAG_Z);
    if (index === 1) return !!(this.f & FLAG_Z);
    if (index === 2) return !(this.f & FLAG_C);
    return !!(this.f & FLAG_C);
  }

  step() {
    const pending = this.ie & this.iflag & 0x1f;
    if (this.halted) {
      if (pending) this.halted = false;
      else {
        this.tick(4);
        return 4;
      }
    }
    if (this.stopped) {
      this.tick(4);
      return 4;
    }
    this.instructionTicks = 0;
    if (this.ime && pending) return this.serviceInterrupt(pending);

    const opcode = this.fetch8();
    const cycles = this.execute(opcode);
    if (this.instructionTicks < cycles) this.tick(cycles - this.instructionTicks);
    if (this.imeDelay > 0) {
      this.imeDelay -= 1;
      if (this.imeDelay === 0) this.ime = true;
    }
    return cycles;
  }

  serviceInterrupt(pending) {
    let bit = 0;
    while (!(pending & (1 << bit))) bit += 1;
    this.ime = false;
    this.imeDelay = 0;
    this.iflag &= ~(1 << bit);
    this.tick(8);
    this.instructionTicks += 8;
    this.push16(this.pc);
    this.pc = 0x40 + bit * 8;
    this.tick(4);
    this.instructionTicks += 4;
    return 20;
  }

  execute(opcode) {
    const x = opcode >> 6;
    const y = (opcode >> 3) & 7;
    const z = opcode & 7;
    const p = y >> 1;
    const q = y & 1;
    let value;
    let address;
    let result;

    if (x === 0) {
      if (z === 0) {
        if (y === 0) return 4;
        if (y === 1) {
          address = this.fetch16();
          this.cpuWrite(address, this.sp & 0xff);
          this.cpuWrite((address + 1) & 0xffff, this.sp >> 8);
          return 20;
        }
        if (y === 2) {
          this.fetch8();
          if (this.cgbMode && this.speedSwitchArmed) {
            this.doubleSpeed = !this.doubleSpeed;
            this.speedSwitchArmed = false;
            this.divCounter = 0;
            this.speedSubcycle = 0;
          } else this.stopped = true;
          return 4;
        }
        if (y === 3) {
          value = signed8(this.fetch8());
          this.pc = clamp16(this.pc + value);
          return 12;
        }
        value = signed8(this.fetch8());
        if (this.condition(y - 4)) {
          this.pc = clamp16(this.pc + value);
          return 12;
        }
        return 8;
      }
      if (z === 1) {
        if (!q) {
          this.setPair(p, this.fetch16());
          return 12;
        }
        const hl = this.getHL();
        value = this.getPair(p);
        result = hl + value;
        this.f = (this.f & FLAG_Z) | (((hl & 0xfff) + (value & 0xfff) > 0xfff) ? FLAG_H : 0) | (result > 0xffff ? FLAG_C : 0);
        this.setHL(result);
        return 8;
      }
      if (z === 2) {
        address = p === 0 ? this.getBC() : p === 1 ? this.getDE() : this.getHL();
        if (!q) this.cpuWrite(address, this.a);
        else this.a = this.cpuRead(address);
        if (p === 2) this.setHL(address + 1);
        if (p === 3) this.setHL(address - 1);
        return 8;
      }
      if (z === 3) {
        this.setPair(p, this.getPair(p) + (q ? -1 : 1));
        return 8;
      }
      if (z === 4) {
        value = this.readReg(y);
        result = (value + 1) & 0xff;
        this.writeReg(y, result);
        this.f = (this.f & FLAG_C) | (result === 0 ? FLAG_Z : 0) | ((value & 0x0f) === 0x0f ? FLAG_H : 0);
        return y === 6 ? 12 : 4;
      }
      if (z === 5) {
        value = this.readReg(y);
        result = (value - 1) & 0xff;
        this.writeReg(y, result);
        this.f = (this.f & FLAG_C) | FLAG_N | (result === 0 ? FLAG_Z : 0) | ((value & 0x0f) === 0 ? FLAG_H : 0);
        return y === 6 ? 12 : 4;
      }
      if (z === 6) {
        this.writeReg(y, this.fetch8());
        return y === 6 ? 12 : 8;
      }
      if (y === 0) {
        const carry = this.a >> 7;
        this.a = ((this.a << 1) | carry) & 0xff;
        this.f = carry ? FLAG_C : 0;
      } else if (y === 1) {
        const carry = this.a & 1;
        this.a = (this.a >> 1) | (carry << 7);
        this.f = carry ? FLAG_C : 0;
      } else if (y === 2) {
        const carry = this.a >> 7;
        this.a = ((this.a << 1) | ((this.f & FLAG_C) ? 1 : 0)) & 0xff;
        this.f = carry ? FLAG_C : 0;
      } else if (y === 3) {
        const carry = this.a & 1;
        this.a = (this.a >> 1) | ((this.f & FLAG_C) ? 0x80 : 0);
        this.f = carry ? FLAG_C : 0;
      } else if (y === 4) this.daa();
      else if (y === 5) { this.a ^= 0xff; this.f |= FLAG_N | FLAG_H; }
      else if (y === 6) this.f = (this.f & FLAG_Z) | FLAG_C;
      else this.f = (this.f & FLAG_Z) | ((this.f & FLAG_C) ? 0 : FLAG_C);
      return 4;
    }

    if (x === 1) {
      if (y === 6 && z === 6) {
        if (!this.ime && (this.ie & this.iflag & 0x1f)) this.haltBug = true;
        else this.halted = true;
        return 4;
      }
      this.writeReg(y, this.readReg(z));
      return (y === 6 || z === 6) ? 8 : 4;
    }

    if (x === 2) {
      this.alu(y, this.readReg(z));
      return z === 6 ? 8 : 4;
    }

    if (z === 0) {
      if (y < 4) {
        if (this.condition(y)) {
          this.pc = this.pop16();
          return 20;
        }
        return 8;
      }
      if (y === 4) { this.cpuWrite(0xff00 | this.fetch8(), this.a); return 12; }
      if (y === 5) {
        value = signed8(this.fetch8());
        const old = this.sp;
        result = clamp16(old + value);
        this.f = (((old & 0xf) + (value & 0xf) > 0xf) ? FLAG_H : 0) | (((old & 0xff) + (value & 0xff) > 0xff) ? FLAG_C : 0);
        this.sp = result;
        return 16;
      }
      if (y === 6) { this.a = this.cpuRead(0xff00 | this.fetch8()); return 12; }
      value = signed8(this.fetch8());
      result = clamp16(this.sp + value);
      this.f = (((this.sp & 0xf) + (value & 0xf) > 0xf) ? FLAG_H : 0) | (((this.sp & 0xff) + (value & 0xff) > 0xff) ? FLAG_C : 0);
      this.setHL(result);
      return 12;
    }

    if (z === 1) {
      if (!q) {
        this.setStackPair(p, this.pop16());
        return 12;
      }
      if (p === 0) { this.pc = this.pop16(); return 16; }
      if (p === 1) { this.pc = this.pop16(); this.ime = true; this.imeDelay = 0; return 16; }
      if (p === 2) { this.pc = this.getHL(); return 4; }
      this.sp = this.getHL();
      return 8;
    }

    if (z === 2) {
      if (y < 4) {
        address = this.fetch16();
        if (this.condition(y)) { this.pc = address; return 16; }
        return 12;
      }
      if (y === 4) { this.cpuWrite(0xff00 | this.c, this.a); return 8; }
      if (y === 5) { this.cpuWrite(this.fetch16(), this.a); return 16; }
      if (y === 6) { this.a = this.cpuRead(0xff00 | this.c); return 8; }
      this.a = this.cpuRead(this.fetch16());
      return 16;
    }

    if (z === 3) {
      if (y === 0) { this.pc = this.fetch16(); return 16; }
      if (y === 1) return this.executeCB(this.fetch8());
      if (y === 6) { this.ime = false; this.imeDelay = 0; return 4; }
      if (y === 7) { this.imeDelay = 2; return 4; }
      return 4;
    }

    if (z === 4) {
      if (y < 4) {
        address = this.fetch16();
        if (this.condition(y)) {
          this.push16(this.pc);
          this.pc = address;
          return 24;
        }
        return 12;
      }
      return 4;
    }

    if (z === 5) {
      if (!q) {
        this.push16(this.getStackPair(p));
        return 16;
      }
      if (p === 0) {
        address = this.fetch16();
        this.push16(this.pc);
        this.pc = address;
        return 24;
      }
      return 4;
    }

    if (z === 6) {
      this.alu(y, this.fetch8());
      return 8;
    }

    this.push16(this.pc);
    this.pc = y * 8;
    return 16;
  }

  daa() {
    let correction = 0;
    let carry = this.f & FLAG_C;
    if (!(this.f & FLAG_N)) {
      if ((this.f & FLAG_H) || (this.a & 0x0f) > 9) correction |= 0x06;
      if (carry || this.a > 0x99) { correction |= 0x60; carry = FLAG_C; }
      this.a = (this.a + correction) & 0xff;
    } else {
      if (this.f & FLAG_H) correction |= 0x06;
      if (carry) correction |= 0x60;
      this.a = (this.a - correction) & 0xff;
    }
    this.f = (this.f & FLAG_N) | carry | (this.a === 0 ? FLAG_Z : 0);
  }

  executeCB(opcode) {
    const x = opcode >> 6;
    const y = (opcode >> 3) & 7;
    const z = opcode & 7;
    let value = this.readReg(z);
    let result = value;
    let carry = 0;
    if (x === 0) {
      if (y === 0) { carry = value >> 7; result = ((value << 1) | carry) & 0xff; }
      else if (y === 1) { carry = value & 1; result = (value >> 1) | (carry << 7); }
      else if (y === 2) { carry = value >> 7; result = ((value << 1) | ((this.f & FLAG_C) ? 1 : 0)) & 0xff; }
      else if (y === 3) { carry = value & 1; result = (value >> 1) | ((this.f & FLAG_C) ? 0x80 : 0); }
      else if (y === 4) { carry = value >> 7; result = (value << 1) & 0xff; }
      else if (y === 5) { carry = value & 1; result = (value >> 1) | (value & 0x80); }
      else if (y === 6) result = ((value << 4) | (value >> 4)) & 0xff;
      else { carry = value & 1; result = value >> 1; }
      this.writeReg(z, result);
      this.f = (result === 0 ? FLAG_Z : 0) | (carry ? FLAG_C : 0);
    } else if (x === 1) {
      this.f = (this.f & FLAG_C) | FLAG_H | ((value & (1 << y)) ? 0 : FLAG_Z);
      return z === 6 ? 12 : 8;
    } else if (x === 2) {
      result = value & ~(1 << y);
      this.writeReg(z, result);
    } else {
      result = value | (1 << y);
      this.writeReg(z, result);
    }
    return z === 6 ? 16 : 8;
  }

  runFrame(maxCycles = null) {
    this.runFrameCalls += 1;
    this.frameReady = false;
    const start = this.cycles;
    const budget = maxCycles ?? FRAME_CYCLES * 2 + 32;
    while (!this.frameReady && this.cycles - start < budget) this.step();
    return this.frameReady;
  }

  runCycles(count) {
    const target = this.cycles + count;
    while (this.cycles < target) this.step();
  }

  getDebugState() {
    return {
      pc: this.pc, sp: this.sp, a: this.a, f: this.f, b: this.b, c: this.c,
      d: this.d, e: this.e, h: this.h, l: this.l, ime: this.ime,
      halted: this.halted, ly: this.displayLy(), mode: this.ppuMode,
      frame: this.frameNumber, serial: this.serialOutput,
      runFrameCalls: this.runFrameCalls,
      bootEnabled: this.bootEnabled,
    };
  }

  exportBattery() {
    return this.hasBattery ? this.eram.slice() : null;
  }

  exportBatteryState() {
    if (!this.hasBattery) return null;
    if (this.hasRTC) this.updateRTC();
    return {
      version: 2,
      ram: this.eram.slice(),
      rtc: this.hasRTC ? { ...this.rtc } : null,
    };
  }

  importBattery(input) {
    if (!this.hasBattery || !input) return false;
    const ram = input.ram ?? input;
    this.eram.fill(0);
    this.eram.set(new Uint8Array(ram).subarray(0, this.eram.length));
    if (this.hasRTC && input.rtc) {
      this.rtc = { ...this.rtc, ...input.rtc, last: Number(input.rtc.last) || Date.now() };
    }
    this.batteryDirty = true;
    return true;
  }

  markBatterySaved() {
    this.batteryDirty = false;
  }

  exportState() {
    if (!this.hasROM) return null;
    const scalars = {};
    for (const key of STATE_SCALARS) scalars[key] = this[key];
    return {
      version: STATE_VERSION,
      model: this.model,
      title: this.title,
      scalars,
      memory: {
        vram: this.vram.slice(),
        wram: this.wram.slice(),
        eram: this.eram.slice(),
        oam: this.oam.slice(),
        hram: this.hram.slice(),
        io: this.io.slice(),
        bgPalette: this.bgPalette.slice(),
        objPalette: this.objPalette.slice(),
        framebuffer: this.framebuffer.slice(),
      },
      rtc: { ...this.rtc },
      latchedRTC: this.latchedRTC ? { ...this.latchedRTC } : null,
      channels: {
        ch1: { ...this.ch1 },
        ch2: { ...this.ch2 },
        ch3: { ...this.ch3 },
        ch4: { ...this.ch4 },
      },
      serialOutput: this.serialOutput,
      compatibilityPaletteId: this.compatibilityPaletteId,
      capturedCompatibilityPalette: this.capturedCompatibilityPalette
        ? {
            bg: this.capturedCompatibilityPalette.bg.slice(),
            obj0: this.capturedCompatibilityPalette.obj0.slice(),
            obj1: this.capturedCompatibilityPalette.obj1.slice(),
          }
        : null,
    };
  }

  importState(snapshot) {
    if (
      !snapshot
      || snapshot.version !== STATE_VERSION
      || snapshot.model !== this.model
      || snapshot.title !== this.title
    ) return false;
    for (const key of STATE_SCALARS) {
      if (Object.hasOwn(snapshot.scalars ?? {}, key)) this[key] = snapshot.scalars[key];
    }
    const memory = snapshot.memory ?? {};
    const restore = (target, source) => {
      if (!source || source.length !== target.length) return false;
      target.set(source);
      return true;
    };
    if (
      !restore(this.vram, memory.vram)
      || !restore(this.wram, memory.wram)
      || !restore(this.eram, memory.eram)
      || !restore(this.oam, memory.oam)
      || !restore(this.hram, memory.hram)
      || !restore(this.io, memory.io)
      || !restore(this.bgPalette, memory.bgPalette)
      || !restore(this.objPalette, memory.objPalette)
      || !restore(this.framebuffer, memory.framebuffer)
    ) return false;
    this.rtc = { ...this.rtc, ...(snapshot.rtc ?? {}) };
    this.latchedRTC = snapshot.latchedRTC ? { ...snapshot.latchedRTC } : null;
    this.ch1 = { ...this.ch1, ...(snapshot.channels?.ch1 ?? {}) };
    this.ch2 = { ...this.ch2, ...(snapshot.channels?.ch2 ?? {}) };
    this.ch3 = { ...this.ch3, ...(snapshot.channels?.ch3 ?? {}) };
    this.ch4 = { ...this.ch4, ...(snapshot.channels?.ch4 ?? {}) };
    this.refreshAudioSteps();
    this.serialOutput = snapshot.serialOutput ?? "";
    this.compatibilityPaletteId = snapshot.compatibilityPaletteId ?? "auto";
    this.capturedCompatibilityPalette = snapshot.capturedCompatibilityPalette
      ? {
          bg: new Uint8Array(snapshot.capturedCompatibilityPalette.bg),
          obj0: new Uint8Array(snapshot.capturedCompatibilityPalette.obj0),
          obj1: new Uint8Array(snapshot.capturedCompatibilityPalette.obj1),
        }
      : null;
    if (this.model === "cgb" && !this.cgbMode) this.updateCompatibilityPaletteAliases();
    this.audioSampleCount = 0;
    this.batteryDirty = this.hasBattery;
    this.updateStat();
    return true;
  }
}

export const GAMEBOY_WIDTH = SCREEN_WIDTH;
export const GAMEBOY_HEIGHT = SCREEN_HEIGHT;
export const GAMEBOY_CLOCK = CPU_CLOCK;
