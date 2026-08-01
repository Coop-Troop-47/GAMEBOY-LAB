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
const NOISE_PERIODS = new Uint16Array([8, 16, 32, 48, 64, 80, 96, 112]);
const TIMER_MASKS = new Uint16Array([1 << 9, 1 << 3, 1 << 5, 1 << 7]);
const DECODED_TILE_ROWS = new Uint16Array(0x10000);
for (let bytes = 0; bytes < 0x10000; bytes += 1) {
  const low = bytes & 0xff;
  const high = bytes >> 8;
  let pixels = 0;
  for (let x = 0; x < 8; x += 1) {
    const bit = 7 - x;
    pixels |= ((((high >> bit) & 1) << 1) | ((low >> bit) & 1)) << (x * 2);
  }
  DECODED_TILE_ROWS[bytes] = pixels;
}
const ILLEGAL_OPCODES = new Uint8Array(256);
for (const opcode of [0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd]) {
  ILLEGAL_OPCODES[opcode] = 1;
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
  "ime", "imeDelay", "halted", "stopped", "locked", "haltBug", "ie", "iflag",
  "joypad", "joypSelect", "divCounter", "tima", "tma", "tac",
  "timerReload", "timerReloading", "serialData", "serialControl", "serialCycles",
  "serialBits", "serialTransmitByte", "infraredInput", "infraredOutput",
  "vramBank", "wramBank", "romBank", "ramBank", "ramEnabled", "mbc1Mode",
  "mbc1High", "rumbleEnabled", "rtcSelect", "rtcLatchValue", "dmaCycles", "dmaSource",
  "dmaIndex", "dmaSubcycle", "dmaStartDelay", "dmaPendingSource",
  "hdmaSource", "hdmaDestination", "hdmaBlocks",
  "hdmaActive", "hdmaStallCycles", "bgPaletteIndex", "objPaletteIndex", "opri", "ppuDot", "ly",
  "ppuMode", "ppuMode3End", "ppuBusMode", "ppuBusDot", "ppuBusLine",
  "ppuTransferWarmup", "ppuTransferDiscard", "ppuTransferX", "ppuTransferStall",
  "ppuTransferDot",
  "ppuInitialScxLow", "ppuWindowActive", "ppuWindowDrawn", "ppuWindowPixelX",
  "ppuWindowRow", "ppuWindowLineCursor",
  "ppuWindowPenaltyBudgeted", "ppuTransferLive",
  "ppuLineLcdc", "ppuLineScy", "ppuLineScx", "ppuLineBgp", "ppuLineObp0",
  "ppuLineObp1", "ppuLineWy", "ppuLineWx", "ppuLineWindowLine",
  "ppuLineCgbRendering", "ppuFetchScx", "ppuFetchLcdc", "ppuFetchWindowMap",
  "lcdStartup", "lycMatch", "statSignal", "windowLine", "frameReady",
  "frameNumber", "cycles", "bootEnabled", "doubleSpeed", "speedSwitchArmed",
  "baseCycles",
  "speedSwitchCycles", "speedSubcycle", "audioClock", "audioIntegralLeft",
  "audioIntegralRight", "audioFrameStep", "apuSquarePhase", "apuSkipFrameEvent", "cgbMode",
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
    this.decodedTileRows = new Uint16Array(0x2000);
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
    this.lineSpritePool = Array.from({ length: 10 }, () => ({
      index: 0,
      y: 0,
      rawX: 0,
      x: 0,
      tile: 0,
      attr: 0,
    }));
    this.lineSpriteStalls = new Uint16Array(SCREEN_WIDTH);
    this.lineSpriteClaimed = new Uint8Array(SCREEN_WIDTH);
    this.lineSpriteXGroups = new Uint8Array(168);
    this.colorScratch = new Uint8Array(3);
    this.audioMix = new Float64Array(6);
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
    this.serialEndpoint = null;
    this.onInfraredOutput = null;
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
    this.flushAPU();
    this.audioRate = Math.max(8000, Math.min(192000, Math.round(rate)));
    this.audioClock = 0;
    this.audioIntegralLeft = 0;
    this.audioIntegralRight = 0;
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
    this.mbc1Multicart = this.mapper === 1
      && bytes.length >= 0x100000
      && NINTENDO_LOGO.every((value, index) => bytes[0x40000 + 0x104 + index] === value);
    this.hasBattery = [0x03, 0x06, 0x09, 0x0f, 0x10, 0x13, 0x1b, 0x1e].includes(this.cartType);
    this.hasRTC = [0x0f, 0x10].includes(this.cartType);
    const ramCode = bytes[0x149];
    const ramSizes = { 0: 0, 1: 0x800, 2: 0x2000, 3: 0x8000, 4: 0x20000, 5: 0x10000 };
    const ramSize = this.mapper === 2 ? 0x200 : (ramSizes[ramCode] || 0);
    this.eram = new Uint8Array(ramSize);
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
    this.speedSwitchCycles = 0;
    this.speedSubcycle = 0;
    this.baseCycles = 0;
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
    this.locked = false;
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
    this.serialBits = 0;
    this.serialTransmitByte = 0;
    this.serialOutput = "";
    this.infraredInput = false;
    this.infraredOutput = false;
    this.vramBank = 0;
    this.wramBank = 1;
    this.romBank = 1;
    this.ramBank = 0;
    this.ramEnabled = this.cartType === 0x08 || this.cartType === 0x09;
    this.mbc1Mode = 0;
    this.mbc1High = 0;
    this.rumbleEnabled = false;
    this.rtcSelect = 0;
    this.rtcLatchValue = 0;
    this.rtc = {
      seconds: 0,
      minutes: 0,
      hours: 0,
      days: 0,
      halt: false,
      carry: false,
      last: Date.now(),
      subsecond: 0,
    };
    this.dmaCycles = 0;
    this.dmaSource = 0;
    this.dmaIndex = 0;
    this.dmaSubcycle = 0;
    this.dmaStartDelay = 0;
    this.dmaPendingSource = 0;
    this.hdmaSource = 0;
    this.hdmaDestination = 0x8000;
    this.hdmaBlocks = 0;
    this.hdmaActive = false;
    this.hdmaStallCycles = 0;
    this.bgPaletteIndex = 0;
    this.objPaletteIndex = 0;
    this.opri = this.cgbMode ? 0 : 1;
    this.ppuDot = 0;
    this.ly = 0;
    this.ppuMode = 2;
    this.ppuMode3End = 252;
    this.ppuBusMode = 2;
    this.ppuBusDot = -1;
    this.ppuBusLine = -1;
    this.ppuTransferWarmup = 0;
    this.ppuTransferDiscard = 0;
    this.ppuTransferX = 0;
    this.ppuTransferStall = 0;
    this.ppuTransferDot = 0;
    this.ppuInitialScxLow = 0;
    this.ppuWindowActive = false;
    this.ppuWindowDrawn = false;
    this.ppuWindowPixelX = 0;
    this.ppuWindowRow = 0;
    this.ppuWindowLineCursor = 0;
    this.ppuWindowPenaltyBudgeted = false;
    this.ppuTransferLive = false;
    this.ppuLineLcdc = 0;
    this.ppuLineScy = 0;
    this.ppuLineScx = 0;
    this.ppuLineBgp = 0;
    this.ppuLineObp0 = 0;
    this.ppuLineObp1 = 0;
    this.ppuLineWy = 0;
    this.ppuLineWx = 0;
    this.ppuLineWindowLine = 0;
    this.ppuLineCgbRendering = false;
    this.ppuFetchScx = 0;
    this.ppuFetchLcdc = 0;
    this.ppuFetchWindowMap = 0;
    this.lcdStartup = false;
    this.lycMatch = true;
    this.statSignal = false;
    this.windowLine = 0;
    this.frameReady = false;
    this.frameNumber = 0;
    this.runFrameCalls = 0;
    this.cycles = 0;
    this.instructionTicks = 0;
    this.batteryDirty = false;
    this.io.fill(0);
    this.vram.fill(0);
    this.decodedTileRows.fill(0);
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
      this.joypSelect = 0x00;
      // The divider starts eight T-cycles into its phase on powered hardware;
      // boot-timing and serial-clock alignment tests observe this offset.
      this.divCounter = 7;
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

  apuReset(preserveLengths = false) {
    const lengths = preserveLengths && this.ch1
      ? [this.ch1.length, this.ch2.length, this.ch3.length, this.ch4.length]
      : [0, 0, 0, 0];
    this.audioSampleCount = 0;
    this.audioClock = 0;
    this.audioIntegralLeft = 0;
    this.audioIntegralRight = 0;
    this.apuPendingClocks = 0;
    this.audioFrameStep = 0;
    this.apuSquarePhase = 0;
    this.apuSkipFrameEvent = false;
    this.ch1 = {
      enabled: false,
      phase: 0,
      timer: 0,
      timerPeriod: 8192,
      dutyPosition: 0,
      duty: 0,
      length: lengths[0],
      volume: 0,
      envCounter: 0,
      envRunning: false,
      sweepCounter: 0,
      sweepEnabled: false,
      sweepNegated: false,
      shadow: 0,
      phaseStep: 0,
      sampleSuppressed: false,
      justReloaded: false,
    };
    this.ch2 = {
      enabled: false,
      phase: 0,
      timer: 0,
      timerPeriod: 8192,
      dutyPosition: 0,
      duty: 0,
      length: lengths[1],
      volume: 0,
      envCounter: 0,
      envRunning: false,
      phaseStep: 0,
      sampleSuppressed: false,
      justReloaded: false,
    };
    this.ch3 = {
      enabled: false,
      phase: 0,
      phaseStep: 0,
      timer: 0,
      timerPeriod: 4096,
      wavePosition: 0,
      waveAccess: 0,
      currentSample: 0,
      length: lengths[2],
    };
    this.ch4 = {
      enabled: false,
      phase: 0,
      timer: 0,
      timerPeriod: 8,
      length: lengths[3],
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
    const increment = !this.haltBug;
    const value = this.cpuRead(this.pc, increment);
    if (increment) this.pc = (this.pc + 1) & 0xffff;
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
    // POP/RET expose only the first SP increment to the OAM IDU glitch.
    const low = this.cpuRead(this.sp, true);
    this.sp = (this.sp + 1) & 0xffff;
    const high = this.cpuRead(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return low | (high << 8);
  }

  selectedRomBank0() {
    if (this.mapper !== 1 || this.mbc1Mode === 0) return 0;
    return (this.mbc1High << (this.mbc1Multicart ? 4 : 5)) % this.romBanks;
  }

  selectedRomBank() {
    let bank;
    if (this.mapper === 1) {
      const low = this.romBank & 0x1f;
      const translated = low === 0 ? 1 : low;
      bank = (translated & (this.mbc1Multicart ? 0x0f : 0x1f))
        | (this.mbc1High << (this.mbc1Multicart ? 4 : 5));
    } else if (this.mapper === 2) {
      bank = this.romBank & 0x0f;
      if (bank === 0) bank = 1;
    } else if (this.mapper === 3) {
      bank = this.romBank & 0x7f;
      if (bank === 0) bank = 1;
    } else {
      bank = this.romBank;
    }
    return bank % this.romBanks;
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
      if (!direct && (this.io[0x40] & 0x80) && this.cpuAccessPPUMode() === 3) return 0xff;
      return this.vram[(this.vramBank * 0x2000) + address - 0x8000];
    }
    if (address < 0xc000) {
      if (!this.ramEnabled) return 0xff;
      if (this.mapper === 3 && this.rtcSelect >= 0x08 && this.rtcSelect <= 0x0c) {
        return this.readRTC(this.rtcSelect);
      }
      if (this.mapper === 3 && this.rtcSelect > 0x03) return 0xff;
      if (this.eram.length === 0) return 0xff;
      const offset = (this.selectedRamBank() * 0x2000 + address - 0xa000) % this.eram.length;
      return this.mapper === 2 ? 0xf0 | this.eram[offset] : this.eram[offset];
    }
    if (address < 0xd000) return this.wram[address - 0xc000];
    if (address < 0xe000) return this.wram[this.wramBank * 0x1000 + address - 0xd000];
    if (address < 0xfe00) return this.read8(address - 0x2000, direct);
    if (address < 0xfea0) {
      const mode = this.cpuAccessPPUMode();
      if (!direct && (this.dmaCycles > 0 || ((this.io[0x40] & 0x80) && (mode === 2 || mode === 3)))) return 0xff;
      return this.oam[address - 0xfe00];
    }
    if (address < 0xff00) return 0xff;
    if (address === 0xffff) return this.ie;
    if (address >= 0xff80) return this.hram[address - 0xff80];
    return this.readIO(address & 0x7f);
  }

  oamScanRow() {
    if (
      this.model !== "dmg"
      || !(this.io[0x40] & 0x80)
      || this.ppuMode !== 2
      || this.ly >= 144
    ) return -1;
    // DMG OAM search begins on row zero, then exposes one eight-byte row for
    // each pair of objects. The first hand-off occurs two dots into mode 2.
    if (this.ppuDot < 2) return 0;
    return Math.min(0x98, (Math.floor((this.ppuDot - 2) / 4) + 1) * 8);
  }

  readOAMWord(offset) {
    return this.oam[offset] | (this.oam[offset + 1] << 8);
  }

  writeOAMWord(offset, value) {
    this.oam[offset] = value & 0xff;
    this.oam[offset + 1] = value >> 8;
  }

  copyOAMRow(destination, source) {
    for (let index = 0; index < 8; index += 1) {
      this.oam[destination + index] = this.oam[source + index];
    }
  }

  triggerOAMCorruption(kind, address) {
    if (address < 0xfe00 || address >= 0xff00) return;
    const row = this.oamScanRow();
    if (row < 8) return;

    if (kind === "read-write") {
      // A read sharing an M-cycle with a 16-bit IDU increment first corrupts
      // and mirrors the preceding row, then undergoes normal read corruption.
      if (row >= 0x20 && row < 0x98) {
        const a = this.readOAMWord(row - 0x10);
        const b = this.readOAMWord(row - 0x08);
        const c = this.readOAMWord(row);
        const d = this.readOAMWord(row - 0x04);
        this.writeOAMWord(row - 0x08, (b & (a | c | d)) | (a & c & d));
        this.copyOAMRow(row, row - 0x08);
        this.copyOAMRow(row - 0x10, row - 0x08);
      }
      this.triggerOAMCorruption("read", address);
      return;
    }

    const a = this.readOAMWord(row);
    const b = this.readOAMWord(row - 0x08);
    const c = this.readOAMWord(row - 0x04);
    const first = kind === "read"
      ? b | (a & c)
      : ((a ^ c) & (b ^ c)) ^ c;

    if (kind === "read") {
      this.writeOAMWord(row - 0x08, first);
      this.copyOAMRow(row, row - 0x08);
    } else {
      this.writeOAMWord(row, first);
      for (let index = 2; index < 8; index += 1) {
        this.oam[row + index] = this.oam[row - 8 + index];
      }
    }
  }

  cpuRead(address, iduIncrement = false) {
    this.tick(4);
    this.instructionTicks += 4;
    this.triggerOAMCorruption(iduIncrement ? "read-write" : "read", address);
    if (this.dmaConflictsWith(address)) {
      // During a conflicting read the CPU sees the byte currently driven by
      // the DMA source bus, rather than a fabricated constant $FF.
      const source = this.dmaSource + Math.max(0, this.dmaIndex - 1);
      return this.readDmaSource(source);
    }
    return this.read8(address);
  }

  cpuWrite(address, value, iduAddress = -1) {
    this.tick(4);
    this.instructionTicks += 4;
    if (
      (address >= 0xfe00 && address < 0xff00)
      || (iduAddress >= 0xfe00 && iduAddress < 0xff00)
    ) this.triggerOAMCorruption("write", address >= 0xfe00 && address < 0xff00 ? address : iduAddress);
    if (!this.dmaConflictsWith(address)) this.write8(address, value, false, true);
  }

  cpuInternalCycle(iduAddress = -1) {
    this.tick(4);
    this.instructionTicks += 4;
    this.triggerOAMCorruption("write", iduAddress);
  }

  readDmaSource(address) {
    // On DMG, DMA source addresses E000-FFFF alias C000-DFFF. This also
    // applies to FE00 and FF00: the DMA unit does not read OAM or I/O there.
    if (address >= 0xe000) {
      if (this.model === "cgb") return 0xff;
      address &= ~0x2000;
    }
    return this.read8(address, true);
  }

  dmaBusForAddress(address) {
    address &= 0xffff;
    if (address >= 0x8000 && address < 0xa000) return 2; // VRAM bus
    if (this.model === "cgb" && address >= 0xc000 && address < 0xfe00) return 1; // WRAM bus
    return 0; // cartridge/main bus
  }

  dmaConflictsWith(address) {
    address &= 0xffff;
    if (this.dmaCycles <= 0 || this.dmaIndex === 0 || address >= 0xfe00) return false;
    const source = (this.dmaSource + this.dmaIndex) & 0xffff;
    const sourceBus = this.dmaBusForAddress(source);
    const addressBus = this.dmaBusForAddress(address);
    if (this.model === "dmg") return addressBus === sourceBus;
    // CGB splits cartridge, VRAM, and WRAM traffic. WRAM is unavailable when
    // DMA uses either the cartridge or WRAM bus, while a high/echo source
    // leaves only VRAM uncontended.
    if (address >= 0xc000) return sourceBus !== 2;
    if (source >= 0xe000) return addressBus !== 2;
    return addressBus === sourceBus;
  }

  write8(address, value, direct = false, cpuBusWrite = false) {
    address &= 0xffff;
    value &= 0xff;
    if (address < 0x8000) {
      this.writeMapper(address, value);
      return;
    }
    if (address < 0xa000) {
      if (direct || !(this.io[0x40] & 0x80) || this.cpuAccessPPUMode(cpuBusWrite) !== 3) {
        const offset = this.vramBank * 0x2000 + address - 0x8000;
        this.vram[offset] = value;
        this.decodeVRAMRow(offset);
      }
      return;
    }
    if (address < 0xc000) {
      if (!this.ramEnabled) return;
      if (this.mapper === 3 && this.rtcSelect >= 0x08 && this.rtcSelect <= 0x0c) {
        this.writeRTC(this.rtcSelect, value);
      } else if (this.mapper === 3 && this.rtcSelect > 0x03) {
        return;
      } else {
        if (this.eram.length === 0) return;
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
      this.write8(address - 0x2000, value, direct, cpuBusWrite);
      return;
    }
    if (address < 0xfea0) {
      const mode = this.cpuAccessPPUMode(cpuBusWrite);
      if (direct || (!(this.dmaCycles > 0) && (!(this.io[0x40] & 0x80) || (mode !== 2 && mode !== 3)))) {
        this.oam[address - 0xfe00] = value;
      }
      return;
    }
    if (address < 0xff00) return;
    if (address === 0xffff) {
      // IE is backed by a full byte of storage. Only the low five bits feed
      // interrupt arbitration, but the upper three bits remain readable RAM.
      this.ie = value;
      return;
    }
    if (address >= 0xff80) {
      this.hram[address - 0xff80] = value;
      return;
    }
    this.writeIO(address & 0x7f, value);
  }

  decodeVRAMRow(offset) {
    const row = offset & ~1;
    if ((row & 0x1fff) >= 0x1800) return;
    const low = this.vram[row];
    const high = this.vram[row + 1];
    this.decodedTileRows[row >> 1] = DECODED_TILE_ROWS[(high << 8) | low];
  }

  rebuildDecodedTiles() {
    for (let bank = 0; bank < 0x4000; bank += 0x2000) {
      for (let offset = 0; offset < 0x1800; offset += 2) {
        this.decodeVRAMRow(bank + offset);
      }
    }
  }

  writeMapper(address, value) {
    if (this.mapper === 0) return;
    if (this.mapper === 1) {
      if (address < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
      else if (address < 0x4000) this.romBank = value & 0x1f;
      else if (address < 0x6000) this.mbc1High = value & 0x03;
      else this.mbc1Mode = value & 1;
    } else if (this.mapper === 2) {
      if (address < 0x4000) {
        if (address & 0x0100) this.romBank = value & 0x0f;
        else this.ramEnabled = (value & 0x0f) === 0x0a;
      }
    } else if (this.mapper === 3) {
      if (address < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
      else if (address < 0x4000) this.romBank = value & 0x7f;
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
      else if (address < 0x6000) {
        this.rumbleEnabled = this.cartType >= 0x1c && !!(value & 0x08);
        this.ramBank = value & (this.cartType >= 0x1c ? 0x07 : 0x0f);
      }
    }
  }

  readIO(register) {
    if (register === 0x00) return this.readJoypad();
    if (register === 0x01) return this.serialData;
    if (register === 0x02) return this.cgbRegistersAvailable()
      ? (this.serialControl & 0x83) | 0x7c
      : (this.serialControl & 0x81) | 0x7e;
    if (register === 0x04) return (this.divCounter >> 8) & 0xff;
    if (register === 0x05) return this.tima;
    if (register === 0x06) return this.tma;
    if (register === 0x07) return this.tac | 0xf8;
    if (register === 0x0f) return this.iflag | 0xe0;
    if (register === 0x41) {
      return (this.io[0x41] & 0xf8) | (this.lycMatch ? 4 : 0)
        | ((this.io[0x40] & 0x80) ? this.cpuVisiblePPUMode() : 0);
    }
    if (register === 0x44) return this.displayLy();
    if (register === 0x4d) return this.cgbRegistersAvailable()
      ? (this.doubleSpeed ? 0x80 : 0) | (this.speedSwitchArmed ? 1 : 0) | 0x7e
      : 0xff;
    if (register === 0x4f) return this.model === "cgb" ? 0xfe | this.vramBank : 0xff;
    if (register === 0x50) return this.bootEnabled ? 0x00 : 0xff;
    if (register === 0x56) {
      if (!this.cgbRegistersAvailable()) return 0xff;
      let value = (this.io[0x56] & 0xc1) | 0x3e;
      if (
        (this.io[0x56] & 0xc0) === 0xc0
        && (this.infraredInput || this.infraredOutput)
      ) value &= ~0x02;
      return value;
    }
    if (register === 0x55) return this.cgbRegistersAvailable()
      ? (this.hdmaActive ? 0 : 0x80)
        | (this.hdmaBlocks > 0 ? (this.hdmaBlocks - 1) & 0x7f : 0x7f)
      : 0xff;
    if (register === 0x68) return this.model === "cgb" ? this.bgPaletteIndex | 0x40 : 0xff;
    if (register === 0x69) return !this.cgbRegistersAvailable() || this.ppuMode === 3
      ? 0xff
      : this.bgPalette[this.bgPaletteIndex & 0x3f];
    if (register === 0x6a) return this.model === "cgb" ? this.objPaletteIndex | 0x40 : 0xff;
    if (register === 0x6b) return !this.cgbRegistersAvailable() || this.ppuMode === 3
      ? 0xff
      : this.objPalette[this.objPaletteIndex & 0x3f];
    if (register === 0x6c) return this.cgbRegistersAvailable() ? 0xfe | this.opri : 0xff;
    if (register === 0x70) return this.cgbRegistersAvailable() ? 0xf8 | this.wramBank : 0xff;
    if (register === 0x72 || register === 0x73) {
      return this.model === "cgb" ? this.io[register] : 0xff;
    }
    if (register === 0x75) {
      return this.model === "cgb" ? 0x8f | (this.io[0x75] & 0x70) : 0xff;
    }
    if (register === 0x76) {
      if (this.model !== "cgb") return 0xff;
      // PCM12/PCM34 are sampled halfway through the CPU read M-cycle. Keep
      // the final two base clocks pending so their value is not observed two
      // clocks too late.
      this.flushAPU(2);
      const channel1 = this.ch1.enabled
        && !this.ch1.sampleSuppressed
        && DUTY_PATTERNS[this.ch1.duty][this.ch1.dutyPosition]
        ? this.ch1.volume
        : 0;
      const channel2 = this.ch2.enabled
        && !this.ch2.sampleSuppressed
        && DUTY_PATTERNS[this.ch2.duty][this.ch2.dutyPosition]
        ? this.ch2.volume
        : 0;
      return channel1 | (channel2 << 4);
    }
    if (register === 0x77) {
      if (this.model !== "cgb") return 0xff;
      this.flushAPU(2);
      let channel3 = 0;
      if (this.ch3.enabled && (this.io[0x1a] & 0x80)) {
        channel3 = this.ch3.currentSample;
        const level = (this.io[0x1c] >> 5) & 3;
        channel3 = level === 0 ? 0 : channel3 >> (level - 1);
      }
      const channel4 = this.ch4.enabled && !(this.ch4.lfsr & 1) ? this.ch4.volume : 0;
      return channel3 | (channel4 << 4);
    }
    if (register >= 0x10 && register <= 0x3f) return this.readAPU(register);
    if (
      register === 0x40
      || register === 0x42
      || register === 0x43
      || register === 0x45
      || register === 0x46
      || (register >= 0x47 && register <= 0x4b)
    ) return this.io[register];
    return 0xff;
  }

  writeIO(register, value) {
    if (register === 0x00) {
      const before = this.readJoypad();
      this.joypSelect = value & 0x30;
      const after = this.readJoypad();
      if ((before & ~after & 0x0f) !== 0) this.requestInterrupt(4);
      return;
    }
    if (register === 0x01) { this.serialData = value; return; }
    if (register === 0x02) {
      // The serial clock is a free-running divider of the system clock. A
      // control write synchronises to its current phase instead of starting a
      // fresh byte-length countdown.
      this.serialControl = this.cgbRegistersAvailable() ? value & 0x83 : value & 0x81;
      if (value & 0x80) {
        this.serialTransmitByte = this.serialData;
        this.serialBits = 8;
        this.serialCycles = value & 1 ? 1 : 0;
      } else if (!(value & 0x80)) {
        this.serialCycles = 0;
        this.serialBits = 0;
      }
      return;
    }
    if (register === 0x04) {
      const before = this.timerSignal();
      const apuBefore = this.apuDividerSignal();
      const serialBefore = this.serialDividerSignal();
      this.flushAPU();
      this.divCounter = 0;
      if (before && !this.timerSignal()) this.incrementTima();
      if (apuBefore && !this.apuDividerSignal()) this.clockAPUFrameSequencer();
      if (serialBefore && !this.serialDividerSignal()) this.clockSerialMaster();
      return;
    }
    if (register === 0x05) {
      if (this.timerReload === 1 || this.timerReloading) return;
      this.tima = value;
      if (this.timerReload > 1) this.timerReload = 0;
      return;
    }
    if (register === 0x06) {
      this.tma = value;
      if (this.timerReload === 1 || this.timerReloading) this.tima = value;
      return;
    }
    if (register === 0x07) {
      const before = this.timerSignal();
      this.tac = value & 0x07;
      if (before && !this.timerSignal()) {
        if (!this.timerReload && !this.timerReloading && this.tima === 0xff) {
          // The TAC edge occurs during the write M-cycle. By the time the CPU
          // reaches the following instruction boundary, the four-T-cycle
          // overflow window has elapsed and the interrupt is observable.
          this.tima = this.tma;
          this.timerReloading = true;
          this.requestInterrupt(2);
        } else this.incrementTima();
      }
      return;
    }
    if (register === 0x0f) { this.iflag = value & 0x1f; return; }
    if (register >= 0x10 && register <= 0x3f) {
      this.writeAPU(register, value);
      return;
    }
    if (register === 0x40) {
      const wasEnabled = !!(this.io[0x40] & 0x80);
      this.activateLivePixelTransfer();
      this.io[0x40] = value;
      const enabled = !!(value & 0x80);
      if (wasEnabled && !enabled) {
        this.ly = 0;
        this.ppuDot = 0;
        this.ppuMode = 0;
        this.ppuBusDot = -1;
        this.ppuBusLine = -1;
        this.windowLine = 0;
        this.lcdStartup = false;
      } else if (!wasEnabled && enabled) {
        this.ly = 0;
        this.ppuDot = 0;
        // The first scanline after LCD power-on has no OAM mode. DMG PPU
        // startup is two dots late, beginning in HBlank before entering mode 3.
        this.ppuMode = 0;
        this.ppuMode3End = 252;
        this.ppuBusDot = -1;
        this.ppuBusLine = -1;
        this.lcdStartup = true;
        this.windowLine = 0;
        this.lycMatch = this.io[0x45] === 0;
      }
      this.updateStat();
      return;
    }
    if (register === 0x41) {
      if (this.model === "dmg" && (this.io[0x40] & 0x80)) {
        // On DMG, a STAT write exposes all four interrupt-enable inputs for
        // one bus phase. It is still the combined line's rising edge—not the
        // write itself—that requests an interrupt.
        const glitchSignal = this.ppuMode !== 3 || this.lycMatch;
        if (glitchSignal && !this.statSignal) this.requestInterrupt(1);
        this.statSignal = glitchSignal;
      }
      this.io[0x41] = (value & 0x78) | 0x80;
      this.updateStat();
      return;
    }
    if (register === 0x44) return;
    if (register === 0x45) {
      this.io[0x45] = value;
      if (this.io[0x40] & 0x80) {
        this.lycMatch = this.displayLy() === value;
        this.updateStat();
      }
      return;
    }
    if (register === 0x46) {
      this.io[0x46] = value;
      // The write is M-cycle 0, followed by one complete setup M-cycle.
      // A fresh transfer therefore starts at M=2. When a running transfer is
      // restarted, the old transfer keeps ownership of OAM during both setup
      // cycles and is replaced only when the new source becomes active.
      this.dmaPendingSource = value << 8;
      this.dmaStartDelay = 8;
      return;
    }
    if (register === 0x4d) {
      if (this.cgbRegistersAvailable()) this.speedSwitchArmed = !!(value & 1);
      return;
    }
    if (register === 0x4f) {
      if (this.model === "cgb") this.vramBank = value & 1;
      return;
    }
    if (register === 0x50) {
      this.activateLivePixelTransfer();
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
    if (register === 0x56) {
      if (this.model === "cgb") {
        this.io[0x56] = value & 0xc1;
        const output = !!(value & 1);
        if (output !== this.infraredOutput) {
          this.infraredOutput = output;
          this.onInfraredOutput?.(output);
        }
      }
      return;
    }
    if (register >= 0x51 && register <= 0x55) {
      if (this.cgbRegistersAvailable()) this.writeHDMA(register, value);
      return;
    }
    if (register === 0x68) { if (this.model === "cgb") this.bgPaletteIndex = value & 0xbf; return; }
    if (register === 0x69) {
      if (this.cgbRegistersAvailable()) {
        if (this.ppuMode !== 3) this.bgPalette[this.bgPaletteIndex & 0x3f] = value;
        // The data write is blocked during pixel transfer, but the address
        // latch's auto-increment still occurs.
        if (this.bgPaletteIndex & 0x80) {
          this.bgPaletteIndex = 0x80 | ((this.bgPaletteIndex + 1) & 0x3f);
        }
      }
      return;
    }
    if (register === 0x6a) { if (this.model === "cgb") this.objPaletteIndex = value & 0xbf; return; }
    if (register === 0x6b) {
      if (this.cgbRegistersAvailable()) {
        if (this.ppuMode !== 3) this.objPalette[this.objPaletteIndex & 0x3f] = value;
        if (this.objPaletteIndex & 0x80) {
          this.objPaletteIndex = 0x80 | ((this.objPaletteIndex + 1) & 0x3f);
        }
      }
      return;
    }
    if (register === 0x6c) { if (this.cgbRegistersAvailable()) this.opri = value & 1; return; }
    if (register === 0x70) { if (this.cgbRegistersAvailable()) this.wramBank = value & 7 || 1; return; }
    if (register === 0x72 || register === 0x73) {
      if (this.model === "cgb") this.io[register] = value;
      return;
    }
    if (register === 0x75) {
      if (this.model === "cgb") this.io[0x75] = value & 0x70;
      return;
    }
    if (register === 0x76 || register === 0x77) return;
    if (
      register === 0x42
      || register === 0x43
      || (register >= 0x47 && register <= 0x4b)
    ) {
      this.activateLivePixelTransfer();
      this.io[register] = value;
    }
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
    const before = this.readJoypad();
    if (pressed) this.joypad &= ~(1 << bit);
    else this.joypad |= 1 << bit;
    const after = this.readJoypad();
    if ((before & ~after & 0x0f) !== 0) this.requestInterrupt(4);
    if (pressed) this.stopped = false;
  }

  setSerialEndpoint(endpoint) {
    this.serialEndpoint = typeof endpoint === "function" ? endpoint : null;
  }

  setInfraredInput(active) {
    this.infraredInput = !!active;
  }

  setInfraredOutputHandler(handler) {
    this.onInfraredOutput = typeof handler === "function" ? handler : null;
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

  serialDividerSignal() {
    // Each falling edge is one serial bit. DIV bit 8 yields 8192 bit/s at
    // normal speed; CGB fast mode uses bit 3 for 262144 bit/s. The serial
    // divider's reset phase leads the software-visible system counter by one
    // M-cycle on production DMG/MGB silicon.
    const bit = this.cgbMode && (this.serialControl & 2) ? 3 : 8;
    return !!(((this.divCounter + 4) & 0xffff) & (1 << bit));
  }

  clockSerialMaster() {
    if (
      (this.serialControl & 0x81) !== 0x81
      || this.serialBits <= 0
    ) return;
    const outgoing = (this.serialData >> 7) & 1;
    const incoming = this.serialEndpoint?.(outgoing, this);
    this.shiftSerialBit(incoming === 0 ? 0 : 1);
  }

  clockSerialExternal(inputBit = 1) {
    if (
      (this.serialControl & 0x81) !== 0x80
      || this.serialBits <= 0
    ) return null;
    const outgoing = (this.serialData >> 7) & 1;
    this.shiftSerialBit(inputBit === 0 ? 0 : 1);
    return outgoing;
  }

  shiftSerialBit(inputBit) {
    this.serialData = ((this.serialData << 1) | inputBit) & 0xff;
    this.serialBits -= 1;
    if (this.serialBits > 0) return;
    this.serialOutput += String.fromCharCode(this.serialTransmitByte);
    this.serialControl &= 0x7f;
    this.serialCycles = 0;
    this.requestInterrupt(3);
  }

  incrementTima() {
    if (this.timerReload || this.timerReloading) return;
    if (this.tima === 0xff) {
      this.tima = 0;
      this.timerReload = 4;
    } else this.tima = (this.tima + 1) & 0xff;
  }

  tick(cycles) {
    if (
      cycles > 0
      && !this.stopped
      && !this.timerReload
      && !this.timerReloading
      && this.dmaCycles <= 0
      && this.dmaStartDelay <= 0
      && ((this.serialControl & 0x81) !== 0x81 || this.serialBits <= 0)
    ) {
      const previousDivider = this.divCounter;
      const apuPeriod = 2 << (this.doubleSpeed ? 13 : 12);
      const firstApuEdge = apuPeriod - (previousDivider & (apuPeriod - 1));
      const crossesApuEdge = cycles >= firstApuEdge;
      let timerEdges = 0;
      if (this.tac & 4) {
        const timerPeriod = TIMER_MASKS[this.tac & 3] << 1;
        const firstTimerEdge = timerPeriod - (previousDivider & (timerPeriod - 1));
        if (cycles >= firstTimerEdge) {
          timerEdges = 1 + Math.floor((cycles - firstTimerEdge) / timerPeriod);
        }
      }
      if (!crossesApuEdge && this.tima + timerEdges <= 0xff) {
        this.divCounter = (previousDivider + cycles) & 0xffff;
        this.tima += timerEdges;
        const phaseTotal = this.speedSubcycle + cycles;
        const ppuClocks = this.doubleSpeed ? phaseTotal >> 1 : cycles;
        this.speedSubcycle = this.doubleSpeed ? phaseTotal & 1 : 0;
        if (ppuClocks > 0) {
          this.baseCycles += ppuClocks;
          if (this.io[0x40] & 0x80) this.advancePPU(ppuClocks);
          this.apuPendingClocks += ppuClocks;
        }
        this.cycles += cycles;
        return;
      }
    }

    let pendingPpuClocks = 0;
    const requiresDotStepping = this.dmaCycles > 0 || this.dmaStartDelay > 0;
    for (let i = 0; i < cycles; i += 1) {
      // Keep the reload phase observable until the next T-cycle boundary.
      // CPU writes occur between tick batches, so TIMA/TMA can reproduce the
      // hardware's special write behavior on the exact reload cycle.
      if (this.timerReloading) this.timerReloading = false;
      // Advance a pending overflow before evaluating this T-cycle's falling
      // edge. An overflow created below must retain the full four-cycle delay;
      // decrementing it in the same cycle would reload one T-cycle too early.
      if (this.timerReload > 0) {
        this.timerReload -= 1;
        if (this.timerReload === 0) {
          this.timerReloading = true;
          this.tima = this.tma;
          this.requestInterrupt(2);
        }
      }
      if (!this.stopped) {
        const previousDivider = this.divCounter;
        const nextDivider = (previousDivider + 1) & 0xffff;
        this.divCounter = nextDivider;

        // These are all divider falling-edge detectors. Keeping the bit tests
        // together avoids six hot-path method calls per T-cycle without
        // changing the order in which the timer, APU, and serial unit observe
        // the edge.
        if (this.tac & 4) {
          const timerMask = TIMER_MASKS[this.tac & 3];
          if ((previousDivider & timerMask) && !(nextDivider & timerMask)) {
            this.incrementTima();
          }
        }
        const apuMask = 1 << (this.doubleSpeed ? 13 : 12);
        if ((previousDivider & apuMask) && !(nextDivider & apuMask)) {
          this.flushAPU();
          this.clockAPUFrameSequencer();
        }
        if ((this.serialControl & 0x81) === 0x81 && this.serialBits > 0) {
          const serialMask = 1 << (this.cgbMode && (this.serialControl & 2) ? 3 : 8);
          const previousSerial = (previousDivider + 4) & 0xffff;
          const nextSerial = (nextDivider + 4) & 0xffff;
          if ((previousSerial & serialMask) && !(nextSerial & serialMask)) {
            this.clockSerialMaster();
          }
        }
      }
      if (this.dmaCycles > 0) {
        this.dmaCycles -= 1;
        this.dmaSubcycle += 1;
        if (this.dmaSubcycle >= 4) {
          this.dmaSubcycle = 0;
          if (this.dmaIndex < 0xa0) {
            this.oam[this.dmaIndex] = this.readDmaSource(this.dmaSource + this.dmaIndex);
            this.dmaIndex += 1;
          }
        }
      }
      if (this.dmaStartDelay > 0) {
        this.dmaStartDelay -= 1;
        if (this.dmaStartDelay === 0) {
          this.dmaSource = this.dmaPendingSource;
          this.dmaCycles = 640;
          this.dmaIndex = 0;
          this.dmaSubcycle = 0;
        }
      }
      // In CGB double-speed mode the CPU, divider, serial unit, and OAM DMA
      // receive two clocks per PPU/APU dot. Keeping the base-clock domains
      // separate fixes half-speed video and pitched-up audio after KEY1/STOP.
      this.speedSubcycle = (this.speedSubcycle + 1) & 1;
      if (!this.doubleSpeed || this.speedSubcycle === 0) {
        this.baseCycles += 1;
        if (this.io[0x40] & 0x80) {
          if (requiresDotStepping) this.tickPPU();
          else pendingPpuClocks += 1;
        }
        this.apuPendingClocks += 1;
      }
      this.cycles += 1;
    }
    if (pendingPpuClocks > 0) this.advancePPU(pendingPpuClocks);
  }

  displayLy() {
    return this.ly === 153 && this.ppuDot >= 4 ? 0 : this.ly;
  }

  cpuVisiblePPUMode() {
    return this.ppuBusDot === this.ppuDot && this.ppuBusLine === this.ly
      ? this.ppuBusMode
      : this.ppuMode;
  }

  cpuAccessPPUMode(write = false) {
    // At the first dot of a scanline STAT still reports mode 0, while the OAM
    // read bus has already been claimed by mode 2. Writes at that same edge
    // still land in HBlank. At steady-state transitions, writes see the new
    // owner while reads retain the old owner only during the mode-3 release.
    if (write) {
      const atTransition = this.ppuBusDot === this.ppuDot
        && this.ppuBusLine === this.ly
        && this.ppuBusMode !== this.ppuMode;
      return atTransition ? (this.ppuBusMode === 3 ? 3 : 0) : this.ppuMode;
    }
    if (this.ppuMode === 3 || this.ppuDot === 0) return this.ppuMode;
    return this.cpuVisiblePPUMode();
  }

  rememberPPUBusMode(mode) {
    this.ppuBusMode = mode;
    this.ppuBusDot = this.ppuDot;
    this.ppuBusLine = this.ly;
  }

  tickPPU() {
    if (!(this.io[0x40] & 0x80)) return;
    this.advancePPU(1);
  }

  advancePPU(clocks) {
    if (!(this.io[0x40] & 0x80)) return;
    while (clocks > 0) {
      if (this.ppuMode === 3 && this.ly < 144) {
        const transferEnd = this.lcdStartup && this.ly === 0
          ? 251
          : this.ppuMode3End;
        const step = Math.min(clocks, transferEnd - this.ppuDot);
        if (this.ppuTransferLive) {
          this.advancePixelTransfer(step);
          this.ppuTransferDot += step;
        }
        this.ppuDot += step;
        clocks -= step;
        if (this.ppuDot >= transferEnd) this.processPPUEvent();
        continue;
      }
      const lineEnd = this.lcdStartup && this.ly === 0 ? 452 : 456;
      let nextEvent = lineEnd;
      if (this.ppuDot < 1) nextEvent = 1;
      if (this.ly < 144) {
        if (this.lcdStartup && this.ly === 0) {
          if (this.ppuDot < 79) nextEvent = Math.min(nextEvent, 79);
          if (this.ppuDot < 251) nextEvent = Math.min(nextEvent, 251);
        } else {
          if (this.ppuDot < 80) nextEvent = Math.min(nextEvent, 80);
          if (this.ppuDot < this.ppuMode3End) {
            nextEvent = Math.min(nextEvent, this.ppuMode3End);
          }
        }
      }
      if (this.model === "cgb" && this.ly === 143 && this.ppuDot < 452) {
        nextEvent = Math.min(nextEvent, 452);
      }
      if (this.ly === 153 && this.ppuDot < 4) nextEvent = Math.min(nextEvent, 4);

      const distance = nextEvent - this.ppuDot;
      if (distance > clocks) {
        this.ppuDot += clocks;
        return;
      }
      this.ppuDot = nextEvent;
      clocks -= distance;
      this.processPPUEvent();
    }
  }

  processPPUEvent() {
    if (this.ppuDot === 1) {
      const match = this.displayLy() === this.io[0x45];
      if (match !== this.lycMatch) {
        this.lycMatch = match;
        this.updateStat();
      }
    }
    if (this.ly < 144 && this.ppuDot === 1 && !this.lcdStartup) {
      this.ppuMode3End = this.calculateMode3End(this.ly);
    }

    let newMode = this.ppuMode;
    if (this.ly >= 144) newMode = 1;
    else if (this.lcdStartup && this.ly === 0) {
      // LCD power-on begins two dots out of phase with an ordinary scanline.
      // CPU bus reads at the mode boundary observe the post-transition startup
      // mode, unlike steady-state scanlines where the old mode remains visible
      // for that bus sample.
      if (this.ppuDot < 79) newMode = 0;
      else if (this.ppuDot < 251) newMode = 3;
      else newMode = 0;
    }
    else if (this.ppuDot < 80) newMode = 2;
    else if (this.ppuDot < this.ppuMode3End) newMode = 3;
    else newMode = 0;

    if (newMode !== this.ppuMode) {
      const previous = this.ppuMode;
      this.rememberPPUBusMode(previous);
      this.ppuMode = newMode;
      if (newMode === 3 && this.ly < 144) this.beginPixelTransfer(this.ly);
      if (previous === 3 && newMode === 0 && this.ly < 144) {
        this.finishPixelTransfer();
        if (this.hdmaActive && !this.halted && !this.stopped) this.startHDMABlock();
      }
      this.updateStat();
    }

    if (
      this.model === "cgb"
      && this.ly === 143
      && this.ppuDot === 452
      && (this.io[0x41] & 0x20)
    ) {
      // CGB exposes the line-144 OAM STAT source one M-cycle before VBlank.
      // This is an interrupt-line quirk only: the CPU-visible STAT mode does
      // not become mode 2. DMG instead aliases the source after VBlank begins.
      if (!this.statSignal) this.requestInterrupt(1);
      this.statSignal = true;
    }

    if (this.ppuDot >= (this.lcdStartup && this.ly === 0 ? 452 : 456)) {
      this.ppuDot = 0;
      this.ly += 1;
      this.lcdStartup = false;
      const previous = this.ppuMode;
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
      if (this.ppuMode !== previous) this.rememberPPUBusMode(previous);
      // LY changes before the equality comparator has sampled the new line.
      // Equality is therefore low for dot 0 and is latched at dot 1.
      this.lycMatch = false;
      this.updateStat();
    } else if (this.ly === 153 && this.ppuDot === 4) {
      this.lycMatch = this.io[0x45] === 0;
      this.updateStat();
    }
  }

  updateStat() {
    if (!(this.io[0x40] & 0x80)) {
      return;
    }
    const stat = this.io[0x41];
    const signal =
      (this.lycMatch && !!(stat & 0x40)) ||
      ((this.ppuMode === 2 || (this.model === "dmg" && this.ppuMode === 1 && this.ly === 144))
        && !!(stat & 0x20)) ||
      (this.ppuMode === 1 && !!(stat & 0x10)) ||
      (this.ppuMode === 0 && !!(stat & 0x08));
    if (signal && !this.statSignal) this.requestInterrupt(1);
    this.statSignal = signal;
  }

  calculateMode3End(line) {
    const lcdc = this.io[0x40];
    let selected = 0;
    let spritePenalty = 0;
    const spriteXGroups = this.lineSpriteXGroups;
    spriteXGroups.fill(0);
    if (lcdc & 0x02) {
      const spriteHeight = lcdc & 0x04 ? 16 : 8;
      for (let index = 0; index < 40 && selected < 10; index += 1) {
        const y = this.oam[index * 4] - 16;
        if (line < y || line >= y + spriteHeight) continue;
        selected += 1;
        const rawX = this.oam[index * 4 + 1];
        if (rawX >= 168) continue;
        // Every fetched object costs six dots. The first object at a given X
        // also waits for the BG fetcher's 8-dot phase; coincident objects share
        // that alignment stall. This is why ten objects at one X are much
        // cheaper than ten objects spaced eight pixels apart.
        spritePenalty += 6;
        if (!spriteXGroups[rawX]) {
          spriteXGroups[rawX] = 1;
          spritePenalty += 5 - Math.min(5, (rawX + this.io[0x43]) & 7);
        }
      }
    }
    const windowStarts = !!(lcdc & 0x20)
      && line >= this.io[0x4a]
      && this.io[0x4b] <= 166;
    this.ppuWindowPenaltyBudgeted = windowStarts;
    // The exact FIFO penalty depends on alignment and fetch collisions. This
    // bounded model preserves the documented 172-dot baseline, SCX discard,
    // window restart, and per-object stalls instead of the old fixed Mode 3.
    return Math.min(369, 252 + (this.io[0x43] & 7) + spritePenalty + (windowStarts ? 6 : 0));
  }

  prepareLineObjects(line) {
    const lcdc = this.io[0x40];
    const cgbRendering = this.cgbMode || (this.model === "cgb" && this.bootEnabled);
    const spriteHeight = lcdc & 0x04 ? 16 : 8;
    const sprites = this.lineSprites;
    const spritePool = this.lineSpritePool;
    const stalls = this.lineSpriteStalls;
    sprites.length = 0;
    stalls.fill(0);
    for (let index = 0; index < 40 && sprites.length < 10; index += 1) {
      const y = this.oam[index * 4] - 16;
      if (line < y || line >= y + spriteHeight) continue;
      const rawX = this.oam[index * 4 + 1];
      const sprite = spritePool[sprites.length];
      sprite.index = index;
      sprite.y = y;
      sprite.rawX = rawX;
      sprite.x = rawX - 8;
      sprite.tile = this.oam[index * 4 + 2];
      sprite.attr = this.oam[index * 4 + 3];
      sprites.push(sprite);
      if ((lcdc & 0x02) && rawX < 168) {
        const stallX = Math.max(0, rawX - 8);
        stalls[stallX] += 6;
        if (stalls[stallX] === 6) {
          stalls[stallX] += 5 - Math.min(5, (rawX + this.io[0x43]) & 7);
        }
      }
    }
    if (!cgbRendering || this.opri) {
      sprites.sort((left, right) => left.x - right.x || left.index - right.index);
    }
  }

  beginPixelTransfer(line) {
    const windowStarts = !!(this.io[0x40] & 0x20)
      && line >= this.io[0x4a]
      && this.io[0x4b] <= 166;
    if (windowStarts !== this.ppuWindowPenaltyBudgeted) {
      this.ppuMode3End = Math.max(
        252,
        Math.min(369, this.ppuMode3End + (windowStarts ? 6 : -6)),
      );
      this.ppuWindowPenaltyBudgeted = windowStarts;
    }
    this.ppuTransferWarmup = 12;
    this.ppuInitialScxLow = this.io[0x43] & 7;
    this.ppuTransferDiscard = this.ppuInitialScxLow;
    this.ppuTransferX = 0;
    this.ppuTransferStall = 0;
    this.ppuTransferDot = this.ppuDot;
    this.ppuWindowActive = false;
    this.ppuWindowDrawn = false;
    this.ppuWindowPixelX = 0;
    this.ppuWindowRow = this.windowLine;
    this.ppuWindowLineCursor = this.windowLine;
    this.ppuTransferLive = false;
    this.ppuLineLcdc = this.io[0x40];
    this.ppuLineScy = this.io[0x42];
    this.ppuLineScx = this.io[0x43];
    this.ppuLineBgp = this.io[0x47];
    this.ppuLineObp0 = this.io[0x48];
    this.ppuLineObp1 = this.io[0x49];
    this.ppuLineWy = this.io[0x4a];
    this.ppuLineWx = this.io[0x4b];
    this.ppuLineWindowLine = this.windowLine;
    this.ppuLineCgbRendering = this.cgbMode
      || (this.model === "cgb" && this.bootEnabled);
    this.ppuFetchScx = this.io[0x43];
    this.ppuFetchLcdc = this.io[0x40];
    this.ppuFetchWindowMap = this.io[0x40] & 0x40;
    this.lineBgColors.fill(0);
    this.lineBgPriority.fill(0);
    // Mode-2 writes can change object size or visibility after the initial
    // timing estimate. Re-sample the selected objects at the transfer edge so
    // those writes affect the line exactly where hardware exposes them.
    this.prepareLineObjects(line);
  }

  finishPixelTransfer() {
    if (!this.ppuTransferLive) {
      this.ppuTransferX = SCREEN_WIDTH;
      const bgEnabled = this.ppuLineCgbRendering || !!(this.ppuLineLcdc & 1);
      this.ppuWindowDrawn = bgEnabled
        && !!(this.ppuLineLcdc & 0x20)
        && this.ly >= this.ppuLineWy
        && this.ppuLineWx <= 166;
      this.renderStaticTransferRange(this.ly, 0, SCREEN_WIDTH);
      if (this.ppuWindowDrawn) this.ppuWindowLineCursor = this.windowLine + 1;
    }
    if (this.ppuWindowDrawn) this.windowLine = this.ppuWindowLineCursor;
  }

  catchUpPixelTransfer() {
    if (this.ppuMode !== 3 || this.ly >= SCREEN_HEIGHT) return;
    const pending = this.ppuDot - this.ppuTransferDot;
    if (pending <= 0) return;
    this.advancePixelTransfer(pending);
    this.ppuTransferDot = this.ppuDot;
  }

  activateLivePixelTransfer() {
    if (
      this.ppuTransferLive
      || this.ppuMode !== 3
      || this.ly >= SCREEN_HEIGHT
    ) return;
    this.catchUpPixelTransfer();
    this.renderStaticTransferRange(this.ly, 0, this.ppuTransferX);
    this.ppuTransferLive = true;
  }

  windowCanStart(line, x) {
    const lcdc = this.io[0x40];
    if (!(lcdc & 0x20) || line < this.io[0x4a] || this.io[0x4b] > 166) return false;
    const wx = this.io[0x4b];
    const trigger = wx - 7;
    // WX values 0–6 request the window before the visible pixel counter has
    // reached zero. For the visible edge values 4–6 the fetcher still emits
    // the remaining left-edge pixels from the old FIFO; preserving that phase
    // is observable in mid-mode-3 WX changes. Values 0–3 begin off-screen.
    const earlyWindowPixels = wx >= 4 ? Math.min(2, 7 - wx) : 0;
    return x === (trigger <= 0 ? earlyWindowPixels : trigger);
  }

  advancePixelTransfer(dots) {
    while (dots > 0) {
      if (this.ppuTransferWarmup > 0) {
        const consumed = Math.min(dots, this.ppuTransferWarmup);
        this.ppuTransferWarmup -= consumed;
        dots -= consumed;
        continue;
      }
      if (this.ppuTransferStall > 0) {
        const consumed = Math.min(dots, this.ppuTransferStall);
        this.ppuTransferStall -= consumed;
        dots -= consumed;
        continue;
      }
      if (this.ppuTransferDiscard > 0) {
        const consumed = Math.min(dots, this.ppuTransferDiscard);
        this.ppuTransferDiscard -= consumed;
        dots -= consumed;
        continue;
      }
      let x = this.ppuTransferX;
      if (x >= SCREEN_WIDTH) return;

      if (!this.ppuWindowActive && this.windowCanStart(this.ly, x)) {
        if (!this.ppuWindowPenaltyBudgeted) {
          this.ppuMode3End = Math.min(369, this.ppuMode3End + 6);
          this.ppuWindowPenaltyBudgeted = true;
        }
        this.ppuWindowActive = true;
        this.ppuWindowDrawn = true;
        this.ppuWindowPixelX = 0;
        this.ppuWindowRow = this.ppuWindowLineCursor;
        this.ppuWindowLineCursor += 1;
        this.ppuFetchLcdc = this.io[0x40];
        this.ppuFetchWindowMap = this.io[0x40] & 0x40;
        this.ppuTransferStall = 5;
        dots -= 1;
        continue;
      }
      const spriteStall = this.lineSpriteStalls[x];
      if (spriteStall > 0) {
        this.lineSpriteStalls[x] = 0;
        this.ppuTransferStall = spriteStall - 1;
        dots -= 1;
        continue;
      }

      // CPU-visible writes happen between tick batches, so all PPU registers
      // are stable for the remaining dots in this call. Emit consecutive
      // pixels together while still stopping exactly at window and object
      // fetch boundaries. This preserves dot-level effects without paying a
      // JavaScript method-call and event-loop cost for every individual dot.
      do {
        if (this.ppuTransferLive) {
          this.renderTransferPixel(this.ly, x);
        } else {
          const lcdc = this.ppuLineLcdc;
          const bgEnabled = this.cgbMode
            || (this.model === "cgb" && this.bootEnabled)
            || !!(lcdc & 1);
          if (bgEnabled && this.ppuWindowActive && (lcdc & 0x20)) {
            this.ppuWindowPixelX += 1;
          }
        }
        x += 1;
        dots -= 1;
        if (dots <= 0 || x >= SCREEN_WIDTH) break;
        if (
          (!this.ppuWindowActive && this.windowCanStart(this.ly, x))
          || this.lineSpriteStalls[x] > 0
        ) break;
      } while (true);
      this.ppuTransferX = x;
    }
  }

  renderStaticTransferRange(line, start, end) {
    if (end <= start) return;
    const lcdc = this.ppuLineLcdc;
    const cgbRendering = this.ppuLineCgbRendering;
    const cgbCompatibility = this.model === "cgb" && !cgbRendering;
    const bgEnabled = cgbRendering || !!(lcdc & 1);
    const windowTrigger = this.ppuLineWx - 7;
    const windowStart = Math.max(0, windowTrigger);
    const windowEnabled = bgEnabled
      && !!(lcdc & 0x20)
      && line >= this.ppuLineWy
      && this.ppuLineWx <= 166;
    const bgColors = this.lineBgColors;
    const bgPriority = this.lineBgPriority;
    const limit = Math.min(SCREEN_WIDTH, end);
    const framebuffer32 = this.framebuffer32;
    const framebufferOffset = line * SCREEN_WIDTH;
    const vram = this.vram;
    const decodedTileRows = this.decodedTileRows;
    const bgPalette = this.bgPalette;
    let cachedTileKey = -1;
    let cachedTileRow = 0;
    let cachedTileAttr = 0;

    for (let x = start; x < limit; x += 1) {
      let colorIndex = 0;
      let palette = 0;
      let priority = 0;
      if (bgEnabled) {
        const useWindow = windowEnabled && x >= windowStart;
        const pixelX = useWindow
          ? x - windowStart
          : (x + this.ppuLineScx) & 0xff;
        const pixelY = useWindow
          ? this.ppuLineWindowLine
          : (line + this.ppuLineScy) & 0xff;
        const mapBase = useWindow
          ? ((lcdc & 0x40) ? 0x1c00 : 0x1800)
          : ((lcdc & 0x08) ? 0x1c00 : 0x1800);
        const mapOffset = mapBase + ((pixelY >> 3) * 32) + (pixelX >> 3);
        const rawTileY = pixelY & 7;
        const tileKey = mapOffset | (rawTileY << 13);
        if (tileKey !== cachedTileKey) {
          const tileNumber = vram[mapOffset];
          const attr = cgbRendering ? vram[0x2000 + mapOffset] : 0;
          let tileY = rawTileY;
          if (attr & 0x40) tileY = 7 - tileY;
          const tileAddress = lcdc & 0x10
            ? tileNumber * 16
            : 0x1000 + signed8(tileNumber) * 16;
          const bank = cgbRendering && (attr & 0x08) ? 0x2000 : 0;
          cachedTileRow = decodedTileRows[(bank + tileAddress + tileY * 2) >> 1];
          cachedTileAttr = attr;
          cachedTileKey = tileKey;
        }
        const attr = cachedTileAttr;
        let tileX = pixelX & 7;
        if (attr & 0x20) tileX = 7 - tileX;
        colorIndex = (cachedTileRow >> (tileX * 2)) & 3;
        palette = attr & 7;
        priority = (attr >> 7) & 1;
      }
      bgColors[x] = colorIndex;
      bgPriority[x] = priority;
      const packedColor = cgbRendering
        ? CGB_COLOR_LUT_PACKED[
            (bgPalette[(palette * 8) + (colorIndex * 2)]
              | (bgPalette[(palette * 8) + (colorIndex * 2) + 1] << 8)) & 0x7fff
          ]
        : cgbCompatibility
          ? CGB_COLOR_LUT_PACKED[
              (bgPalette[((this.ppuLineBgp >> (colorIndex * 2)) & 3) * 2]
                | (bgPalette[((this.ppuLineBgp >> (colorIndex * 2)) & 3) * 2 + 1]
                  << 8)) & 0x7fff
            ]
          : this.dmgPackedColor(
              this.ppuLineBgp,
              colorIndex,
              this.dmgBgPalettePacked,
            );
      framebuffer32[framebufferOffset + x] = packedColor;
    }

    if (!(lcdc & 0x02)) return;
    const spriteHeight = lcdc & 0x04 ? 16 : 8;
    const sprites = this.lineSprites;
    const claimed = this.lineSpriteClaimed;
    claimed.fill(0, start, limit);
    const objPalette = this.objPalette;
    for (const sprite of sprites) {
      const spriteStart = Math.max(start, sprite.x);
      const spriteEnd = Math.min(limit, sprite.x + 8);
      if (spriteEnd <= spriteStart) continue;
      for (let x = spriteStart; x < spriteEnd; x += 1) {
        if (claimed[x]) continue;
        let tileX = x - sprite.x;
        let tileY = line - sprite.y;
        if (sprite.attr & 0x20) tileX = 7 - tileX;
        if (sprite.attr & 0x40) tileY = spriteHeight - 1 - tileY;
        let tile = sprite.tile;
        if (spriteHeight === 16) tile = (tile & 0xfe) + (tileY >= 8 ? 1 : 0);
        tileY &= 7;
        const bank = cgbRendering && (sprite.attr & 0x08) ? 0x2000 : 0;
        const row = decodedTileRows[(bank + tile * 16 + tileY * 2) >> 1];
        const spriteColor = (row >> (tileX * 2)) & 3;
        if (spriteColor === 0) continue;
        claimed[x] = 1;

        const bgOpaque = bgColors[x] !== 0;
        const hiddenByBg = cgbRendering
          ? !!(lcdc & 1) && bgOpaque
            && (bgPriority[x] || (sprite.attr & 0x80))
          : bgOpaque && !!(sprite.attr & 0x80);
        if (!hiddenByBg) {
          const objectPalette = (sprite.attr & 0x10) ? 1 : 0;
          const objectRegister = objectPalette
            ? this.ppuLineObp1
            : this.ppuLineObp0;
          const spritePackedColor = cgbRendering
            ? CGB_COLOR_LUT_PACKED[
                (objPalette[((sprite.attr & 7) * 8) + (spriteColor * 2)]
                  | (objPalette[((sprite.attr & 7) * 8) + (spriteColor * 2) + 1]
                    << 8)) & 0x7fff
              ]
            : cgbCompatibility
              ? this.cgbCompatibilityPackedColor(
                  objPalette,
                  objectPalette,
                  objectRegister,
                  spriteColor,
                )
              : this.dmgPackedColor(
                  objectRegister,
                  spriteColor,
                  objectPalette
                    ? this.dmgObj1PalettePacked
                    : this.dmgObj0PalettePacked,
                );
          framebuffer32[framebufferOffset + x] = spritePackedColor;
        }
      }
    }
  }

  renderTransferPixel(line, x) {
    const lcdc = this.io[0x40];
    const cgbRendering = this.cgbMode || (this.model === "cgb" && this.bootEnabled);
    const cgbCompatibility = this.model === "cgb" && !cgbRendering;
    const bgEnabled = cgbRendering || !!(lcdc & 1);
    let useWindow = bgEnabled && this.ppuWindowActive;
    // Disabling WIN_EN is sampled at the end of the in-flight window tile.
    // Keep the FIFO's final tile visible, then allow background fetches to
    // resume on the next tile boundary.
    if (useWindow && !(lcdc & 0x20) && (this.ppuWindowPixelX & 7) === 0) {
      this.ppuWindowActive = false;
      useWindow = false;
    }
    let colorIndex = 0;
    let palette = 0;
    let priority = 0;

    if (bgEnabled) {
      // The upper five SCX bits are sampled by the background fetcher, not
      // continuously by the LCD. Refresh that latch at each eight-pixel
      // source-tile boundary; the fine SCX discard remains the transfer-start
      // phase. DMG SCY writes remain live here because the production DMG
      // exposes their immediate row-selection effect.
      const fetchTileBoundary = useWindow
        ? this.ppuWindowPixelX > 0 && (this.ppuWindowPixelX & 7) === 0
        : x > 0 && (((x + this.ppuInitialScxLow) & 7) === 0);
      if (fetchTileBoundary) {
        this.ppuFetchScx = this.io[0x43];
        this.ppuFetchLcdc = this.io[0x40];
        this.ppuFetchWindowMap = this.io[0x40] & 0x40;
      }
      const scrollX = (this.ppuFetchScx & 0xf8) | this.ppuInitialScxLow;
      const pixelX = useWindow
        ? this.ppuWindowPixelX
        : (x + scrollX) & 0xff;
      const pixelY = useWindow
        ? this.ppuWindowRow
        : (line + this.io[0x42]) & 0xff;
      const tileLcdc = useWindow ? lcdc : this.ppuFetchLcdc;
      const mapBase = useWindow
        ? (this.ppuFetchWindowMap ? 0x1c00 : 0x1800)
        : ((tileLcdc & 0x08) ? 0x1c00 : 0x1800);
      const mapOffset = mapBase + ((pixelY >> 3) * 32) + (pixelX >> 3);
      const tileNumber = this.vram[mapOffset];
      const attr = cgbRendering ? this.vram[0x2000 + mapOffset] : 0;
      let tileX = pixelX & 7;
      let tileY = pixelY & 7;
      if (attr & 0x20) tileX = 7 - tileX;
      if (attr & 0x40) tileY = 7 - tileY;
      const tileAddress = tileLcdc & 0x10
        ? tileNumber * 16
        : 0x1000 + signed8(tileNumber) * 16;
      const bank = cgbRendering && (attr & 0x08) ? 0x2000 : 0;
      const row = this.decodedTileRows[(bank + tileAddress + tileY * 2) >> 1];
      colorIndex = (row >> (tileX * 2)) & 3;
      palette = attr & 7;
      priority = (attr >> 7) & 1;
    }
    if (useWindow) {
      this.ppuWindowPixelX += 1;
      if (!(lcdc & 0x20) && (this.ppuWindowPixelX & 7) === 0) {
        this.ppuWindowActive = false;
      }
    }
    this.lineBgColors[x] = colorIndex;
    this.lineBgPriority[x] = priority;
    const packedColor = cgbRendering
      ? this.cgbPackedColor(this.bgPalette, palette, colorIndex)
      : cgbCompatibility
        ? this.cgbCompatibilityPackedColor(this.bgPalette, 0, this.io[0x47], colorIndex)
        : this.dmgPackedColor(this.io[0x47], colorIndex, this.dmgBgPalettePacked);
    this.setPackedPixel(x, line, packedColor);
    if (!(lcdc & 0x02)) return;

    const spriteHeight = lcdc & 0x04 ? 16 : 8;
    const sprites = this.lineSprites;
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
      const row = this.decodedTileRows[(bank + tile * 16 + tileY * 2) >> 1];
      const spriteColor = (row >> (tileX * 2)) & 3;
      if (spriteColor === 0) continue;

      const bgOpaque = this.lineBgColors[x] !== 0;
      const bgMasterPriority = !!(lcdc & 1);
      const hiddenByBg = cgbRendering
        ? bgMasterPriority && bgOpaque
          && (this.lineBgPriority[x] || (sprite.attr & 0x80))
        : bgOpaque && !!(sprite.attr & 0x80);
      if (!hiddenByBg) {
        const objectPalette = (sprite.attr & 0x10) ? 1 : 0;
        const objectRegister = this.io[objectPalette ? 0x49 : 0x48];
        const spritePackedColor = cgbRendering
          ? this.cgbPackedColor(this.objPalette, sprite.attr & 7, spriteColor)
          : cgbCompatibility
            ? this.cgbCompatibilityPackedColor(
                this.objPalette,
                objectPalette,
                objectRegister,
                spriteColor,
              )
            : this.dmgPackedColor(
                objectRegister,
                spriteColor,
                objectPalette ? this.dmgObj1PalettePacked : this.dmgObj0PalettePacked,
              );
        this.setPackedPixel(x, line, spritePackedColor);
      }
      break;
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
      // CGB hardware reports $80 after a running HBlank transfer is stopped;
      // the partially consumed request is no longer exposed as a resumable
      // length counter.
      this.hdmaBlocks = 1;
      return;
    }
    if (this.hdmaActive) return;
    this.hdmaSource = ((this.io[0x51] << 8) | (this.io[0x52] & 0xf0)) & 0xfff0;
    this.hdmaDestination = 0x8000 | (((this.io[0x53] & 0x1f) << 8) | (this.io[0x54] & 0xf0));
    this.hdmaBlocks = (value & 0x7f) + 1;
    if (value & 0x80) {
      this.hdmaActive = true;
      // Starting during HBlank begins immediately. With LCD off, hardware
      // copies one block and then waits for a future visible HBlank.
      if (
        (!(this.io[0x40] & 0x80) || (this.ppuMode === 0 && this.ly < 144))
        && !this.halted
        && !this.stopped
      ) this.startHDMABlock();
    } else {
      const blocks = this.hdmaBlocks;
      while (this.hdmaBlocks > 0) this.transferHDMABlock();
      // General DMA halts the CPU for four setup clocks plus 32 dots per
      // block. In double speed, each dot spans two CPU T-cycles.
      const stall = 4 + blocks * 32 * (this.doubleSpeed ? 2 : 1);
      this.tick(stall);
      this.instructionTicks += stall;
    }
  }

  startHDMABlock() {
    if (!this.hdmaActive || this.hdmaBlocks <= 0) return false;
    this.transferHDMABlock();
    this.hdmaStallCycles += 32 * (this.doubleSpeed ? 2 : 1);
    return true;
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
    this.hdmaDestination += 0x10;
    // HDMA1-4 are working address registers, not immutable setup latches.
    // A second transfer that only rewrites HDMA5 continues from the byte
    // immediately following the previous transfer.
    this.io[0x51] = (this.hdmaSource >> 8) & 0xff;
    this.io[0x52] = this.hdmaSource & 0xf0;
    this.io[0x53] = (this.hdmaDestination >> 8) & 0x1f;
    this.io[0x54] = this.hdmaDestination & 0xf0;
    this.hdmaBlocks -= 1;
    if (this.hdmaBlocks <= 0 || this.hdmaDestination >= 0xa000) {
      this.hdmaBlocks = 0;
      this.hdmaActive = false;
    }
  }

  rtcFieldsValid() {
    return this.rtc.seconds < 60 && this.rtc.minutes < 60 && this.rtc.hours < 24;
  }

  incrementRTCSecond() {
    const seconds = this.rtc.seconds;
    this.rtc.seconds = (seconds + 1) & 0x3f;
    if (seconds !== 59) return;
    this.rtc.seconds = 0;

    const minutes = this.rtc.minutes;
    this.rtc.minutes = (minutes + 1) & 0x3f;
    if (minutes !== 59) return;
    this.rtc.minutes = 0;

    const hours = this.rtc.hours;
    this.rtc.hours = (hours + 1) & 0x1f;
    if (hours !== 23) return;
    this.rtc.hours = 0;
    this.rtc.days += 1;
    if (this.rtc.days > 511) {
      this.rtc.days = 0;
      this.rtc.carry = true;
    }
  }

  advanceRTC(elapsed) {
    // Invalid register values are legal on MBC3 hardware. They increment in
    // their native 6/6/5-bit counters and only carry at 59/59/23; overflowing
    // an invalid maximum such as 63 does not carry into the next register.
    // Step only until the fields become ordinary clock values, then use an
    // allocation-free bulk conversion for long offline intervals.
    while (elapsed > 0 && !this.rtcFieldsValid()) {
      this.incrementRTCSecond();
      elapsed -= 1;
    }
    if (elapsed <= 0) return;
    let total = this.rtc.seconds
      + this.rtc.minutes * 60
      + this.rtc.hours * 3600
      + this.rtc.days * 86400
      + elapsed;
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

  updateRTC(now = Date.now()) {
    if (this.rtc.halt) return;
    if (now < this.rtc.last) {
      this.rtc.last = now;
      return;
    }
    const elapsed = Math.floor((now - this.rtc.last) / 1000);
    if (elapsed <= 0) return;
    this.rtc.last += elapsed * 1000;
    this.advanceRTC(elapsed);
  }

  latchRTC() {
    this.updateRTC();
    this.latchedRTC = { ...this.rtc };
  }

  readRTC(register) {
    this.updateRTC();
    const rtc = this.latchedRTC || this.rtc;
    if (register === 0x08) return rtc.seconds & 0x3f;
    if (register === 0x09) return rtc.minutes & 0x3f;
    if (register === 0x0a) return rtc.hours & 0x1f;
    if (register === 0x0b) return rtc.days & 0xff;
    return ((rtc.days >> 8) & 1) | (rtc.halt ? 0x40 : 0) | (rtc.carry ? 0x80 : 0);
  }

  writeRTC(register, value) {
    const now = Date.now();
    this.updateRTC(now);
    if (register === 0x08) {
      this.rtc.seconds = value & 0x3f;
      // Writing seconds resets the divider. Other RTC registers deliberately
      // preserve this phase.
      this.rtc.last = now;
      this.rtc.subsecond = 0;
    }
    else if (register === 0x09) this.rtc.minutes = value & 0x3f;
    else if (register === 0x0a) this.rtc.hours = value & 0x1f;
    else if (register === 0x0b) this.rtc.days = (this.rtc.days & 0x100) | value;
    else {
      const wasHalted = this.rtc.halt;
      const willHalt = !!(value & 0x40);
      this.rtc.days = (this.rtc.days & 0xff) | ((value & 1) << 8);
      this.rtc.carry = !!(value & 0x80);
      if (!wasHalted && willHalt) {
        this.rtc.subsecond = Math.max(0, Math.min(999, now - this.rtc.last));
      } else if (wasHalted && !willHalt) {
        this.rtc.last = now - (this.rtc.subsecond || 0);
      }
      this.rtc.halt = willHalt;
    }
    this.batteryDirty = true;
  }

  readAPU(register) {
    // Like the undocumented PCM taps, sound-register reads sample the APU at
    // the midpoint of the CPU read M-cycle rather than its trailing edge.
    this.flushAPU(2);
    if (register >= 0x30 && register <= 0x3f) {
      if (this.ch3.enabled) {
        if (this.model === "dmg" && this.ch3.waveAccess <= 0) return 0xff;
        return this.io[0x30 + (this.ch3.wavePosition >> 1)];
      }
      return this.io[register];
    }
    if (
      register === 0x15
      || register === 0x1f
      || (register >= 0x27 && register <= 0x2f)
    ) return 0xff;
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
    // Sound-register writes land halfway through the CPU write M-cycle. The
    // final two base clocks must therefore execute with the new register
    // value, not the old one.
    this.flushAPU(2);
    if (
      register === 0x15
      || register === 0x1f
      || (register >= 0x27 && register <= 0x2f)
    ) return;
    if (register === 0x26) {
      if (!(value & 0x80)) {
        const postWriteClocks = this.apuPendingClocks;
        for (let i = 0x10; i <= 0x25; i += 1) this.io[i] = 0;
        this.apuReset(this.model === "dmg");
        this.apuPendingClocks = postWriteClocks;
        this.io[0x26] = 0;
      } else {
        const wasPowered = !!(this.io[0x26] & 0x80);
        this.io[0x26] = 0x80;
        if (!wasPowered) {
          // Powering the APU on during the high half of its DIV clock leaves
          // the first falling edge disconnected from the frame sequencer.
          // Production CGB silicon therefore delays all length, sweep, and
          // envelope phases by one 512 Hz event in this case.
          this.audioFrameStep = 0;
          this.apuSkipFrameEvent = this.apuDividerSignal();
        }
        this.refreshAudioSteps();
      }
      return;
    }
    if (register >= 0x30 && register <= 0x3f) {
      if (this.ch3.enabled) {
        if (this.model !== "dmg" || this.ch3.waveAccess > 0) {
          this.io[0x30 + (this.ch3.wavePosition >> 1)] = value;
        }
      } else this.io[register] = value;
      return;
    }
    if (!(this.io[0x26] & 0x80)) {
      // DMG length counters remain writable and retain their value while the
      // APU is powered down. Other sound-register writes are ignored.
      if (this.model !== "dmg" || ![0x11, 0x16, 0x1b, 0x20].includes(register)) return;
      if (register === 0x11) this.ch1.length = 64 - (value & 0x3f);
      else if (register === 0x16) this.ch2.length = 64 - (value & 0x3f);
      else if (register === 0x1b) this.ch3.length = 256 - value;
      else this.ch4.length = 64 - (value & 0x3f);
      return;
    }
    const previous = this.io[register];
    if (
      register === 0x10
      && this.ch1.sweepNegated
      && (previous & 0x08)
      && !(value & 0x08)
    ) {
      this.ch1.enabled = false;
    }
    if (register === 0x12 && this.ch1.enabled) {
      this.applyEnvelopeWriteGlitch(this.ch1, value, previous);
    } else if (register === 0x17 && this.ch2.enabled) {
      this.applyEnvelopeWriteGlitch(this.ch2, value, previous);
    } else if (register === 0x21 && this.ch4.enabled) {
      this.applyEnvelopeWriteGlitch(this.ch4, value, previous);
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
    if (register === 0x1a && !(value & 0x80)) {
      this.ch3.enabled = false;
      this.ch3.currentSample = 0;
    }
    if (register === 0x21 && (value & 0xf8) === 0) this.ch4.enabled = false;
    if (register === 0x14) {
      if (value & 0x80) {
        this.prepareTriggeredLength(this.ch1, previous, value);
        this.triggerSquare(this.ch1, 0x12);
      }
      this.applyLengthControl(this.ch1, previous, value, 64, !!(value & 0x80));
    }
    if (register === 0x19) {
      if (value & 0x80) {
        this.prepareTriggeredLength(this.ch2, previous, value);
        this.triggerSquare(this.ch2, 0x17);
      }
      this.applyLengthControl(this.ch2, previous, value, 64, !!(value & 0x80));
    }
    if (register === 0x1e && (value & 0x80)) {
      const wasEnabled = this.ch3.enabled;
      this.prepareTriggeredLength(this.ch3, previous, value);
      if (this.model === "dmg" && this.ch3.enabled && this.ch3.timer <= 2) {
        const source = ((this.ch3.wavePosition + 1) >> 1) & 0x0f;
        if (source < 4) this.io[0x30] = this.io[0x30 + source];
        else {
          const base = source & ~3;
          const block = this.io.slice(0x30 + base, 0x34 + base);
          for (let index = 0; index < 4; index += 1) this.io[0x30 + index] = block[index];
        }
      }
      this.ch3.enabled = !!(this.io[0x1a] & 0x80);
      if (this.ch3.length === 0) this.ch3.length = 256;
      this.ch3.phase = 0;
      this.ch3.wavePosition = 0;
      this.ch3.waveAccess = 0;
      if (!wasEnabled) this.ch3.currentSample = 0;
      this.ch3.timer = this.ch3.timerPeriod + 6;
    }
    if (register === 0x1e) {
      this.applyLengthControl(this.ch3, previous, value, 256, !!(value & 0x80));
    }
    if (register === 0x23 && (value & 0x80)) {
      const wasEnabled = this.ch4.enabled;
      this.prepareTriggeredLength(this.ch4, previous, value);
      this.updateNoiseStep();
      this.ch4.enabled = (this.io[0x21] & 0xf8) !== 0;
      if (this.ch4.length === 0) this.ch4.length = 64;
      this.ch4.volume = this.io[0x21] >> 4;
      this.ch4.envCounter = (this.io[0x21] & 7) || 8;
      this.ch4.envRunning = this.ch4.enabled
        && (this.model === "cgb" || (this.io[0x21] & 7) !== 0);
      this.ch4.lfsr = 0x7fff;
      this.ch4.phase = 0;
      this.ch4.timer = this.noiseTriggerPeriod() + (wasEnabled ? 8 : 0);
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

  applyEnvelopeWriteGlitch(channel, value, previous) {
    // CGB-D's envelope counter is wired directly to NRx2. Changing period or
    // direction while a channel is live can clock or invert the current
    // volume even though no frame-sequencer envelope step occurred.
    let shouldTick = !!(value & 7) && !(previous & 7);
    const directionChanged = !!((value ^ previous) & 8);
    if ((value & 0x0f) === 8 && (previous & 0x0f) === 8) shouldTick = true;
    if (directionChanged) {
      if (value & 8) {
        channel.volume = !(previous & 7)
          ? channel.volume ^ 0x0f
          : (0x0e - channel.volume) & 0x0f;
        shouldTick = false;
      } else {
        channel.volume = (0x10 - channel.volume) & 0x0f;
      }
    }
    if (shouldTick) {
      channel.volume = (channel.volume + ((value & 8) ? 1 : -1)) & 0x0f;
    }
  }

  prepareTriggeredLength(channel, previous, value) {
    const enablingLength = !(previous & 0x40) && !!(value & 0x40);
    if (enablingLength && (this.audioFrameStep & 1) === 1 && channel.length === 1) {
      // Length enable clocks first. A simultaneous trigger then reloads the
      // counter and subjects that reload to the trigger-side extra clock.
      channel.length = 0;
    }
  }

  triggerSquare(channel, envelopeRegister) {
    const wasEnabled = channel.enabled;
    channel.enabled = (this.io[envelopeRegister] & 0xf8) !== 0;
    if (channel.length === 0) channel.length = 64;
    channel.volume = this.io[envelopeRegister] >> 4;
    channel.envCounter = (this.io[envelopeRegister] & 7) || 8;
    channel.envRunning = channel.enabled
      && (this.model === "cgb" || (this.io[envelopeRegister] & 7) !== 0);
    // Trigger resets the period timer but not the duty step counter.
    channel.phase = Math.floor(channel.phase * 8) / 8;
    channel.sampleSuppressed = channel.enabled && !wasEnabled;
    // CGB-D pulse startup includes a three-clock pipeline delay. Restarting a
    // live pulse reuses two stages of that pipeline, so it starts two clocks
    // earlier while retaining its duty phase.
    channel.timer = channel.timerPeriod
      + (wasEnabled ? 1 : 7)
      + (this.doubleSpeed ? 1 : 0)
      + ((4 - this.apuSquarePhase) & 3);
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

  noiseTimerPeriod() {
    const nr43 = this.io[0x22];
    const shift = nr43 >> 4;
    return shift >= 14 ? 0x7fffffff : NOISE_PERIODS[nr43 & 7] << shift;
  }

  noiseTriggerPeriod() {
    const nr43 = this.io[0x22];
    const divisor = nr43 & 7;
    const shift = nr43 >> 4;
    if (shift >= 14) return 0x7fffffff;
    if (divisor === 0) {
      // Divisor zero is implemented by a background 1 MHz counter, not by a
      // literal eight-clock reload. Its first selected-bit edge is 8 +
      // 4*2^shift clocks away, with the 1 MHz phase retained across starts.
      return 8 + (4 << shift) + this.apuSquarePhase;
    }
    return this.noiseTimerPeriod();
  }

  updateSquareStep(channel, lowRegister, highRegister) {
    if (!channel) return;
    const frequency = this.squareFrequency(lowRegister, highRegister);
    channel.timerPeriod = Math.max(4, (2048 - frequency) * 4);
    if (channel.justReloaded) channel.timer = channel.timerPeriod;
    channel.phaseStep = 131072 / Math.max(1, 2048 - frequency) / this.audioRate;
  }

  updateWaveStep() {
    if (!this.ch3) return;
    const frequency = this.squareFrequency(0x1d, 0x1e);
    this.ch3.timerPeriod = Math.max(2, (2048 - frequency) * 2);
    this.ch3.phaseStep = 65536 / Math.max(1, 2048 - frequency) / this.audioRate;
  }

  updateNoiseStep() {
    if (!this.ch4) return;
    const period = this.noiseTimerPeriod();
    this.ch4.timerPeriod = period;
    this.ch4.phaseStep = period >= 0x7fffffff ? 0 : CPU_CLOCK / period / this.audioRate;
  }

  refreshAudioSteps() {
    this.updateSquareStep(this.ch1, 0x13, 0x14);
    this.updateSquareStep(this.ch2, 0x18, 0x19);
    this.updateWaveStep();
    this.updateNoiseStep();
  }

  tickAPU() {
    this.apuPendingClocks += 1;
    this.flushAPU();
  }

  flushAPU(deferredClocks = 0) {
    const deferred = Math.min(this.apuPendingClocks, deferredClocks);
    const clocks = this.apuPendingClocks - deferred;
    if (clocks <= 0) return;
    this.apuPendingClocks = deferred;
    this.advanceAPU(clocks);
  }

  advanceAPU(clocks) {
    // CPU bus operations advance in short T-cycle batches. Jump between the
    // next waveform/sample event rather than touching four channel timers on
    // every individual clock. Events are still resolved in hardware order:
    // all channel timers first, then the DAC sample for that same T-cycle.
    this.ch1.justReloaded = false;
    this.ch2.justReloaded = false;
    while (clocks > 0) {
      const powered = !!(this.io[0x26] & 0x80);
      const clocksToSample = Math.max(
        1,
        Math.ceil((CPU_CLOCK - this.audioClock) / this.audioRate),
      );
      let advance = Math.min(clocks, clocksToSample);
      if (powered) {
        advance = Math.min(
          advance,
          this.ch1.enabled ? Math.max(1, this.ch1.timer) : advance,
          this.ch2.enabled ? Math.max(1, this.ch2.timer) : advance,
          this.ch3.enabled ? Math.max(1, this.ch3.timer) : advance,
          this.ch4.enabled ? Math.max(1, this.ch4.timer) : advance,
        );
        if (this.ch1.enabled) this.ch1.timer -= advance;
        if (this.ch2.enabled) this.ch2.timer -= advance;
        if (this.ch3.enabled) {
          this.ch3.timer -= advance;
          this.ch3.waveAccess = Math.max(0, this.ch3.waveAccess - advance);
        }
        if (this.ch4.enabled) this.ch4.timer -= advance;
      }
      this.integrateAudioLevel(advance);
      if (powered) this.apuSquarePhase = (this.apuSquarePhase + advance) & 3;
      clocks -= advance;

      if (powered) {
        if (this.ch1.enabled && this.ch1.timer <= 0) {
          this.ch1.timer += this.ch1.timerPeriod;
          this.ch1.dutyPosition = (this.ch1.dutyPosition + 1) & 7;
          this.ch1.duty = this.io[0x11] >> 6;
          this.ch1.sampleSuppressed = false;
          this.ch1.justReloaded = clocks === 0;
        }
        if (this.ch2.enabled && this.ch2.timer <= 0) {
          this.ch2.timer += this.ch2.timerPeriod;
          this.ch2.dutyPosition = (this.ch2.dutyPosition + 1) & 7;
          this.ch2.duty = this.io[0x16] >> 6;
          this.ch2.sampleSuppressed = false;
          this.ch2.justReloaded = clocks === 0;
        }
        if (this.ch3.enabled && this.ch3.timer <= 0) {
          this.ch3.timer += this.ch3.timerPeriod;
          this.ch3.wavePosition = (this.ch3.wavePosition + 1) & 31;
          const byte = this.io[0x30 + (this.ch3.wavePosition >> 1)];
          this.ch3.currentSample = (this.ch3.wavePosition & 1)
            ? byte & 0x0f
            : byte >> 4;
          this.ch3.waveAccess = 1;
        }
        if (this.ch4.enabled && this.ch4.timer <= 0) {
          this.ch4.timer += this.ch4.timerPeriod;
          const bit = (this.ch4.lfsr & 1) ^ ((this.ch4.lfsr >> 1) & 1);
          this.ch4.lfsr = (this.ch4.lfsr >> 1) | (bit << 14);
          if (this.io[0x22] & 8) {
            this.ch4.lfsr = (this.ch4.lfsr & ~(1 << 6)) | (bit << 6);
          }
        }
      }
    }
  }

  clockAPUFrameSequencer() {
    if (!(this.io[0x26] & 0x80)) return;
    if (this.apuSkipFrameEvent) {
      this.apuSkipFrameEvent = false;
      return;
    }
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
      const period = (this.io[register] & 7) || 8;
      if (!channel.enabled || !channel.envRunning) continue;
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

  calculateAudioLevel() {
    const outputs = this.audioMix;
    outputs[0] = 0;
    outputs[1] = 0;
    outputs[2] = 0;
    outputs[3] = 0;
    for (let index = 0; index < 2; index += 1) {
      const channel = index === 0 ? this.ch1 : this.ch2;
      if (!channel.enabled || channel.sampleSuppressed) continue;
      outputs[index] = (
        DUTY_PATTERNS[channel.duty][channel.dutyPosition] ? 1 : -1
      ) * (channel.volume / 15);
    }

    if (this.ch3.enabled && (this.io[0x1a] & 0x80)) {
      let sample = this.ch3.currentSample;
      const level = (this.io[0x1c] >> 5) & 3;
      sample = level === 0 ? 0 : sample >> (level - 1);
      outputs[2] = sample / 7.5 - 1;
    }

    if (this.ch4.enabled) {
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
    outputs[4] = left;
    outputs[5] = right;
    return outputs;
  }

  integrateAudioLevel(clocks) {
    const outputs = this.calculateAudioLevel();
    let phase = clocks * this.audioRate;
    const untilSample = CPU_CLOCK - this.audioClock;
    if (phase < untilSample) {
      this.audioIntegralLeft += outputs[4] * phase;
      this.audioIntegralRight += outputs[5] * phase;
      this.audioClock += phase;
      return;
    }

    this.audioIntegralLeft += outputs[4] * untilSample;
    this.audioIntegralRight += outputs[5] * untilSample;
    this.pushAudioSample(
      this.audioIntegralLeft / CPU_CLOCK,
      this.audioIntegralRight / CPU_CLOCK,
    );
    phase -= untilSample;
    this.audioClock = phase;
    this.audioIntegralLeft = outputs[4] * phase;
    this.audioIntegralRight = outputs[5] * phase;
  }

  pushAudioSample(left, right) {
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
    this.flushAPU();
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
    if (this.speedSwitchCycles > 0) {
      const stall = this.speedSwitchCycles;
      this.speedSwitchCycles = 0;
      this.tick(stall);
      this.doubleSpeed = !this.doubleSpeed;
      this.speedSubcycle = 0;
      this.stopped = false;
      return stall;
    }
    if (this.hdmaStallCycles > 0) {
      const stall = this.hdmaStallCycles;
      this.hdmaStallCycles = 0;
      this.tick(stall);
      return stall;
    }
    if (this.locked) {
      this.tick(4);
      return 4;
    }
    const pending = this.ie & this.iflag & 0x1f;
    if (this.halted) {
      if (pending) {
        this.halted = false;
        if (this.hdmaActive && this.ppuMode === 0 && this.ly < 144) {
          this.startHDMABlock();
          if (this.hdmaStallCycles > 0) {
            const stall = this.hdmaStallCycles;
            this.hdmaStallCycles = 0;
            this.tick(stall);
            return stall;
          }
        }
      }
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

  serviceInterrupt() {
    this.ime = false;
    this.imeDelay = 0;
    // Each entry M-cycle remains observable on the bus. In particular, the
    // high-byte stack push can write IE when SP=$0000, cancelling or
    // reprioritising the dispatch. A change made by the low push is too late.
    this.cpuRead(this.pc, true);
    this.cpuInternalCycle(this.sp);
    this.sp = (this.sp - 1) & 0xffff;
    this.cpuWrite(this.sp, this.pc >> 8);
    let queue = this.ie & 0x1f;
    this.sp = (this.sp - 1) & 0xffff;
    this.cpuWrite(this.sp, this.pc);
    queue &= this.iflag & 0x1f;
    if (queue) {
      let bit = 0;
      while (!(queue & (1 << bit))) bit += 1;
      this.iflag &= ~(1 << bit);
      this.pc = 0x40 + bit * 8;
    } else {
      this.pc = 0;
    }
    this.cpuInternalCycle();
    return 20;
  }

  execute(opcode) {
    if (ILLEGAL_OPCODES[opcode]) {
      // These unassigned SM83 opcodes permanently lock the CPU until reset.
      // Interrupts cannot recover the processor, although the other hardware
      // clock domains continue to run.
      this.locked = true;
      return 4;
    }
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
          this.writeIO(0x04, 0);
          if (this.cgbMode && this.speedSwitchArmed) {
            this.speedSwitchArmed = false;
            this.stopped = true;
            this.speedSwitchCycles = 8200;
          } else this.stopped = true;
          return 8;
        }
        if (y === 3) {
          value = signed8(this.fetch8());
          const oldPc = this.pc;
          this.pc = clamp16(this.pc + value);
          this.cpuInternalCycle(oldPc);
          return 12;
        }
        value = signed8(this.fetch8());
        if (this.condition(y - 4)) {
          const oldPc = this.pc;
          this.pc = clamp16(this.pc + value);
          this.cpuInternalCycle(oldPc);
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
        this.cpuInternalCycle();
        this.f = (this.f & FLAG_Z) | (((hl & 0xfff) + (value & 0xfff) > 0xfff) ? FLAG_H : 0) | (result > 0xffff ? FLAG_C : 0);
        this.setHL(result);
        return 8;
      }
      if (z === 2) {
        address = p === 0 ? this.getBC() : p === 1 ? this.getDE() : this.getHL();
        if (!q) this.cpuWrite(address, this.a);
        else this.a = this.cpuRead(address, p >= 2);
        if (p === 2) this.setHL(address + 1);
        if (p === 3) this.setHL(address - 1);
        return 8;
      }
      if (z === 3) {
        const pair = this.getPair(p);
        this.cpuInternalCycle(pair);
        this.setPair(p, pair + (q ? -1 : 1));
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
        if (!this.ime && (this.ie & this.iflag & 0x1f)) {
          if (this.imeDelay === 1) {
            // EI followed immediately by HALT is its own hardware case: IME
            // becomes active at this boundary and the buffered interrupt
            // returns to the HALT opcode itself. Subsequent pending sources are
            // then serviced before HALT is re-fetched.
            this.pc = (this.pc - 1) & 0xffff;
            this.halted = true;
          } else {
            this.haltBug = true;
          }
        } else this.halted = true;
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
        this.cpuInternalCycle();
        if (this.condition(y)) {
          this.pc = this.pop16();
          this.cpuInternalCycle();
          return 20;
        }
        return 8;
      }
      if (y === 4) { this.cpuWrite(0xff00 | this.fetch8(), this.a); return 12; }
      if (y === 5) {
        value = signed8(this.fetch8());
        const old = this.sp;
        this.cpuInternalCycle();
        this.cpuInternalCycle();
        result = clamp16(old + value);
        this.f = (((old & 0xf) + (value & 0xf) > 0xf) ? FLAG_H : 0) | (((old & 0xff) + (value & 0xff) > 0xff) ? FLAG_C : 0);
        this.sp = result;
        return 16;
      }
      if (y === 6) { this.a = this.cpuRead(0xff00 | this.fetch8()); return 12; }
      value = signed8(this.fetch8());
      this.cpuInternalCycle();
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
      if (p === 0) {
        this.pc = this.pop16();
        this.cpuInternalCycle();
        return 16;
      }
      if (p === 1) {
        this.pc = this.pop16();
        this.cpuInternalCycle();
        this.ime = true;
        this.imeDelay = 0;
        return 16;
      }
      if (p === 2) { this.pc = this.getHL(); return 4; }
      this.cpuInternalCycle(this.getHL());
      this.sp = this.getHL();
      return 8;
    }

    if (z === 2) {
      if (y < 4) {
        address = this.fetch16();
        if (this.condition(y)) {
          this.pc = address;
          this.cpuInternalCycle();
          return 16;
        }
        return 12;
      }
      if (y === 4) { this.cpuWrite(0xff00 | this.c, this.a); return 8; }
      if (y === 5) { this.cpuWrite(this.fetch16(), this.a); return 16; }
      if (y === 6) { this.a = this.cpuRead(0xff00 | this.c); return 8; }
      this.a = this.cpuRead(this.fetch16());
      return 16;
    }

    if (z === 3) {
      if (y === 0) {
        this.pc = this.fetch16();
        this.cpuInternalCycle();
        return 16;
      }
      if (y === 1) return this.executeCB(this.fetch8());
      if (y === 6) { this.ime = false; this.imeDelay = 0; return 4; }
      if (y === 7) {
        // Repeated EI instructions do not continually postpone the enable.
        // Once scheduled, IME becomes active after the following instruction.
        if (!this.ime && this.imeDelay === 0) this.imeDelay = 2;
        return 4;
      }
      return 4;
    }

    if (z === 4) {
      if (y < 4) {
        address = this.fetch16();
        if (this.condition(y)) {
          this.cpuInternalCycle(this.sp);
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
        this.cpuInternalCycle(this.sp);
        this.push16(this.getStackPair(p));
        return 16;
      }
      if (p === 0) {
        address = this.fetch16();
        this.cpuInternalCycle(this.sp);
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

    this.cpuInternalCycle(this.sp);
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
    const startBase = this.baseCycles;
    if (maxCycles !== null) {
      while (!this.frameReady && this.cycles - start < maxCycles) this.step();
    } else {
      // VBlank normally supplies the host-frame boundary. With LCDC disabled
      // there is no VBlank, so fall back to one base-clock frame rather than
      // the old fixed two-frame CPU budget. This keeps menus, fades, and games
      // that deliberately blank the LCD at the real 59.7275 Hz cadence in
      // both normal and double-speed modes.
      while (!this.frameReady && this.baseCycles - startBase < FRAME_CYCLES) this.step();
    }
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
    this.flushAPU();
    this.catchUpPixelTransfer();
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
        lineSprites: this.lineSprites.map((sprite) => ({ ...sprite })),
        lineSpriteStalls: this.lineSpriteStalls.slice(),
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
    this.rebuildDecodedTiles();
    if (this.ppuMode === 3 && this.ly < SCREEN_HEIGHT) {
      const savedSprites = Array.isArray(memory.lineSprites)
        ? memory.lineSprites
        : null;
      if (savedSprites) {
        this.lineSprites.length = 0;
        for (let index = 0; index < Math.min(10, savedSprites.length); index += 1) {
          const saved = savedSprites[index];
          const sprite = this.lineSpritePool[index];
          sprite.index = saved.index;
          sprite.y = saved.y;
          sprite.rawX = saved.rawX;
          sprite.x = saved.x;
          sprite.tile = saved.tile;
          sprite.attr = saved.attr;
          this.lineSprites.push(sprite);
        }
      } else {
        this.prepareLineObjects(this.ly);
      }
      if (memory.lineSpriteStalls?.length === this.lineSpriteStalls.length) {
        this.lineSpriteStalls.set(memory.lineSpriteStalls);
      } else {
        for (let x = 0; x <= this.ppuTransferX && x < SCREEN_WIDTH; x += 1) {
          this.lineSpriteStalls[x] = 0;
        }
      }
    } else {
      this.lineSprites.length = 0;
      this.lineSpriteStalls.fill(0);
    }
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
