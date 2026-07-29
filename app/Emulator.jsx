"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CGB_COMPATIBILITY_PALETTES,
  GAMEBOY_HEIGHT,
  GAMEBOY_WIDTH,
  GameBoy,
} from "./lib/gameboy";
import { getEmbeddedBootROM } from "./lib/embeddedBios";
import { LCDShaderRenderer } from "./lib/lcdShader";
import {
  createSaveArchive,
  parseSaveArchive,
  replaceSaveArchive,
} from "./lib/saveArchive";
import { EMBEDDED_LIBRARY_ROMS } from "virtual:gameboy-lab-library";
import {
  createFallbackArtwork,
  getLibraryRom,
  listLibraryRoms,
  putLibraryRom,
  readRomTitle,
  removeLibraryRom,
  resolveRomArtwork,
} from "./lib/romLibrary";
import { APP_VERSION, findAvailableUpdate } from "./version";

const DEFAULT_BINDINGS = {
  right: "ArrowRight",
  left: "ArrowLeft",
  up: "ArrowUp",
  down: "ArrowDown",
  a: "KeyX",
  b: "KeyZ",
  start: "Enter",
  select: "ShiftLeft",
};

const BINDING_ORDER = ["up", "down", "left", "right", "a", "b", "select", "start"];
const LIBRARY_DISCOVERY_KEY = "gameboy-lab-library-discovery-v1";
const SCALING_DEFAULTS_VERSION = 1;
const SCREEN_ONLY_FRAME_BORDER = 8;
const SCREEN_ONLY_BEZEL_OUTLINE = 8;
const SCREEN_ONLY_CARTRIDGE_OVERHANG = 20;
const SCREEN_ONLY_CARTRIDGE_CENTER_OFFSET = (
  SCREEN_ONLY_CARTRIDGE_OVERHANG - SCREEN_ONLY_BEZEL_OUTLINE
) / 2;
const SCREEN_ONLY_EDGE_GUARD = 1;
const CARTRIDGE_DUCK_DURATION = 250;
const SAVE_TOOLTIP_DURATION = 1500;
const TECHNICAL_READOUT_MEDIA = "(min-width: 1180px)";

function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="64" height="64" fill="#17191e" />
      <path
        d="M12 7H52V53L46 59H18L12 53Z"
        fill="#f1f0e9"
      />
      <rect x="16" y="12" width="32" height="25" fill="#292c33" />
      <rect x="20" y="26" width="4" height="7" fill="#c6f050" />
      <rect x="26" y="21" width="4" height="12" fill="#42d6d0" />
      <rect x="32" y="17" width="4" height="16" fill="#f05a88" />
      <rect x="38" y="23" width="4" height="10" fill="#f1f0e9" />
      <path d="M25 41v13M18.5 47.5h13" stroke="#292c33" strokeWidth="5" />
      <rect x="36" y="46" width="7" height="7" fill="#f05a88" />
      <rect x="45" y="41" width="7" height="7" fill="#42d6d0" />
    </svg>
  );
}

function keyLabel(code) {
  const labels = {
    ArrowRight: "→",
    ArrowLeft: "←",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Enter: "ENTER",
    Space: "SPACE",
    ShiftLeft: "L SHIFT",
    ShiftRight: "R SHIFT",
    ControlLeft: "L CTRL",
    ControlRight: "R CTRL",
  };
  return labels[code] ?? code.replace(/^Key/, "").replace(/^Digit/, "");
}

const EMPTY_INFO = {
  title: "NO CARTRIDGE",
  mapper: "—",
  romSize: 0,
  ramSize: 0,
  checksumValid: false,
  logoValid: false,
  cgb: false,
  battery: false,
  rtc: false,
};

function formatBytes(bytes) {
  if (!bytes) return "—";
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

function formatSavedAt(timestamp) {
  if (!timestamp) return "EMPTY";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp)).toUpperCase();
}

function formatLibraryDate(timestamp) {
  if (!timestamp) return "NEVER";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp)).toUpperCase();
}

function modelLabel(model) {
  return model === "cgb" ? "GBC" : "DMG";
}

function hashBytes(bytes) {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i += 257) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function bytesToBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return btoa(text);
}

function base64ToBytes(value) {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function getEmbeddedLibraryRom(entry) {
  if (!entry?.romBase64) {
    throw new Error("This built-in cartridge is missing its embedded ROM data.");
  }
  return base64ToBytes(entry.romBase64);
}

function createBuiltInLibraryRecord(entry, existing = null) {
  return {
    ...existing,
    ...entry,
    addedAt: existing?.addedAt || 0,
    lastPlayedAt: existing?.lastPlayedAt || 0,
    builtIn: true,
  };
}

function createBuiltInLibraryRecords(existingRecords = []) {
  const existingById = new Map(existingRecords.map((record) => [record.id, record]));
  return EMBEDDED_LIBRARY_ROMS.map((entry) => (
    createBuiltInLibraryRecord(entry, existingById.get(entry.id))
  ));
}

function encodeStateValue(value) {
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) {
    return { __bytes: bytesToBase64(value) };
  }
  if (Array.isArray(value)) return value.map(encodeStateValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeStateValue(item)]));
  }
  return value;
}

function decodeStateValue(value) {
  if (value?.__bytes) return base64ToBytes(value.__bytes);
  if (Array.isArray(value)) return value.map(decodeStateValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeStateValue(item)]));
  }
  return value;
}

function safeFileStem(value) {
  return (value || "game")
    .replace(/\.(gbc?|sav)$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    || "game";
}

function downloadBytes(bytes, name, type = "application/octet-stream") {
  const blob = new window.Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function afterNextPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  });
}

const AUDIO_LATENCY_PRESETS = {
  low: { label: "Low", target: 768, buffer: 1024, maximum: 2816 },
  balanced: { label: "Balanced", target: 1280, buffer: 2048, maximum: 3328 },
  stable: { label: "Stable", target: 2560, buffer: 4096, maximum: 5120 },
  deep: { label: "Deep", target: 4096, buffer: 4096, maximum: 8192 },
};

const CATCH_UP_BUDGETS = {
  cool: { label: "Cool", milliseconds: 4 },
  balanced: { label: "Balanced", milliseconds: 8 },
  aggressive: { label: "Aggressive", milliseconds: 14 },
};

const FRAME_SKIP_PRESETS = {
  off: { label: "Off", frames: 0 },
  one: { label: "Skip 1", frames: 1 },
  two: { label: "Skip 2", frames: 2 },
  auto: { label: "Auto", frames: "auto" },
};

const MINIMUM_BUTTON_PRESS_MS = 50;

const AUDIO_WORKLET_SOURCE = `
class GbLabAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.chunkIndex = 0;
    this.offset = 0;
    this.buffered = 0;
    this.target = 1280;
    this.maximum = 3328;
    this.started = false;
    this.ramp = 0;
    this.gain = .7;
    this.filter = true;
    this.previousInputLeft = 0;
    this.previousInputRight = 0;
    this.previousOutputLeft = 0;
    this.previousOutputRight = 0;
    this.correction = 0;
    this.callbacks = 0;
    this.underruns = 0;
    this.overruns = 0;
    this.peak = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "samples") {
        const samples = new Float32Array(data.buffer);
        if (samples.length >= 2) {
          this.chunks.push(samples);
          this.buffered += samples.length >> 1;
          if (this.buffered > this.maximum) {
            this.trimFrames(this.buffered - this.maximum);
            this.overruns += 1;
            this.ramp = 0;
          }
        }
      } else if (data.type === "settings") {
        this.target = data.target;
        this.maximum = Math.max(data.maximum, data.target + 512);
        this.gain = data.gain;
        this.filter = data.filter;
        if (this.buffered > this.maximum) {
          this.trimFrames(this.buffered - this.maximum);
        }
      } else if (data.type === "reset") {
        this.chunks.length = 0;
        this.chunkIndex = 0;
        this.offset = 0;
        this.buffered = 0;
        this.started = false;
        this.ramp = 0;
        this.correction = 0;
        this.underruns = 0;
        this.overruns = 0;
        this.peak = 0;
        this.previousInputLeft = 0;
        this.previousInputRight = 0;
        this.previousOutputLeft = 0;
        this.previousOutputRight = 0;
      }
    };
  }
  compactChunks() {
    if (this.chunkIndex > 24 && this.chunkIndex * 2 >= this.chunks.length) {
      this.chunks.splice(0, this.chunkIndex);
      this.chunkIndex = 0;
    }
  }
  trimFrames(frames) {
    let remaining = Math.max(0, Math.min(frames, this.buffered));
    while (remaining > 0 && this.chunkIndex < this.chunks.length) {
      const chunk = this.chunks[this.chunkIndex];
      const available = (chunk.length - this.offset) >> 1;
      const consumed = Math.min(remaining, available);
      this.offset += consumed * 2;
      this.buffered -= consumed;
      remaining -= consumed;
      if (this.offset >= chunk.length) {
        this.chunkIndex += 1;
        this.offset = 0;
      }
    }
    this.compactChunks();
  }
  process(inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    if (!this.started && this.buffered >= this.target) {
      this.started = true;
      this.ramp = 0;
    }
    const highWater = this.target + 1024;
    const correctionRate = this.buffered > highWater
      ? Math.min(.02, .002 + (this.buffered - highWater) / Math.max(1, this.maximum) * .018)
      : 0;
    let peak = 0;
    for (let index = 0; index < left.length; index += 1) {
      let leftSample = 0;
      let rightSample = 0;
      if (this.started && this.buffered > 0 && this.chunkIndex < this.chunks.length) {
        const chunk = this.chunks[this.chunkIndex];
        leftSample = chunk[this.offset] || 0;
        rightSample = chunk[this.offset + 1] || 0;
        this.offset += 2;
        this.buffered -= 1;
        if (this.offset >= chunk.length) {
          this.chunkIndex += 1;
          this.offset = 0;
          this.compactChunks();
        }
      } else if (this.started) {
        this.started = false;
        this.ramp = 0;
        this.underruns += 1;
      }
      if (correctionRate && this.buffered > this.target) {
        this.correction += correctionRate;
        if (this.correction >= 1) {
          this.trimFrames(1);
          this.correction -= 1;
        }
      }
      if (this.filter) {
        const filteredLeft = leftSample - this.previousInputLeft + .995 * this.previousOutputLeft;
        const filteredRight = rightSample - this.previousInputRight + .995 * this.previousOutputRight;
        this.previousInputLeft = leftSample;
        this.previousInputRight = rightSample;
        this.previousOutputLeft = filteredLeft;
        this.previousOutputRight = filteredRight;
        leftSample = filteredLeft;
        rightSample = filteredRight;
      }
      this.ramp = Math.min(1, this.ramp + 1 / 128);
      left[index] = leftSample * this.gain * this.ramp;
      right[index] = rightSample * this.gain * this.ramp;
      peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
    }
    this.peak = Math.max(this.peak, peak);
    this.callbacks += 1;
    if ((this.callbacks & 15) === 0) {
      this.port.postMessage({
        buffered: this.buffered,
        underruns: this.underruns,
        overruns: this.overruns,
        peak: this.peak,
      });
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor("gbc-lab-audio", GbLabAudioProcessor);
`;

function createEmulator(model, compatibilityPalette = "auto", audioRate = 48000) {
  const emulator = new GameBoy(model);
  emulator.setCompatibilityPalette(compatibilityPalette);
  emulator.setBootROM(getEmbeddedBootROM(model));
  emulator.setAudioSampleRate(audioRate);
  return emulator;
}

const PIXEL_FONT = {
  " ": "00000/00000/00000/00000/00000/00000/00000",
  "?": "01110/10001/00010/00100/00100/00000/00100",
  ".": "00000/00000/00000/00000/00000/00110/00110",
  "-": "00000/00000/00000/11111/00000/00000/00000",
  "/": "00001/00010/00100/01000/10000/00000/00000",
  ":": "00000/00100/00100/00000/00100/00100/00000",
  "0": "01110/10001/10011/10101/11001/10001/01110",
  "1": "00100/01100/00100/00100/00100/00100/01110",
  "2": "01110/10001/00001/00010/00100/01000/11111",
  "3": "11110/00001/00001/01110/00001/00001/11110",
  "4": "00010/00110/01010/10010/11111/00010/00010",
  "5": "11111/10000/10000/11110/00001/00001/11110",
  "6": "01110/10000/10000/11110/10001/10001/01110",
  "7": "11111/00001/00010/00100/01000/01000/01000",
  "8": "01110/10001/10001/01110/10001/10001/01110",
  "9": "01110/10001/10001/01111/00001/00001/01110",
  A: "01110/10001/10001/11111/10001/10001/10001",
  B: "11110/10001/10001/11110/10001/10001/11110",
  C: "01111/10000/10000/10000/10000/10000/01111",
  D: "11110/10001/10001/10001/10001/10001/11110",
  E: "11111/10000/10000/11110/10000/10000/11111",
  F: "11111/10000/10000/11110/10000/10000/10000",
  G: "01111/10000/10000/10111/10001/10001/01111",
  H: "10001/10001/10001/11111/10001/10001/10001",
  I: "01110/00100/00100/00100/00100/00100/01110",
  J: "00111/00010/00010/00010/00010/10010/01100",
  K: "10001/10010/10100/11000/10100/10010/10001",
  L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001",
  N: "10001/11001/10101/10011/10001/10001/10001",
  O: "01110/10001/10001/10001/10001/10001/01110",
  P: "11110/10001/10001/11110/10000/10000/10000",
  Q: "01110/10001/10001/10001/10101/10010/01101",
  R: "11110/10001/10001/11110/10100/10010/10001",
  S: "01111/10000/10000/01110/00001/00001/11110",
  T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110",
  V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/10101/01010",
  X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100",
  Z: "11111/00001/00010/00100/01000/10000/11111",
};

function fillPixelRect(image, x, y, width, height, color) {
  const rawX = Math.round(x);
  const rawY = Math.round(y);
  const startX = Math.max(0, rawX);
  const startY = Math.max(0, rawY);
  const endX = Math.min(GAMEBOY_WIDTH, rawX + Math.round(width));
  const endY = Math.min(GAMEBOY_HEIGHT, rawY + Math.round(height));
  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      const offset = (py * GAMEBOY_WIDTH + px) * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = color[3] ?? 255;
    }
  }
}

function fillPixelScreen(image, color) {
  fillPixelRect(image, 0, 0, GAMEBOY_WIDTH, GAMEBOY_HEIGHT, color);
}

function drawPixelText(image, text, anchorX, y, color, scale = 1, align = "left") {
  const normalized = String(text).toUpperCase();
  const width = Math.max(0, (normalized.length * 6 - 1) * scale);
  let x = Math.round(anchorX);
  if (align === "center") x -= Math.floor(width / 2);
  if (align === "right") x -= width;
  for (const character of normalized) {
    const rows = (PIXEL_FONT[character] ?? PIXEL_FONT["?"]).split("/");
    rows.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel === "1") {
          fillPixelRect(
            image,
            x + columnIndex * scale,
            y + rowIndex * scale,
            scale,
            scale,
            color,
          );
        }
      });
    });
    x += 6 * scale;
  }
}

function drawPixelCartridge(image, model, y = 20) {
  const isColor = model === "cgb";
  const dark = isColor ? [47, 45, 61] : [24, 58, 52];
  const mid = isColor ? [112, 108, 128] : [92, 119, 87];
  const light = isColor ? [232, 232, 224] : [202, 220, 159];
  fillPixelRect(image, 59, y, 42, 30, dark);
  fillPixelRect(image, 61, y + 2, 38, 25, mid);
  fillPixelRect(image, 65, y + 6, 30, 13, light);
  fillPixelRect(image, 70, y + 22, 20, 3, dark);
  fillPixelRect(image, 77, y + 27, 6, 3, dark);
  if (isColor) {
    const colors = [
      [227, 72, 104],
      [117, 91, 176],
      [78, 170, 115],
      [211, 167, 57],
      [63, 125, 180],
    ];
    colors.forEach((color, index) => fillPixelRect(image, 68 + index * 5, y + 10, 3, 5, color));
  } else {
    drawPixelText(image, "GB", 80, y + 9, dark, 1, "center");
  }
}

function drawWaitingScreen(context, model) {
  const image = context.createImageData(GAMEBOY_WIDTH, GAMEBOY_HEIGHT);
  const isColor = model === "cgb";
  const background = isColor ? [232, 232, 224] : [202, 220, 159];
  const dark = isColor ? [48, 48, 56] : [24, 58, 52];
  fillPixelScreen(image, background);
  drawPixelCartridge(image, model, 17);
  drawPixelText(image, "INSERT", 80, 58, dark, 2, "center");
  drawPixelText(image, "CARTRIDGE", 80, 76, dark, 1, "center");
  fillPixelRect(image, 29, 90, 102, 1, dark);
  drawPixelText(image, "DROP .GB OR .GBC", 80, 99, dark, 1, "center");
  drawPixelText(image, "OPEN LIBRARY TO BROWSE", 80, 114, dark, 1, "center");
  fillPixelRect(image, 47, 127, 66, 1, dark);
  context.putImageData(image, 0, 0);
}

function drawDropScreen(context, model) {
  const image = context.createImageData(GAMEBOY_WIDTH, GAMEBOY_HEIGHT);
  const isColor = model === "cgb";
  const background = isColor ? [47, 45, 61] : [24, 58, 52];
  const foreground = isColor ? [244, 241, 233] : [202, 220, 159];
  const accent = isColor ? [227, 72, 104] : [111, 142, 94];
  fillPixelScreen(image, background);
  fillPixelRect(image, 5, 5, 150, 2, accent);
  fillPixelRect(image, 5, 137, 150, 2, accent);
  fillPixelRect(image, 5, 5, 2, 134, accent);
  fillPixelRect(image, 153, 5, 2, 134, accent);
  drawPixelCartridge(image, model, 21);
  drawPixelText(image, "RELEASE", 80, 61, foreground, 2, "center");
  drawPixelText(image, "TO LOAD", 80, 82, foreground, 1, "center");
  drawPixelText(image, ".GB / .GBC", 80, 101, accent, 1, "center");
  fillPixelRect(image, 53, 117, 54, 2, foreground);
  context.putImageData(image, 0, 0);
}

function drawBootScreen(context, model, progress, title) {
  const cgb = model === "cgb";
  const image = context.createImageData(GAMEBOY_WIDTH, GAMEBOY_HEIGHT);
  const background = cgb ? [244, 241, 233] : [202, 220, 159];
  const dark = cgb ? [47, 45, 61] : [28, 68, 60];
  fillPixelScreen(image, background);
  const eased = 1 - Math.pow(1 - Math.min(1, progress / 0.62), 3);
  const y = Math.round(-24 + eased * 86);
  if (cgb) {
    drawPixelText(image, "GAME BOY", 80, y, [77, 100, 180], 2, "center");
    const colorWord = "COLOR";
    const colorPalette = [
      [227, 72, 104],
      [117, 91, 176],
      [78, 170, 115],
      [211, 167, 57],
      [63, 125, 180],
    ];
    [...colorWord].forEach((letter, index) => {
      drawPixelText(image, letter, 65 + index * 6, y + 18, colorPalette[index]);
    });
  } else {
    drawPixelText(image, "GAME BOY", 80, y, dark, 2, "center");
    drawPixelText(image, "DOT MATRIX STEREO", 80, y + 18, dark, 1, "center");
  }
  if (progress > 0.62) {
    drawPixelText(image, "NINTENDO", 80, 99, dark, 1, "center");
    drawPixelText(image, title.slice(0, 18), 80, 116, dark, 1, "center");
  }
  if (progress > 0.9) {
    const fade = Math.min(1, (progress - 0.9) * 10);
    for (let py = 0; py < GAMEBOY_HEIGHT; py += 1) {
      for (let px = 0; px < GAMEBOY_WIDTH; px += 1) {
        if (((px * 3 + py * 5) % 16) / 16 < fade) {
          fillPixelRect(image, px, py, 1, 1, background);
        }
      }
    }
  }
  context.putImageData(image, 0, 0);
}

function ControlButton({ label, sublabel, button, onPress, pressed = false, className = "" }) {
  const stop = (event) => {
    event.preventDefault();
    onPress(button, false);
  };
  return (
    <button
      className={`control-button ${className} ${pressed ? "is-pressed" : ""}`}
      aria-label={sublabel || label}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        onPress(button, true);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onClick={(event) => {
        // Pointer input is already handled above; detail 0 is a keyboard-
        // generated activation and gets a short, deterministic button pulse.
        if (event.detail !== 0) return;
        onPress(button, true);
        window.setTimeout(() => onPress(button, false), 90);
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span>{label}</span>
      {sublabel && <small>{sublabel}</small>}
    </button>
  );
}

function CartridgeGraphic({
  artwork,
  cartridgeKind,
  className = "",
}) {
  return (
    <svg
      className={`${className} ${cartridgeKind === "gbc" ? "gbc-cartridge" : "gb-cartridge"}`}
      viewBox="0 0 570 660"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <path className="cart-shadow" d="M18 9H559V582Q559 618 526 650H48Q18 620 18 584Z" />
      <path className="cart-shell" d="M8 3H551V580Q551 614 518 643H41Q8 614 8 580Z" />
      <path className="cart-shell-outline" d="M8 3H551V580Q551 614 518 643H41Q8 614 8 580Z" />
      <path className="cart-highlight" d="M19 16H29V570Q29 599 51 622H43Q19 601 19 574Z" />
      <rect className="cart-grip-bed" x="37" y="21" width="484" height="88" />
      <path
        className="cart-grip-lines"
        d="M50 29V91M84 29V91M118 29V91M152 29V91M186 29V91M220 29V91M254 29V91M288 29V91M322 29V91M356 29V91M390 29V91M424 29V91M458 29V91M492 29V91M38 105H520"
      />
      <rect className="cart-label-shadow" x="96" y="126" width="394" height="394" />
      <rect className="cart-label-border" x="83" y="113" width="394" height="394" />
      <rect className="cart-label-paper" x="90" y="120" width="380" height="380" />
      {artwork && (
        <image
          className="cart-artwork"
          href={artwork}
          x="90"
          y="120"
          width="380"
          height="380"
          preserveAspectRatio="xMidYMid meet"
        />
      )}
      <rect className="cart-label-outline" x="90" y="120" width="380" height="380" />
      <circle className="cart-screw-ring" cx="280" cy="568" r="25" />
      <circle className="cart-screw" cx="280" cy="568" r="18" />
      <path className="cart-screw-slot" d="M271 568H289" />
    </svg>
  );
}

function CartridgeDock({
  animationKey,
  cartridgeArtwork,
  cartridgeKind,
  cartridgeName,
  inserting,
  onHoverChange,
  onOpenSaves,
  showTooltip,
}) {
  const displayName = cartridgeName.length > 28
    ? `${cartridgeName.slice(0, 25)}…`
    : cartridgeName;
  return (
    <>
      <div className="cartridge-visual-rig">
        <CartridgeGraphic
          artwork={cartridgeArtwork}
          cartridgeKind={cartridgeKind}
          className="game-cartridge"
          key={animationKey}
        />
      </div>
      <div className="cartridge-hover-rig">
        <button
          className="cartridge-hover-target"
          type="button"
          aria-label={`Open save options for ${cartridgeName}`}
          aria-controls="save-drawer"
          onClick={onOpenSaves}
          onPointerEnter={() => onHoverChange(true)}
          onPointerLeave={() => onHoverChange(false)}
          onFocus={() => onHoverChange(true)}
          onBlur={() => onHoverChange(false)}
          data-inserting={inserting ? "true" : "false"}
        >
          <span className="visually-hidden">SAVE OPTIONS</span>
        </button>
      </div>
      <div className="cartridge-tooltip-layer">
        <div className="cartridge-info-tooltip">
          <span>{cartridgeKind === "gbc" ? "GBC" : "GB"} CARTRIDGE</span>
          <strong>{displayName}</strong>
          <b>CLICK FOR SAVE OPTIONS</b>
        </div>
      </div>
      <span className="cartridge-collision-anchor" aria-hidden="true" />
      <div
        className={`cartridge-prompt-hint ${showTooltip ? "visible" : ""}`}
        role="status"
        aria-hidden={!showTooltip}
      >
        <span>HOVER FOR SAVE OPTIONS</span>
        <b aria-hidden="true">↓</b>
      </div>
    </>
  );
}

function LibraryStackButton({ count, onOpen, open, showDiscoveryHint }) {
  return (
    <>
      <button
        className={`library-stack-trigger ${open ? "open" : ""}`}
        type="button"
        aria-label={`Open ROM library. ${count} ${count === 1 ? "cartridge" : "cartridges"} stored.`}
        aria-controls="library-drawer"
        aria-expanded={open}
        onClick={onOpen}
      >
        <svg viewBox="0 0 112 156" aria-hidden="true">
          <path className="stack-cart stack-cart-back" d="M12 6H94V119L82 133H24L12 121Z" />
          <path className="stack-cart stack-cart-middle" d="M20 15H102V128L90 142H32L20 130Z" />
          <path className="stack-cart stack-cart-front" d="M4 24H86V137L74 151H16L4 139Z" />
          <rect className="stack-grip" x="13" y="33" width="64" height="16" />
          <rect className="stack-label" x="18" y="57" width="54" height="50" />
          <path className="stack-dots" d="M23 63H29V69H23ZM33 63H39V69H33ZM43 63H49V69H43Z" />
          <path className="stack-mark" d="M25 81H65V87H25ZM25 92H56V98H25Z" />
        </svg>
        <span>LIBRARY</span>
        <b>{String(count).padStart(2, "0")}</b>
      </button>
      <div
        className={`library-discovery-hint ${showDiscoveryHint && !open ? "visible" : ""}`}
        role="status"
        aria-hidden={!showDiscoveryHint || open}
      >
        <span aria-hidden="true">←</span>
        <b>FIND YOUR GAMES HERE</b>
      </div>
    </>
  );
}

function RomLibraryDrawer({
  activeLibraryId,
  libraryFilter,
  libraryQuery,
  libraryReady,
  libraryRoms,
  libraryStatus,
  libraryView,
  loadLibraryRom,
  onAddRom,
  onClose,
  onFilter,
  onQuery,
  onRemove,
  onView,
  open,
  removingLibraryId,
}) {
  const query = libraryQuery.trim().toLowerCase();
  const visibleRoms = libraryRoms.filter((rom) => (
    (libraryFilter === "all" || rom.system === libraryFilter)
    && (!query || `${rom.title} ${rom.fileName}`.toLowerCase().includes(query))
  ));

  return (
    <aside
      id="library-drawer"
      className={`control-deck library-deck ${libraryView === "tabletop" ? "tabletop-mode" : ""} ${open ? "open" : ""}`}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="drawer-heading library-drawer-heading">
        <div>
          <span>LOCAL CARTRIDGE ARCHIVE</span>
          <h2>Game library</h2>
        </div>
        <button onClick={onClose} aria-label="Close game library">CLOSE ×</button>
      </div>

      {libraryView === "detail" ? (
        <>
          <section className="library-intro">
            <div>
              <span>{String(libraryRoms.length).padStart(2, "0")} STORED</span>
              <p>ROMs and artwork stay on this device. Nothing is uploaded.</p>
            </div>
            <button className="library-add-button" type="button" onClick={onAddRom}>
              + ADD ROM
            </button>
          </section>

          <div className="library-tools">
            <label>
              <span className="visually-hidden">Search game library</span>
              <input
                type="search"
                value={libraryQuery}
                onChange={(event) => onQuery(event.target.value)}
                placeholder="SEARCH TITLE OR FILE…"
              />
            </label>
            <div className="library-filters" aria-label="Filter game library">
              {[
                ["all", "ALL"],
                ["gb", "GB"],
                ["gbc", "GBC"],
              ].map(([value, label]) => (
                <button
                  className={libraryFilter === value ? "active" : ""}
                  key={value}
                  type="button"
                  aria-pressed={libraryFilter === value}
                  onClick={() => onFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="library-view-switch" aria-label="Game library layout">
              <button
                className="active"
                type="button"
                aria-pressed="true"
                onClick={() => onView("detail")}
              >
                DETAIL
              </button>
              <button
                type="button"
                aria-pressed="false"
                onClick={() => onView("tabletop")}
              >
                TABLE
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="tabletop-toolbar">
          <span>
            TABLETOP · {String(visibleRoms.length).padStart(2, "0")} {visibleRoms.length === 1 ? "CART" : "CARTS"}
          </span>
          <div className="tabletop-filter-tabs" aria-label="Filter tabletop cartridges">
            {[
              ["all", "ALL"],
              ["gb", "GB"],
              ["gbc", "GBC"],
            ].map(([value, label]) => (
              <button
                className={libraryFilter === value ? "active" : ""}
                key={value}
                type="button"
                aria-pressed={libraryFilter === value}
                onClick={() => onFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="tabletop-actions">
            <button
              type="button"
              onClick={onAddRom}
            >
              + ADD
            </button>
            <button type="button" onClick={() => onView("detail")}>
              DETAIL VIEW
            </button>
          </div>
        </div>
      )}

      <div className={`library-results library-${libraryView}`} aria-live="polite">
        {!libraryReady && (
          <div className="library-empty library-loading">
            <span className="library-loader" aria-hidden="true" />
            <h3>READING CARTRIDGES</h3>
            <p>Opening the local archive…</p>
          </div>
        )}
        {libraryReady && !libraryRoms.length && (
          <div className="library-empty">
            <div className="empty-cart-stack" aria-hidden="true"><i /><i /><i /></div>
            <h3>THE SHELF IS EMPTY</h3>
            <p>Add a legally sourced .gb or .gbc file. It will be catalogued here for one-click play.</p>
            <button type="button" onClick={onAddRom}>ADD FIRST ROM</button>
          </div>
        )}
        {libraryReady && libraryRoms.length > 0 && visibleRoms.length === 0 && (
          <div className="library-empty library-no-results">
            <h3>NO MATCHING CARTRIDGES</h3>
            <p>Try another title or clear the current filter.</p>
            <button type="button" onClick={() => { onQuery(""); onFilter("all"); }}>
              CLEAR FILTERS
            </button>
          </div>
        )}
        {libraryReady && visibleRoms.length > 0 && libraryView === "tabletop" && (
          <div className="tabletop-surface" aria-label="Cartridges on table">
            {visibleRoms.map((rom, index) => (
              <button
                className={`tabletop-cartridge ${activeLibraryId === rom.id ? "is-active" : ""}`}
                key={`${libraryView}:${libraryFilter}:${rom.id}`}
                type="button"
                aria-label={`Play ${rom.title}`}
                onClick={() => loadLibraryRom(rom)}
                style={{
                  "--library-index": index,
                  "--cart-tilt": `${[-2.4, 1.7, -0.8, 2.2, -1.5][index % 5]}deg`,
                }}
              >
                <CartridgeGraphic
                  artwork={rom.artwork}
                  cartridgeKind={rom.system === "gbc" ? "gbc" : "gb"}
                  className="tabletop-cartridge-graphic"
                />
                <span className="tabletop-cartridge-caption">
                  <b>{rom.title}</b>
                  <small className={`library-system-tag system-${rom.system === "gbc" ? "gbc" : "dmg"}`}>
                    {rom.system === "gbc" ? "GBC" : "DMG"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}
        {libraryReady && libraryView === "detail" && visibleRoms.map((rom, index) => (
          <article
            className={`library-card ${activeLibraryId === rom.id ? "is-active" : ""}`}
            key={`${libraryView}:${libraryFilter}:${rom.id}`}
            style={{ "--library-index": index }}
          >
            <CartridgeGraphic
              artwork={rom.artwork}
              cartridgeKind={rom.system === "gbc" ? "gbc" : "gb"}
              className="library-cartridge-graphic"
            />
            <div className="library-card-copy">
              <div className="library-title-row">
                <h3 title={rom.title}>{rom.title}</h3>
                <span className={`library-system-tag system-${rom.system === "gbc" ? "gbc" : "dmg"}`}>
                  {rom.system === "gbc" ? "GBC" : "DMG"}
                </span>
              </div>
              <p title={rom.fileName}>{rom.fileName}</p>
              <dl>
                <div><dt>ROM</dt><dd>{formatBytes(rom.romSize || rom.rom?.byteLength)}</dd></div>
                <div><dt>LAST PLAYED</dt><dd>{formatLibraryDate(rom.lastPlayedAt)}</dd></div>
              </dl>
              <div className="library-card-actions">
                <button type="button" onClick={() => loadLibraryRom(rom)}>
                  {activeLibraryId === rom.id ? "REPLAY" : "PLAY"}
                </button>
                <button
                  className={removingLibraryId === rom.id ? "confirming" : ""}
                  type="button"
                  onClick={() => onRemove(rom.id)}
                  disabled={rom.builtIn}
                  title={rom.builtIn ? "Included with this private GAMEBOY LAB build" : undefined}
                >
                  {rom.builtIn
                    ? "BUILT IN"
                    : removingLibraryId === rom.id
                      ? "CONFIRM REMOVE"
                      : "REMOVE"}
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>

      {libraryView === "detail" && (
        <footer className="library-footer">
          <span>{libraryStatus}</span>
          <small>ARTWORK: LIBRETRO WHEN AVAILABLE · GENERATED LABEL OTHERWISE</small>
        </footer>
      )}
    </aside>
  );
}

function SaveCenter({
  backupStatus,
  confirmingSlot,
  downloadAllSaves,
  downloadCartridgeSave,
  importCartridgeSave,
  info,
  loadStateSlot,
  clearStateSlot,
  running,
  saveFileRef,
  saveSlots,
  saveStateSlot,
  saveStatus,
}) {
  return (
    <section className="deck-section save-center">
      <div className="save-type-card cartridge-save-card">
        <div className="save-type-heading">
          <div>
            <span>REAL GAME SAVE</span>
            <h3>Cartridge save</h3>
          </div>
          <b className={info.battery ? "save-ready" : ""}>{saveStatus}</b>
        </div>
        <p>
          The game writes this data itself, like battery-backed RAM in a physical
          cartridge. It auto-saves to this browser and is portable as a standard .sav.
        </p>
        <div className="save-actions">
          <button onClick={downloadCartridgeSave} disabled={!info.battery}>
            DOWNLOAD .SAV
          </button>
          <button onClick={() => saveFileRef.current?.click()} disabled={!info.battery}>
            IMPORT .SAV
          </button>
        </div>
        <input
          ref={saveFileRef}
          className="visually-hidden"
          type="file"
          accept=".sav,application/octet-stream"
          aria-label="Import cartridge save file"
          onChange={(event) => {
            importCartridgeSave(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {!info.battery && (
          <small>This cartridge does not advertise battery-backed save hardware.</small>
        )}
      </div>
      <div className="save-type-card state-save-card">
        <div className="save-type-heading">
          <div>
            <span>EMULATOR SNAPSHOTS</span>
            <h3>Save states</h3>
          </div>
          <b>3 SLOTS</b>
        </div>
        <p>
          A state freezes the entire machine at one instant: CPU, video, audio,
          memory, and cartridge RAM. It is not an in-game save and is emulator-specific.
        </p>
        <div className="state-slots">
          {saveSlots.map((slot, index) => (
            <article key={index} className={slot ? "occupied" : ""}>
              <div>
                <b>SLOT {index + 1}</b>
                <span>
                  {slot
                    ? `${modelLabel(slot.model)} · ${formatSavedAt(slot.savedAt)}`
                    : "EMPTY"}
                </span>
              </div>
              <div>
                <button onClick={() => saveStateSlot(index)} disabled={!running}>
                  {slot ? "OVERWRITE" : "SAVE"}
                </button>
                <button onClick={() => loadStateSlot(index)} disabled={!slot}>LOAD</button>
                {slot && (
                  <button
                    className={confirmingSlot === index ? "confirming" : ""}
                    onClick={() => clearStateSlot(index)}
                  >
                    {confirmingSlot === index ? "CONFIRM" : "CLEAR"}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
      <div className="save-type-card library-backup-card">
        <div className="save-type-heading">
          <div>
            <span>EVERY SAVED GAME</span>
            <h3>Complete backup</h3>
          </div>
          <b>{backupStatus}</b>
        </div>
        <p>
          Packages every game&apos;s battery-backed cartridge data, RTC data, and
          GAMEBOY LAB save-state slot into one portable file. ROMs, artwork, and
          preferences are intentionally excluded.
        </p>
        <div className="save-actions one-action">
          <button onClick={downloadAllSaves}>DOWNLOAD ALL SAVES</button>
        </div>
        <small>Restore this file from Advanced options on this or another browser.</small>
      </div>
    </section>
  );
}

function SafetyPrompt({
  confirmLabel,
  detail,
  eyebrow,
  onCancel,
  onConfirm,
  title,
}) {
  return (
    <div className="safety-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section
        className="safety-prompt"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="safety-prompt-title"
        aria-describedby="safety-prompt-detail"
      >
        <span>{eyebrow}</span>
        <h2 id="safety-prompt-title">{title}</h2>
        <p id="safety-prompt-detail">{detail}</p>
        <div className="safety-prompt-actions">
          <button type="button" onClick={onCancel}>CANCEL</button>
          <button type="button" className="confirming" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function UpdatePrompt({ update, onDismiss }) {
  return (
    <section className="update-prompt" role="dialog" aria-labelledby="update-prompt-title">
      <div className="update-prompt-copy">
        <span>NEW STANDALONE BUILD</span>
        <h2 id="update-prompt-title">GAMEBOY LAB v{update.version}</h2>
        <p>
          A newer one-file build is ready. Your games and browser saves stay
          where they are; replace this HTML only when you are ready.
        </p>
      </div>
      <div className="update-prompt-actions">
        <button type="button" onClick={onDismiss}>LATER</button>
        <a href={update.downloadUrl} download="gbc-lab.html">
          DOWNLOAD UPDATE
        </a>
      </div>
    </section>
  );
}

function ReadoutMetric({ label, value }) {
  const labelText = String(label);
  const valueText = String(value);
  return (
    <div
      style={{
        "--metric-label-fit": `${135 / Math.max(1, labelText.length)}cqi`,
        "--metric-value-fit": `${150 / Math.max(1, valueText.length)}cqi`,
      }}
    >
      <dt>{labelText}</dt>
      <dd>{valueText}</dd>
    </div>
  );
}

function TechnicalReadout({
  audioLatency,
  audioState,
  diagnostics,
  frameSkip,
  info,
  model,
  paused,
  running,
  visible,
}) {
  const audioPreset = AUDIO_LATENCY_PRESETS[audioLatency];
  const sampleRate = diagnostics.audioSampleRate || 48000;
  const bufferedMilliseconds = Math.round(
    diagnostics.audioBuffered / sampleRate * 1000,
  );
  const targetMilliseconds = Math.round(audioPreset.target / sampleRate * 1000);
  const speed = Number.isFinite(Number(diagnostics.fps))
    ? `${Math.round(Number(diagnostics.fps) / 59.7275 * 100)}%`
    : "—";
  const hasCartridge = info !== EMPTY_INFO;
  const target = hasCartridge
    ? info.cgb
      ? "GBC"
      : "DMG"
    : "—";

  return (
    <aside
      className={`technical-readout ${visible ? "visible" : ""}`}
      aria-label="Live technical readout"
      aria-hidden={!visible}
      data-run-calls={diagnostics.runs}
      data-audio-state={audioState}
      data-audio-buffered={diagnostics.audioBuffered}
      data-audio-peak={diagnostics.audioPeak.toFixed(4)}
      data-audio-underruns={diagnostics.audioUnderruns}
      data-audio-overruns={diagnostics.audioOverruns}
      data-audio-enqueued={diagnostics.audioEnqueued}
      data-audio-mode={diagnostics.audioMode}
    >
      <header>
        <strong>DIAGNOSTICS</strong>
        <span className={`readout-status ${running && !paused ? "live" : ""}`}>
          <i aria-hidden="true" />
          {running ? paused ? "PAUSED" : "RUNNING" : "IDLE"}
        </span>
      </header>

      <section className="readout-performance">
        <h3>
          PERFORMANCE
          <span>SKIP {FRAME_SKIP_PRESETS[frameSkip].label.toUpperCase()}</span>
        </h3>
        <dl>
          <ReadoutMetric label="EMU FPS" value={diagnostics.fps} />
          <ReadoutMetric label="PRESENT" value={diagnostics.presentedFps} />
          <ReadoutMetric label="SKIPPED/S" value={diagnostics.skippedFps} />
          <ReadoutMetric label="SPEED" value={speed} />
        </dl>
      </section>

      <section className="readout-audio">
        <h3>
          AUDIO
          <span>{diagnostics.audioMode.toUpperCase()} · {audioState}</span>
        </h3>
        <dl>
          <ReadoutMetric label="BUFFER" value={`${bufferedMilliseconds} MS`} />
          <ReadoutMetric label="TARGET" value={`${targetMilliseconds} MS`} />
          <ReadoutMetric label="UNDERRUN" value={diagnostics.audioUnderruns} />
          <ReadoutMetric label="TRIM" value={diagnostics.audioOverruns} />
          <ReadoutMetric label="RATE" value={`${Math.round(sampleRate / 100) / 10} KHZ`} />
        </dl>
      </section>

      <section className="readout-cartridge">
        <h3>
          CARTRIDGE
          <span
            title={info.title}
            style={{
              "--readout-title-fit": `${110 / Math.max(1, info.title.length)}cqi`,
            }}
          >
            {info.title}
          </span>
        </h3>
        <dl>
          <ReadoutMetric label="DISPLAY / TARGET" value={`${modelLabel(model)} / ${target}`} />
          <ReadoutMetric label="MAPPER" value={hasCartridge ? info.mapper : "—"} />
          <ReadoutMetric
            label="ROM / RAM"
            value={`${formatBytes(info.romSize)} / ${formatBytes(info.ramSize)}`}
          />
          <ReadoutMetric
            label="RTC / HEADER"
            value={`${info.rtc ? "MBC3 CLOCK" : "—"} / ${hasCartridge ? info.checksumValid ? "PASS" : "FAIL" : "—"}`}
          />
        </dl>
      </section>

      <section className="readout-core">
        <h3>
          CORE
          <span>{diagnostics.audioPeak.toFixed(3)} PEAK</span>
        </h3>
        <dl>
          <ReadoutMetric label="FRAME" value={diagnostics.frame} />
          <ReadoutMetric label="PC" value={diagnostics.pc} />
          <ReadoutMetric label="LY" value={diagnostics.ly} />
          <ReadoutMetric label="PPU" value={`M${diagnostics.ppu}`} />
          <ReadoutMetric label="RUNS" value={diagnostics.runs} />
        </dl>
      </section>
    </aside>
  );
}

export default function Emulator() {
  const canvasRef = useRef(null);
  const sourceCanvasRef = useRef(null);
  const sourceContextRef = useRef(null);
  const lcdRendererRef = useRef(null);
  const fileRef = useRef(null);
  const saveFileRef = useRef(null);
  const backupFileRef = useRef(null);
  const emulatorRef = useRef(null);
  if (emulatorRef.current == null) emulatorRef.current = createEmulator("dmg");
  const romRef = useRef(null);
  const romKeyRef = useRef("");
  const romNameRef = useRef("game");
  const nativeBootRef = useRef(false);
  const animationRef = useRef(0);
  const correctedFrameRef = useRef(null);
  const audioRef = useRef({
    context: null,
    node: null,
    mode: null,
    ring: null,
    readIndex: 0,
    writeIndex: 0,
    available: 0,
    buffered: 0,
    underruns: 0,
    overruns: 0,
    enqueued: 0,
    peak: 0,
    maxPeak: 0,
  });
  const audioStartPromiseRef = useRef(null);
  const audioFilterRef = useRef(true);
  const audioLatencyRef = useRef("balanced");
  const bootRef = useRef({ active: false, start: 0 });
  const lastAnimationRef = useRef(0);
  const frameAccumulatorRef = useRef(0);
  const lastPresentRef = useRef(0);
  const fpsRef = useRef({
    start: 0,
    frames: 0,
    presented: 0,
    skipped: 0,
  });
  const volumeRef = useRef(70);
  const mutedRef = useRef(false);
  const keyBindingsRef = useRef(DEFAULT_BINDINGS);
  const bindingTargetRef = useRef(null);
  const buttonPressStartedRef = useRef(new Map());
  const buttonReleaseTimerRef = useRef(new Map());
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const pauseReasonRef = useRef(null);
  const modelRef = useRef("dmg");
  const titleRef = useRef(EMPTY_INFO.title);
  const presentFrameRef = useRef(null);
  const loopGenerationRef = useRef(0);
  const catchUpBudgetRef = useRef("balanced");
  const frameSkipRef = useRef("off");
  const showTechnicalReadoutRef = useRef(false);
  const presentationPhaseRef = useRef(0);
  const consoleOffsetYRef = useRef(0);
  const scaleToastTimerRef = useRef(0);
  const saveTooltipTimerRef = useRef(0);
  const cartridgeAnimationTimerRef = useRef(0);
  const cartridgeAnimationRunRef = useRef(0);
  const testRomLoadedRef = useRef(false);
  const consoleWrapRef = useRef(null);
  const deviceRigRef = useRef(null);

  const [model, setModelState] = useState("dmg");
  const [info, setInfo] = useState(EMPTY_INFO);
  const [status, setStatus] = useState("Awaiting cartridge");
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseReason, setPauseReason] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [lcdMode, setLcdMode] = useState("response");
  const [ghostingEnabled, setGhostingEnabled] = useState(true);
  const [ghostStrength, setGhostStrength] = useState(42);
  const [dmgContrast, setDmgContrast] = useState(112);
  const [volume, setVolume] = useState(70);
  const [muted, setMuted] = useState(false);
  const [audioState, setAudioState] = useState("LOCKED");
  const [theme, setTheme] = useState("system");
  const [systemTheme, setSystemTheme] = useState("light");
  const [viewMode, setViewMode] = useState("console");
  const [compatibilityPalette, setCompatibilityPalette] = useState("auto");
  const [consoleScale, setConsoleScale] = useState(1);
  const [screenGeometry, setScreenGeometry] = useState({
    frameWidth: null,
    pixelScale: 1,
  });
  const [pauseOnMenu, setPauseOnMenu] = useState(true);
  const [integerScaling, setIntegerScaling] = useState(false);
  const [manualScale, setManualScale] = useState(90);
  const [backgroundPause, setBackgroundPause] = useState(true);
  const [cgbColorCorrection, setCgbColorCorrection] = useState(true);
  const [cartridgeAnimationEnabled, setCartridgeAnimationEnabled] = useState(true);
  const [audioFilter, setAudioFilter] = useState(true);
  const [audioLatency, setAudioLatency] = useState("balanced");
  const [catchUpBudget, setCatchUpBudget] = useState("balanced");
  const [frameSkip, setFrameSkip] = useState("off");
  const [technicalReadoutRequested, setTechnicalReadoutRequested] = useState(false);
  const [technicalReadoutSupported, setTechnicalReadoutSupported] = useState(
    () => window.matchMedia(TECHNICAL_READOUT_MEDIA).matches,
  );
  const showTechnicalReadout = technicalReadoutSupported && technicalReadoutRequested;
  const [keyboardMotion, setKeyboardMotion] = useState(true);
  const [keyBindings, setKeyBindings] = useState(DEFAULT_BINDINGS);
  const [bindingTarget, setBindingTarget] = useState(null);
  const [pressedButtons, setPressedButtons] = useState(() => new Set());
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState(null);
  const [diagnostics, setDiagnostics] = useState({
    fps: "—",
    presentedFps: "—",
    skippedFps: "0.0",
    frame: 0,
    pc: "0100",
    ly: 0,
    ppu: 0,
    runs: 0,
    audioBuffered: 0,
    audioPeak: 0,
    audioUnderruns: 0,
    audioOverruns: 0,
    audioEnqueued: 0,
    audioMode: "off",
    audioSampleRate: 48000,
  });
  const [, setMessage] = useState("Open the game library or drop a legally obtained ROM.");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [saveDrawerOpen, setSaveDrawerOpen] = useState(false);
  const [libraryDrawerOpen, setLibraryDrawerOpen] = useState(false);
  const [showLibraryDiscovery, setShowLibraryDiscovery] = useState(false);
  const [libraryRoms, setLibraryRoms] = useState([]);
  const [libraryReady, setLibraryReady] = useState(false);
  const [libraryStatus, setLibraryStatus] = useState("LOCAL ARCHIVE READY");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [libraryView, setLibraryView] = useState("detail");
  const [removingLibraryId, setRemovingLibraryId] = useState(null);
  const [activeLibraryId, setActiveLibraryId] = useState("");
  const [cartridgePresent, setCartridgePresent] = useState(false);
  const [cartridgeInserting, setCartridgeInserting] = useState(false);
  const [cartridgeName, setCartridgeName] = useState("GAME CARTRIDGE");
  const [cartridgeKind, setCartridgeKind] = useState("gb");
  const [cartridgeArtwork, setCartridgeArtwork] = useState("");
  const [cartridgeAnimationKey, setCartridgeAnimationKey] = useState(0);
  const [showSaveTooltip, setShowSaveTooltip] = useState(false);
  const [cartridgePreflight, setCartridgePreflight] = useState(false);
  const [cartridgeHovered, setCartridgeHovered] = useState(false);
  const [consoleOffsetY, setConsoleOffsetY] = useState(0);
  const [scaleToast, setScaleToast] = useState("");
  const [saveSlots, setSaveSlots] = useState([null, null, null]);
  const [saveStatus, setSaveStatus] = useState("NO CARTRIDGE");
  const [backupStatus, setBackupStatus] = useState("READY");
  const [confirmingSlot, setConfirmingSlot] = useState(null);
  const [pendingModel, setPendingModel] = useState(null);
  const [pendingRestore, setPendingRestore] = useState(null);
  const resolvedTheme = theme === "system" ? systemTheme : theme;
  const anyDrawerOpen = drawerOpen || saveDrawerOpen || libraryDrawerOpen;

  const refreshLibrary = useCallback(async () => {
    const sortRecords = (records) => records.sort((left, right) => {
      const recency = (right.lastPlayedAt || right.addedAt || 0)
        - (left.lastPlayedAt || left.addedAt || 0);
      return recency || left.title.localeCompare(right.title);
    });
    try {
      const storedRecords = await listLibraryRoms();
      const builtInRecords = createBuiltInLibraryRecords(storedRecords);
      const builtInIds = new Set(builtInRecords.map((record) => record.id));
      const staleStoredBuiltIns = storedRecords.filter((record) => record.builtIn);
      if (staleStoredBuiltIns.length) {
        await Promise.all(staleStoredBuiltIns.map((record) => removeLibraryRom(record.id)));
      }
      const records = sortRecords([
        ...storedRecords.filter((record) => !record.builtIn && !builtInIds.has(record.id)),
        ...builtInRecords,
      ]);
      setLibraryRoms(records);
      setLibraryStatus(
        `${records.length} CARTRIDGES · ${builtInRecords.length} BUILT IN`,
      );
    } catch (error) {
      const builtInRecords = createBuiltInLibraryRecords();
      setLibraryRoms(builtInRecords);
      setLibraryStatus(error instanceof Error
        ? `${builtInRecords.length} BUILT IN · STORAGE: ${error.message.toUpperCase()}`
        : `${builtInRecords.length} BUILT IN · LOCAL STORAGE UNAVAILABLE`);
    } finally {
      setLibraryReady(true);
    }
  }, []);

  useEffect(() => {
    refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    if (!libraryReady || libraryRoms.length === 0) return;
    try {
      setShowLibraryDiscovery(localStorage.getItem(LIBRARY_DISCOVERY_KEY) !== "seen");
    } catch {
      setShowLibraryDiscovery(true);
    }
  }, [libraryReady, libraryRoms.length]);

  const dismissLibraryDiscovery = useCallback(() => {
    setShowLibraryDiscovery(false);
    try {
      localStorage.setItem(LIBRARY_DISCOVERY_KEY, "seen");
    } catch {
      // The hint can still dismiss for this session without persistent storage.
    }
  }, []);

  const showScaleMessage = useCallback((text) => {
    window.clearTimeout(scaleToastTimerRef.current);
    setScaleToast(text);
    scaleToastTimerRef.current = window.setTimeout(() => setScaleToast(""), 1800);
  }, []);

  useEffect(() => () => {
    cartridgeAnimationRunRef.current += 1;
    window.clearTimeout(scaleToastTimerRef.current);
    window.clearTimeout(saveTooltipTimerRef.current);
    window.clearTimeout(cartridgeAnimationTimerRef.current);
  }, []);

  useEffect(() => {
    if (!preferencesReady) return undefined;
    let cancelled = false;
    const check = async () => {
      const testVersion = import.meta.env.DEV
        ? new window.URLSearchParams(window.location.search).get("__testUpdate")
        : "";
      if (testVersion) {
        setAvailableUpdate({
          version: testVersion,
          downloadUrl: "#standalone-update",
          notesUrl: "#standalone-update",
        });
        return;
      }
      try {
        const update = await findAvailableUpdate();
        if (!cancelled && update) setAvailableUpdate(update);
      } catch {
        // A standalone emulator must remain fully useful offline. Update
        // discovery is deliberately silent when GitHub cannot be reached.
      }
    };
    const timer = window.setTimeout(check, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [preferencesReady]);

  const replayCartridgeInsertion = useCallback(async () => {
    if (!romRef.current || !cartridgeAnimationEnabled) return;
    const run = cartridgeAnimationRunRef.current + 1;
    cartridgeAnimationRunRef.current = run;
    window.clearTimeout(cartridgeAnimationTimerRef.current);
    window.clearTimeout(saveTooltipTimerRef.current);
    setShowSaveTooltip(false);
    setCartridgeInserting(false);
    // View/model switches are batched with this call. Preflight waits until the
    // new geometry has painted, reserves the prompt clearance, and lets the
    // shared rig finish any required duck before the cartridge starts moving.
    setCartridgePreflight(true);
    await afterNextPaint();
    if (cartridgeAnimationRunRef.current !== run) return;

    const wrap = consoleWrapRef.current;
    const computedScale = wrap
      ? Number.parseFloat(
        window.getComputedStyle(wrap).getPropertyValue("--console-scale"),
      ) || 1
      : 1;
    const baselineOffset = wrap?.closest(".screen-only")
      ? SCREEN_ONLY_CARTRIDGE_CENTER_OFFSET * (
        Number.parseFloat(
          window.getComputedStyle(wrap).getPropertyValue("--screen-only-scale"),
        ) || 1
      )
      : 10 * computedScale;
    if (consoleOffsetYRef.current > baselineOffset + 1) {
      await new Promise((resolve) => window.setTimeout(resolve, CARTRIDGE_DUCK_DURATION));
      if (cartridgeAnimationRunRef.current !== run) return;
    }

    setCartridgeAnimationKey((value) => value + 1);
    setCartridgePreflight(false);
    setCartridgeInserting(true);
    cartridgeAnimationTimerRef.current = window.setTimeout(
      () => {
        if (cartridgeAnimationRunRef.current !== run) return;
        setCartridgeInserting(false);
      },
      560,
    );
  }, [cartridgeAnimationEnabled]);

  const flushAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio.mode === "worklet") audio.node?.port.postMessage({ type: "reset" });
    audio.readIndex = 0;
    audio.writeIndex = 0;
    audio.available = 0;
    audio.started = false;
    audio.buffered = 0;
    audio.underruns = 0;
    audio.overruns = 0;
    audio.enqueued = 0;
    audio.peak = 0;
    audio.maxPeak = 0;
    audio.previousInputLeft = 0;
    audio.previousInputRight = 0;
    audio.previousOutputLeft = 0;
    audio.previousOutputRight = 0;
  }, []);

  const readStoredBattery = useCallback((key) => {
    if (!key) return null;
    try {
      const saved = localStorage.getItem(`gbc-lab-save:${key}`);
      if (!saved) return null;
      if (!saved.startsWith("{")) return base64ToBytes(saved);
      const parsed = JSON.parse(saved);
      return {
        ram: base64ToBytes(parsed.ram),
        rtc: parsed.rtc ?? null,
      };
    } catch {
      return null;
    }
  }, []);

  const refreshSaveSlots = useCallback((key = romKeyRef.current) => {
    if (!key) {
      setSaveSlots([null, null, null]);
      return;
    }
    const slots = [0, 1, 2].map((slot) => {
      try {
        const raw = localStorage.getItem(`gbc-lab-state:${key}:${slot}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return {
          savedAt: parsed.savedAt,
          model: parsed.model,
          title: parsed.title,
        };
      } catch {
        return null;
      }
    });
    setSaveSlots(slots);
  }, []);

  const pauseGame = useCallback((reason = "manual") => {
    if (!runningRef.current || pausedRef.current) return false;
    pausedRef.current = true;
    pauseReasonRef.current = reason;
    setPaused(true);
    setPauseReason(reason);
    flushAudio();
    return true;
  }, [flushAudio]);

  const resumeGame = useCallback((expectedReason = null) => {
    if (expectedReason && pauseReasonRef.current !== expectedReason) return false;
    pausedRef.current = false;
    pauseReasonRef.current = null;
    lastAnimationRef.current = window.performance.now();
    frameAccumulatorRef.current = 0;
    presentationPhaseRef.current = 0;
    setPaused(false);
    setPauseReason(null);
    return true;
  }, []);

  const openOptions = useCallback(() => {
    if (pauseOnMenu) pauseGame("menu");
    setSaveDrawerOpen(false);
    setLibraryDrawerOpen(false);
    setDrawerOpen(true);
  }, [pauseGame, pauseOnMenu]);

  const closeOptions = useCallback(() => {
    setDrawerOpen(false);
    if (pauseReasonRef.current === "menu") resumeGame("menu");
  }, [resumeGame]);

  const openSaveDrawer = useCallback(() => {
    if (!romRef.current) return;
    window.clearTimeout(saveTooltipTimerRef.current);
    setShowSaveTooltip(false);
    if (pauseOnMenu) pauseGame("menu");
    setDrawerOpen(false);
    setLibraryDrawerOpen(false);
    setSaveDrawerOpen(true);
  }, [pauseGame, pauseOnMenu]);

  const closeSaveDrawer = useCallback(() => {
    setSaveDrawerOpen(false);
    if (pauseReasonRef.current === "menu") resumeGame("menu");
  }, [resumeGame]);

  const openLibraryDrawer = useCallback(() => {
    dismissLibraryDiscovery();
    if (pauseOnMenu) pauseGame("menu");
    setDrawerOpen(false);
    setSaveDrawerOpen(false);
    setRemovingLibraryId(null);
    setLibraryDrawerOpen(true);
  }, [dismissLibraryDiscovery, pauseGame, pauseOnMenu]);

  const closeLibraryDrawer = useCallback(() => {
    setLibraryDrawerOpen(false);
    setRemovingLibraryId(null);
    if (pauseReasonRef.current === "menu") resumeGame("menu");
  }, [resumeGame]);

  const closeDrawers = useCallback(() => {
    setDrawerOpen(false);
    setSaveDrawerOpen(false);
    setLibraryDrawerOpen(false);
    setRemovingLibraryId(null);
    if (pauseReasonRef.current === "menu") resumeGame("menu");
  }, [resumeGame]);

  const togglePauseOnMenu = useCallback(() => {
    const next = !pauseOnMenu;
    setPauseOnMenu(next);
    if (!anyDrawerOpen) return;
    if (next) pauseGame("menu");
    else if (pauseReasonRef.current === "menu") resumeGame("menu");
  }, [anyDrawerOpen, pauseGame, pauseOnMenu, resumeGame]);

  const saveBattery = useCallback(() => {
    const emulator = emulatorRef.current;
    const battery = emulator.exportBatteryState();
    if (!battery || !romKeyRef.current) return;
    try {
      localStorage.setItem(`gbc-lab-save:${romKeyRef.current}`, JSON.stringify({
        version: 2,
        ram: bytesToBase64(battery.ram),
        rtc: battery.rtc,
      }));
      emulator.markBatterySaved();
      setSaveStatus("AUTO-SAVED");
    } catch {
      // A full storage quota must never interrupt emulation.
      setSaveStatus("STORAGE FULL");
    }
  }, []);

  const startAudio = useCallback(() => {
    if (typeof window === "undefined") return Promise.resolve();
    if (audioRef.current.context) {
      return audioRef.current.context.resume()
        .then(() => setAudioState("ON"))
        .catch(() => setAudioState("LOCKED"));
    }
    if (audioStartPromiseRef.current) return audioStartPromiseRef.current;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      setAudioState("UNAVAILABLE");
      return Promise.resolve();
    }
    setAudioState("STARTING");
    const initialize = async () => {
      const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
      emulatorRef.current.setAudioSampleRate(context.sampleRate);
      const preset = AUDIO_LATENCY_PRESETS[audioLatencyRef.current];
      let node;
      let mode = "fallback";
      if (context.audioWorklet && window.AudioWorkletNode) {
        const source = new window.Blob([AUDIO_WORKLET_SOURCE], { type: "text/javascript" });
        const url = URL.createObjectURL(source);
        try {
          await context.audioWorklet.addModule(url);
          node = new window.AudioWorkletNode(context, "gbc-lab-audio", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          });
          mode = "worklet";
        } catch {
          node = null;
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      const audioState = {
        context,
        node,
        mode,
        ring: null,
        readIndex: 0,
        writeIndex: 0,
        available: 0,
        started: false,
        target: preset.target,
        buffered: 0,
        underruns: 0,
        overruns: 0,
        enqueued: 0,
        peak: 0,
        maxPeak: 0,
        previousInputLeft: 0,
        previousInputRight: 0,
        previousOutputLeft: 0,
        previousOutputRight: 0,
      };
      if (mode === "worklet") {
        node.port.onmessage = ({ data }) => {
          if (audioRef.current.node !== node) return;
          audioRef.current.buffered = data.buffered;
          audioRef.current.underruns = data.underruns;
          audioRef.current.overruns = data.overruns;
          audioRef.current.peak = data.peak;
          audioRef.current.maxPeak = Math.max(audioRef.current.maxPeak, data.peak);
        };
      } else {
        node = context.createScriptProcessor(preset.buffer, 0, 2);
        audioState.node = node;
        audioState.ring = new Float32Array(preset.maximum * 2);
        node.onaudioprocess = (event) => {
          const left = event.outputBuffer.getChannelData(0);
          const right = event.outputBuffer.getChannelData(1);
          const audio = audioRef.current;
          const gain = mutedRef.current ? 0 : volumeRef.current / 100;
          let peak = 0;
          if (!audio.started && audio.available >= audio.target * 2) audio.started = true;
          for (let index = 0; index < left.length; index += 1) {
            let leftSample = 0;
            let rightSample = 0;
            if (audio.started && audio.available >= 2) {
              leftSample = audio.ring[audio.readIndex];
              audio.readIndex = (audio.readIndex + 1) % audio.ring.length;
              rightSample = audio.ring[audio.readIndex];
              audio.readIndex = (audio.readIndex + 1) % audio.ring.length;
              audio.available -= 2;
            } else if (audio.started) {
              audio.started = false;
              audio.underruns += 1;
            }
            if (audioFilterRef.current) {
              const filteredLeft = leftSample - audio.previousInputLeft
                + 0.995 * audio.previousOutputLeft;
              const filteredRight = rightSample - audio.previousInputRight
                + 0.995 * audio.previousOutputRight;
              audio.previousInputLeft = leftSample;
              audio.previousInputRight = rightSample;
              audio.previousOutputLeft = filteredLeft;
              audio.previousOutputRight = filteredRight;
              leftSample = filteredLeft;
              rightSample = filteredRight;
            }
            left[index] = leftSample * gain;
            right[index] = rightSample * gain;
            peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
          }
          audio.buffered = audio.available >> 1;
          audio.peak = peak;
          audio.maxPeak = Math.max(audio.maxPeak, peak);
        };
      }
      node.connect(context.destination);
      audioRef.current = audioState;
      if (mode === "worklet") {
        node.port.postMessage({
          type: "settings",
          target: preset.target,
          maximum: preset.maximum,
          gain: mutedRef.current ? 0 : volumeRef.current / 100,
          filter: audioFilterRef.current,
        });
      }
      context.onstatechange = () => {
        setAudioState(context.state === "running" ? "ON" : context.state.toUpperCase());
      };
      await context.resume();
      setAudioState("ON");
    };
    audioStartPromiseRef.current = initialize()
      .catch(() => setAudioState("LOCKED"))
      .finally(() => {
        audioStartPromiseRef.current = null;
      });
    return audioStartPromiseRef.current;
  }, []);

  const enqueueAudio = useCallback((samples) => {
    if (!samples.length) return;
    const audio = audioRef.current;
    audio.enqueued += samples.length >> 1;
    let peak = 0;
    for (let index = 0; index < samples.length; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index]));
    }
    audio.peak = peak;
    audio.maxPeak = Math.max(audio.maxPeak, peak);
    if (audio.mode === "worklet") {
      audio.node.port.postMessage({ type: "samples", buffer: samples.buffer }, [samples.buffer]);
      return;
    }
    if (!audio.ring) return;
    for (let index = 0; index + 1 < samples.length; index += 2) {
      if (audio.available + 2 > audio.ring.length) {
        audio.readIndex = (audio.readIndex + 2) % audio.ring.length;
        audio.available -= 2;
        audio.overruns += 1;
      }
      audio.ring[audio.writeIndex] = samples[index];
      audio.writeIndex = (audio.writeIndex + 1) % audio.ring.length;
      audio.ring[audio.writeIndex] = samples[index + 1];
      audio.writeIndex = (audio.writeIndex + 1) % audio.ring.length;
      audio.available += 2;
    }
    audio.buffered = audio.available >> 1;
  }, []);

  const presentFrame = useCallback(() => {
    const renderer = lcdRendererRef.current;
    if (!renderer) return;
    const emulator = emulatorRef.current;
    let current = emulator.framebuffer;
    if (cgbColorCorrection && modelRef.current === "cgb") {
      if (!correctedFrameRef.current) {
        correctedFrameRef.current = new Uint8ClampedArray(current.length);
      }
      const corrected = correctedFrameRef.current;
      for (let i = 0; i < current.length; i += 4) {
        const red = current[i];
        const green = current[i + 1];
        const blue = current[i + 2];
        corrected[i] = Math.min(255, (red * 26 + green * 4 + blue * 2) >> 5);
        corrected[i + 1] = Math.min(255, (red * 2 + green * 24 + blue * 6) >> 5);
        corrected[i + 2] = Math.min(255, (red * 4 + green * 4 + blue * 24) >> 5);
        corrected[i + 3] = 255;
      }
      current = corrected;
    }
    renderer.uploadFrame(current);
  }, [cgbColorCorrection]);

  const loadFile = useCallback(async (file, libraryEntry = null) => {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".gb") && !lower.endsWith(".gbc")) {
      setMessage("That is not a .gb or .gbc cartridge image.");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = hashBytes(bytes);
      const key = `${bytes.length}:${hash}`;
      const libraryTitle = readRomTitle(bytes);
      const librarySystem = (bytes[0x143] & 0x80) !== 0 ? "gbc" : "gb";
      const nextCartridgeKind = librarySystem;
      let cachedEntry = libraryEntry?.id === key ? libraryEntry : null;
      if (!cachedEntry) {
        try {
          cachedEntry = await getLibraryRom(key);
        } catch {
          // Library availability must never prevent a cartridge from loading.
        }
      }

      closeDrawers();
      cartridgeAnimationRunRef.current += 1;
      window.clearTimeout(cartridgeAnimationTimerRef.current);
      window.clearTimeout(saveTooltipTimerRef.current);
      setShowSaveTooltip(false);
      setCartridgePreflight(false);
      setStatus("Cataloguing cartridge");
      setMessage(cachedEntry?.artwork
        ? "Opening cartridge from the local library."
        : "Finding cover art for the local cartridge library…");
      let artworkResult = cachedEntry?.artwork
        ? {
          artwork: cachedEntry.artwork,
          artworkSource: cachedEntry.artworkSource || "cached",
        }
        : {
          artwork: createFallbackArtwork(libraryTitle, librarySystem, hash),
          artworkSource: "generated",
        };
      if (!cachedEntry?.artwork) {
        artworkResult = await resolveRomArtwork({
          fileName: file.name,
          title: libraryTitle,
          system: librarySystem,
          seed: hash,
        });
      }

      setCartridgeName(
        (cachedEntry?.title || safeFileStem(file.name).replace(/-/g, " ")).toUpperCase(),
      );
      setCartridgeKind(nextCartridgeKind);
      setCartridgeArtwork(artworkResult.artwork);
      setCartridgePresent(true);
      setCartridgeAnimationKey((value) => value + 1);
      if (cartridgeAnimationEnabled) {
        // Reserve the hint's top clearance first. If the top bar would overlap,
        // the shared rig completes its single duck before the cartridge moves.
        setCartridgePreflight(true);
        await afterNextPaint();
        const baselineOffset = viewMode === "screen"
          ? SCREEN_ONLY_CARTRIDGE_CENTER_OFFSET * (
            integerScaling ? 1 : manualScale / 100
          )
          : 10 * consoleScale;
        if (consoleOffsetYRef.current > baselineOffset + 1) {
          await new Promise((resolve) => window.setTimeout(resolve, CARTRIDGE_DUCK_DURATION));
        }
        setCartridgeInserting(true);
        await new Promise((resolve) => window.setTimeout(resolve, 560));
        setShowSaveTooltip(true);
        setCartridgePreflight(false);
        setCartridgeInserting(false);
      } else {
        setCartridgeInserting(false);
        setShowSaveTooltip(true);
      }
      saveTooltipTimerRef.current = window.setTimeout(
        () => setShowSaveTooltip(false),
        SAVE_TOOLTIP_DURATION,
      );

      const legacyKey = `${file.name}:${bytes.length}:${hash}`;
      const battery = readStoredBattery(key) ?? readStoredBattery(legacyKey);
      saveBattery();
      const emulator = createEmulator(
        model,
        compatibilityPalette,
        audioRef.current.context?.sampleRate ?? 48000,
      );
      const header = emulator.loadROM(bytes, battery);
      emulatorRef.current = emulator;
      romRef.current = bytes;
      romKeyRef.current = key;
      romNameRef.current = file.name;
      lcdRendererRef.current?.resetPersistence();
      correctedFrameRef.current = null;
      setInfo({
        ...header,
        title: cachedEntry?.title || header.title,
      });
      setSaveStatus(header.battery ? (battery ? "RESTORED" : "READY") : "NOT SUPPORTED");
      refreshSaveSlots(key);
      if ((!header.logoValid || !header.checksumValid) && !emulator.bootEnabled) {
        setStatus("Header check failed");
        runningRef.current = false;
        setRunning(false);
        setMessage("Hardware lockout: cartridge logo or header checksum is invalid.");
        return;
      }

      const now = Date.now();
      const libraryRecord = {
        id: key,
        fileName: file.name,
        title: cachedEntry?.title || header.title || libraryTitle,
        system: librarySystem,
        cgbOnly: Boolean(header.cgbOnly),
        cartridgeKind: nextCartridgeKind,
        mapper: header.mapper,
        romSize: header.romSize || bytes.byteLength,
        rom: bytes,
        artwork: artworkResult.artwork,
        artworkSource: artworkResult.artworkSource,
        addedAt: cachedEntry?.addedAt || now,
        lastPlayedAt: now,
        builtIn: Boolean(cachedEntry?.builtIn),
      };
      try {
        setActiveLibraryId(key);
        if (cachedEntry?.builtIn) {
          setLibraryRoms((records) => records
            .map((record) => (
              record.id === key
                ? { ...record, lastPlayedAt: now }
                : record
            ))
            .sort((left, right) => (
              (right.lastPlayedAt || right.addedAt || 0)
              - (left.lastPlayedAt || left.addedAt || 0)
              || left.title.localeCompare(right.title)
            )));
        } else {
          await putLibraryRom(libraryRecord);
          await refreshLibrary();
        }
      } catch (error) {
        setLibraryStatus(error instanceof Error
          ? `CARTRIDGE RUNNING · LIBRARY: ${error.message.toUpperCase()}`
          : "CARTRIDGE RUNNING · LIBRARY STORAGE UNAVAILABLE");
      }

      startAudio();
      nativeBootRef.current = emulator.bootEnabled;
      bootRef.current = emulator.bootEnabled
        ? { active: false, start: 0 }
        : { active: true, start: Date.now() };
      runningRef.current = true;
      setRunning(true);
      resumeGame();
      setStatus(emulator.bootEnabled ? `${modelLabel(model)} BIOS running` : `${modelLabel(model)} fallback startup`);
      setMessage(
        emulator.bootEnabled
          ? `Executing the embedded production ${modelLabel(model)} BIOS.`
          : battery
            ? "Battery-backed save restored from this browser."
            : "Cartridge verified. Running locally in your browser.",
      );
      return libraryRecord;
    } catch (error) {
      setCartridgePreflight(false);
      setCartridgeInserting(false);
      setMessage(error instanceof Error ? error.message : "Unable to read this cartridge.");
      setStatus("Load error");
      setRunning(false);
    }
  }, [
    cartridgeAnimationEnabled,
    closeDrawers,
    compatibilityPalette,
    consoleScale,
    integerScaling,
    manualScale,
    model,
    resumeGame,
    readStoredBattery,
    refreshLibrary,
    refreshSaveSlots,
    saveBattery,
    startAudio,
    viewMode,
  ]);

  const loadLibraryRom = useCallback((entry) => {
    if (!entry?.rom && !entry?.romBase64) return;
    startAudio();
    const fileName = entry.fileName
      || `${safeFileStem(entry.title || "game")}.${entry.system === "gbc" ? "gbc" : "gb"}`;
    const rom = entry.builtIn
      ? getEmbeddedLibraryRom(entry)
      : entry.rom;
    loadFile(new window.File(
      [rom],
      fileName,
      { type: "application/octet-stream" },
    ), entry);
  }, [loadFile, startAudio]);

  const removeFromLibrary = useCallback(async (id) => {
    if (libraryRoms.find((record) => record.id === id)?.builtIn) return;
    if (removingLibraryId !== id) {
      setRemovingLibraryId(id);
      return;
    }
    try {
      await removeLibraryRom(id);
      if (activeLibraryId === id) setActiveLibraryId("");
      setRemovingLibraryId(null);
      await refreshLibrary();
    } catch (error) {
      setLibraryStatus(error instanceof Error ? error.message.toUpperCase() : "UNABLE TO REMOVE CARTRIDGE");
    }
  }, [activeLibraryId, libraryRoms, refreshLibrary, removingLibraryId]);

  useEffect(() => {
    if (!import.meta.env.DEV || testRomLoadedRef.current) return;
    const testParams = new window.URLSearchParams(window.location.search);
    const testRom = testParams.get("__testRom");
    if (!testRom) return;
    testRomLoadedRef.current = true;
    window.fetch(testRom)
      .then((response) => {
        if (!response.ok) throw new Error(`Test ROM request failed: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        if (testParams.get("__testGbcOnly") === "1") {
          bytes[0x143] = 0xc0;
          let checksum = 0;
          for (let index = 0x134; index <= 0x14c; index += 1) {
            checksum = (checksum - bytes[index] - 1) & 0xff;
          }
          bytes[0x14d] = checksum;
        }
        return loadFile(new window.File(
          [bytes],
          testParams.get("__testGbcOnly") === "1"
            ? "GBC VISUAL TEST.gbc"
            : decodeURIComponent(testRom.split("/").pop() || "test.gb"),
          { type: "application/octet-stream" },
        ));
      })
      .catch((error) => setMessage(error.message));
  }, [loadFile]);

  const performModelSwitch = useCallback((nextModel) => {
    if (nextModel === model) return;
    replayCartridgeInsertion();
    saveBattery();
    setModelState(nextModel);
    modelRef.current = nextModel;
    setStatus(romRef.current ? "Restarting core" : "Awaiting cartridge");
    setMessage(nextModel === "cgb"
      ? "GBC hardware selected. Color-capable cartridges use native color mode."
      : "DMG hardware selected. GBC-only cartridges are blocked like original hardware.");
    const emulator = createEmulator(
      nextModel,
      compatibilityPalette,
      audioRef.current.context?.sampleRate ?? 48000,
    );
    emulatorRef.current = emulator;
    lcdRendererRef.current?.resetPersistence();
    correctedFrameRef.current = null;
    if (romRef.current) {
      const battery = readStoredBattery(romKeyRef.current);
      const header = emulator.loadROM(romRef.current, battery);
      setInfo({ ...header, title: titleRef.current || header.title });
      nativeBootRef.current = emulator.bootEnabled;
      bootRef.current = emulator.bootEnabled
        ? { active: false, start: 0 }
        : { active: true, start: Date.now() };
      setStatus(emulator.bootEnabled
        ? `${modelLabel(nextModel)} BIOS running`
        : `${modelLabel(nextModel)} fallback startup`);
      runningRef.current = true;
      setRunning(true);
      if (anyDrawerOpen && pauseOnMenu) pauseGame("menu");
      else resumeGame();
    }
  }, [
    anyDrawerOpen,
    compatibilityPalette,
    model,
    pauseGame,
    pauseOnMenu,
    readStoredBattery,
    replayCartridgeInsertion,
    resumeGame,
    saveBattery,
  ]);

  const switchModel = useCallback((nextModel) => {
    if (nextModel === model) return;
    if (romRef.current && runningRef.current) {
      pauseGame("safety");
      setPendingModel(nextModel);
      return;
    }
    performModelSwitch(nextModel);
  }, [model, pauseGame, performModelSwitch]);

  const cancelModelSwitch = useCallback(() => {
    setPendingModel(null);
    if (pauseReasonRef.current === "safety") resumeGame("safety");
  }, [resumeGame]);

  const confirmModelSwitch = useCallback(() => {
    if (!pendingModel) return;
    const nextModel = pendingModel;
    setPendingModel(null);
    performModelSwitch(nextModel);
  }, [pendingModel, performModelSwitch]);

  const switchViewMode = useCallback((nextViewMode) => {
    if (nextViewMode === viewMode) return;
    setViewMode(nextViewMode);
    replayCartridgeInsertion();
  }, [replayCartridgeInsertion, viewMode]);

  const reset = useCallback(() => {
    if (!romRef.current) return;
    saveBattery();
    emulatorRef.current.reset();
    lcdRendererRef.current?.resetPersistence();
    correctedFrameRef.current = null;
    nativeBootRef.current = emulatorRef.current.bootEnabled;
    bootRef.current = emulatorRef.current.bootEnabled
      ? { active: false, start: 0 }
      : { active: true, start: Date.now() };
    if (anyDrawerOpen && pauseOnMenu) pauseGame("menu");
    else resumeGame();
    setStatus(`${modelLabel(model)} cold boot`);
  }, [anyDrawerOpen, model, pauseGame, pauseOnMenu, resumeGame, saveBattery]);

  const saveStateSlot = useCallback((slot) => {
    const snapshot = emulatorRef.current.exportState();
    if (!snapshot || !romKeyRef.current) return;
    const savedAt = Date.now();
    try {
      localStorage.setItem(`gbc-lab-state:${romKeyRef.current}:${slot}`, JSON.stringify({
        version: 1,
        romKey: romKeyRef.current,
        title: snapshot.title,
        model: snapshot.model,
        savedAt,
        state: encodeStateValue(snapshot),
      }));
      refreshSaveSlots();
      setConfirmingSlot(null);
      setMessage(`Save state ${slot + 1} captured. In-game cartridge progress remains separate.`);
    } catch {
      setMessage("Browser storage is full. Clear a state or download the cartridge save.");
    }
  }, [refreshSaveSlots]);

  const loadStateSlot = useCallback((slot) => {
    if (!romRef.current || !romKeyRef.current) return;
    try {
      const raw = localStorage.getItem(`gbc-lab-state:${romKeyRef.current}:${slot}`);
      if (!raw) return;
      const stored = JSON.parse(raw);
      if (stored.romKey !== romKeyRef.current) throw new Error("This state belongs to another cartridge.");
      const snapshot = decodeStateValue(stored.state);
      let emulator = emulatorRef.current;
      if (snapshot.model !== modelRef.current) {
        emulator = createEmulator(
          snapshot.model,
          compatibilityPalette,
          audioRef.current.context?.sampleRate ?? 48000,
        );
        emulator.loadROM(romRef.current, readStoredBattery(romKeyRef.current));
        emulatorRef.current = emulator;
        modelRef.current = snapshot.model;
        setModelState(snapshot.model);
        setInfo({
          ...emulator.header,
          title: titleRef.current || emulator.header.title,
        });
      }
      if (!emulator.importState(snapshot)) throw new Error("This state is incompatible with the loaded cartridge.");
      lcdRendererRef.current?.resetPersistence();
      correctedFrameRef.current = null;
      flushAudio();
      nativeBootRef.current = emulator.bootEnabled;
      bootRef.current = { active: false, start: 0 };
      runningRef.current = true;
      setRunning(true);
      if (anyDrawerOpen && pauseOnMenu) pauseGame("menu");
      else resumeGame();
      if (presentFrameRef.current) presentFrameRef.current();
      setStatus(`${modelLabel(snapshot.model)} · state ${slot + 1}`);
      setMessage(`Save state ${slot + 1} restored. This also restored its exact cartridge RAM snapshot.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load this save state.");
    }
  }, [
    anyDrawerOpen,
    compatibilityPalette,
    flushAudio,
    pauseGame,
    pauseOnMenu,
    readStoredBattery,
    resumeGame,
  ]);

  const clearStateSlot = useCallback((slot) => {
    if (confirmingSlot !== slot) {
      setConfirmingSlot(slot);
      return;
    }
    try {
      localStorage.removeItem(`gbc-lab-state:${romKeyRef.current}:${slot}`);
      refreshSaveSlots();
      setMessage(`Save state ${slot + 1} cleared. The cartridge save was not touched.`);
    } catch {
      setMessage("Unable to clear that save state.");
    }
    setConfirmingSlot(null);
  }, [confirmingSlot, refreshSaveSlots]);

  const downloadCartridgeSave = useCallback(() => {
    const battery = emulatorRef.current.exportBattery();
    if (!battery) return;
    saveBattery();
    downloadBytes(battery, `${safeFileStem(romNameRef.current)}.sav`);
    setMessage("Downloaded the game’s battery-backed .sav file. Save states were not included.");
  }, [saveBattery]);

  const importCartridgeSave = useCallback(async (file) => {
    if (!file || !info.battery) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      emulatorRef.current.importBattery(bytes);
      saveBattery();
      setSaveStatus("IMPORTED");
      setMessage("Imported cartridge RAM. Reset the game if it does not reread save data immediately.");
    } catch {
      setMessage("Unable to import that .sav file.");
    }
  }, [info.battery, saveBattery]);

  const downloadAllSaves = useCallback(() => {
    try {
      saveBattery();
      const titleByRomKey = new Map(
        libraryRoms.map((entry) => [entry.id, entry.title]),
      );
      const { archive, summary } = createSaveArchive(localStorage, titleByRomKey);
      const timestamp = archive.createdAt.replace(/[:.]/g, "-");
      downloadBytes(
        JSON.stringify(archive, null, 2),
        `gameboy-lab-saves-${timestamp}.json`,
        "application/json",
      );
      setBackupStatus(`${summary.games} GAMES · ${summary.records} RECORDS`);
      setMessage(
        `Downloaded ${summary.batterySaves} cartridge saves and ${summary.saveStates} save states.`,
      );
    } catch (error) {
      setBackupStatus("BACKUP FAILED");
      setMessage(error instanceof Error ? error.message : "Unable to create the save backup.");
    }
  }, [libraryRoms, saveBattery]);

  const prepareSaveRestore = useCallback(async (file) => {
    if (!file) return;
    try {
      const parsed = parseSaveArchive(await file.text());
      if (runningRef.current) pauseGame("safety");
      setPendingRestore({
        ...parsed,
        fileName: file.name,
      });
      setBackupStatus("CONFIRM RESTORE");
    } catch (error) {
      setPendingRestore(null);
      setBackupStatus("INVALID BACKUP");
      setMessage(error instanceof Error ? error.message : "Unable to read that backup.");
    }
  }, [pauseGame]);

  const cancelSaveRestore = useCallback(() => {
    setPendingRestore(null);
    setBackupStatus("RESTORE CANCELLED");
    if (pauseReasonRef.current === "safety") resumeGame("safety");
  }, [resumeGame]);

  const restoreAllSaves = useCallback(() => {
    if (!pendingRestore) return;
    try {
      const summary = replaceSaveArchive(localStorage, pendingRestore.archive);
      refreshSaveSlots();
      if (romRef.current) {
        const displayTitle = titleRef.current;
        const currentModel = modelRef.current;
        const emulator = createEmulator(
          currentModel,
          compatibilityPalette,
          audioRef.current.context?.sampleRate ?? 48000,
        );
        const header = emulator.loadROM(
          romRef.current,
          readStoredBattery(romKeyRef.current),
        );
        emulatorRef.current = emulator;
        setInfo({ ...header, title: displayTitle || header.title });
        setSaveStatus(header.battery
          ? readStoredBattery(romKeyRef.current) ? "RESTORED" : "READY"
          : "NOT SUPPORTED");
        lcdRendererRef.current?.resetPersistence();
        correctedFrameRef.current = null;
        flushAudio();
        nativeBootRef.current = emulator.bootEnabled;
        bootRef.current = emulator.bootEnabled
          ? { active: false, start: 0 }
          : { active: true, start: Date.now() };
        runningRef.current = true;
        setRunning(true);
        setStatus(emulator.bootEnabled
          ? `${modelLabel(currentModel)} BIOS running`
          : `${modelLabel(currentModel)} fallback startup`);
      }
      setPendingRestore(null);
      setBackupStatus(`${summary.games} GAMES RESTORED`);
      setMessage(
        `Replaced local save data with ${summary.batterySaves} cartridge saves and ${summary.saveStates} save states.`,
      );
      if (anyDrawerOpen && pauseOnMenu) {
        pausedRef.current = true;
        pauseReasonRef.current = "menu";
        setPaused(true);
        setPauseReason("menu");
      } else if (pauseReasonRef.current === "safety") {
        resumeGame("safety");
      }
    } catch (error) {
      setBackupStatus("RESTORE FAILED");
      setMessage(error instanceof Error ? error.message : "Unable to restore that backup.");
    }
  }, [
    anyDrawerOpen,
    compatibilityPalette,
    flushAudio,
    pauseOnMenu,
    pendingRestore,
    readStoredBattery,
    refreshSaveSlots,
    resumeGame,
  ]);

  const chooseCompatibilityPalette = useCallback((id) => {
    setCompatibilityPalette(id);
    const emulator = emulatorRef.current;
    emulator.setCompatibilityPalette(id);
    lcdRendererRef.current?.resetPersistence();
    correctedFrameRef.current = null;
    if (presentFrameRef.current) presentFrameRef.current();
    const selected = CGB_COMPATIBILITY_PALETTES.find((palette) => palette.id === id);
    setMessage(
      id === "auto"
        ? "DMG cartridge colors now follow the production GBC boot ROM."
        : `${selected?.label ?? "Selected"} compatibility palette applied.`,
    );
  }, []);

  const setButtonVisual = useCallback((button, pressed) => {
    setPressedButtons((current) => {
      const next = new Set(current);
      if (pressed) next.add(button);
      else next.delete(button);
      return next;
    });
  }, []);

  const setEmulatedButton = useCallback((button, pressed, showMotion = true) => {
    const releaseTimers = buttonReleaseTimerRef.current;
    if (pressed) {
      const pendingRelease = releaseTimers.get(button);
      if (pendingRelease) window.clearTimeout(pendingRelease);
      releaseTimers.delete(button);
      buttonPressStartedRef.current.set(button, window.performance.now());
      emulatorRef.current.setButton(button, true);
      if (showMotion) setButtonVisual(button, true);
      return;
    }
    const started = buttonPressStartedRef.current.get(button);
    const elapsed = started === undefined ? MINIMUM_BUTTON_PRESS_MS : window.performance.now() - started;
    const release = () => {
      emulatorRef.current.setButton(button, false);
      buttonPressStartedRef.current.delete(button);
      releaseTimers.delete(button);
      if (showMotion) setButtonVisual(button, false);
    };
    const remaining = Math.max(0, MINIMUM_BUTTON_PRESS_MS - elapsed);
    if (remaining === 0) release();
    else releaseTimers.set(button, window.setTimeout(release, remaining));
  }, [setButtonVisual]);

  const pressButton = useCallback((button, pressed) => {
    if (pressed) startAudio();
    setEmulatedButton(button, pressed, true);
  }, [setEmulatedButton, startAudio]);

  const resizeWithWheel = useCallback((event) => {
    if (window.innerWidth < 900) return;
    event.preventDefault();
    if (integerScaling) {
      showScaleMessage("CAN’T CHANGE SCALE — INTEGER SCALING IS ON");
      return;
    }
    setManualScale((current) => Math.max(
      55,
      Math.min(100, current + (event.deltaY < 0 ? 2 : -2)),
    ));
  }, [integerScaling, showScaleMessage]);

  const uploadSoftwareScreen = useCallback((resetHistory = false) => {
    const source = sourceCanvasRef.current;
    const renderer = lcdRendererRef.current;
    if (!source || !renderer) return;
    const context = source.getContext("2d", { alpha: false });
    renderer.uploadFrame(
      context.getImageData(0, 0, GAMEBOY_WIDTH, GAMEBOY_HEIGHT).data,
      { resetHistory },
    );
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const source = sourceCanvasRef.current;
    if (!canvas || !source) return undefined;
    const renderer = new LCDShaderRenderer(canvas);
    lcdRendererRef.current = renderer;
    renderer.setOptions({
      model,
      lcdEnabled: lcdMode === "response",
      ghostEnabled: ghostingEnabled,
      ghostStrength: ghostStrength / 100,
      dmgContrast: dmgContrast / 100,
    });
    const context = source.getContext("2d", { alpha: false });
    drawWaitingScreen(context, model);
    uploadSoftwareScreen(true);
    return () => {
      lcdRendererRef.current = null;
      renderer.dispose();
    };
    // The renderer owns one GPU context for the life of the visible canvas.
    // Runtime display options are synchronized by the effect below.
  }, []);

  useEffect(() => {
    lcdRendererRef.current?.setOptions({
      model,
      lcdEnabled: lcdMode === "response",
      ghostEnabled: ghostingEnabled,
      ghostStrength: ghostStrength / 100,
      dmgContrast: dmgContrast / 100,
    });
  }, [dmgContrast, ghostStrength, ghostingEnabled, lcdMode, model]);

  useEffect(() => {
    const draw = () => {
      if (runningRef.current) return;
      const context = sourceCanvasRef.current?.getContext("2d", { alpha: false });
      if (context) {
        drawWaitingScreen(context, model);
        uploadSoftwareScreen(true);
      }
    };
    draw();
    const animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [model, uploadSoftwareScreen]);

  useEffect(() => {
    const context = sourceCanvasRef.current?.getContext("2d", { alpha: false });
    if (!context) return;
    if (dragging) {
      drawDropScreen(context, model);
      uploadSoftwareScreen(true);
      return;
    }
    if (runningRef.current) {
      presentFrameRef.current?.();
    } else {
      drawWaitingScreen(context, model);
      uploadSoftwareScreen(true);
    }
  }, [dragging, model, uploadSoftwareScreen]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => setSystemTheme(media.matches ? "dark" : "light");
    syncTheme();
    media.addEventListener?.("change", syncTheme);
    return () => media.removeEventListener?.("change", syncTheme);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(TECHNICAL_READOUT_MEDIA);
    const syncSupport = () => {
      setTechnicalReadoutSupported(media.matches);
    };
    syncSupport();
    media.addEventListener?.("change", syncSupport);
    return () => media.removeEventListener?.("change", syncSupport);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(localStorage.getItem("gbc-lab-preferences") || "{}");
        if (
          saved.themeVersion === 2
          && ["system", "dark", "light"].includes(saved.theme)
        ) setTheme(saved.theme);
        if (saved.viewMode === "console" || saved.viewMode === "screen") setViewMode(saved.viewMode);
        if (saved.libraryView === "detail" || saved.libraryView === "tabletop") {
          setLibraryView(saved.libraryView);
        }
        if (CGB_COMPATIBILITY_PALETTES.some((palette) => palette.id === saved.compatibilityPalette)) {
          setCompatibilityPalette(saved.compatibilityPalette);
          emulatorRef.current.setCompatibilityPalette(saved.compatibilityPalette);
        }
        if (typeof saved.keyboardMotion === "boolean") setKeyboardMotion(saved.keyboardMotion);
        if (saved.lcdMode === "sharp" || saved.lcdMode === "response") setLcdMode(saved.lcdMode);
        else if (saved.lcdMode === "blend") setLcdMode("response");
        if (typeof saved.ghostingEnabled === "boolean") setGhostingEnabled(saved.ghostingEnabled);
        if (Number.isFinite(saved.ghostStrength)) {
          setGhostStrength(Math.max(8, Math.min(72, saved.ghostStrength)));
        }
        if (Number.isFinite(saved.dmgContrast)) {
          setDmgContrast(Math.max(70, Math.min(150, saved.dmgContrast)));
        }
        if (typeof saved.muted === "boolean") setMuted(saved.muted);
        if (Number.isFinite(saved.volume)) setVolume(Math.max(0, Math.min(100, saved.volume)));
        if (typeof saved.pauseOnMenu === "boolean") setPauseOnMenu(saved.pauseOnMenu);
        if (saved.scalingDefaultsVersion === SCALING_DEFAULTS_VERSION) {
          if (typeof saved.integerScaling === "boolean") setIntegerScaling(saved.integerScaling);
          if (Number.isFinite(saved.manualScale)) {
            setManualScale(Math.max(55, Math.min(100, saved.manualScale)));
          }
        }
        if (typeof saved.backgroundPause === "boolean") setBackgroundPause(saved.backgroundPause);
        if (typeof saved.cgbColorCorrection === "boolean") {
          setCgbColorCorrection(saved.cgbColorCorrection);
        }
        if (typeof saved.cartridgeAnimationEnabled === "boolean") {
          setCartridgeAnimationEnabled(saved.cartridgeAnimationEnabled);
        }
        if (typeof saved.audioFilter === "boolean") setAudioFilter(saved.audioFilter);
        if (AUDIO_LATENCY_PRESETS[saved.audioLatency]) setAudioLatency(saved.audioLatency);
        if (CATCH_UP_BUDGETS[saved.catchUpBudget]) setCatchUpBudget(saved.catchUpBudget);
        if (FRAME_SKIP_PRESETS[saved.frameSkip]) setFrameSkip(saved.frameSkip);
        else if (saved.videoWorkload === "efficient") setFrameSkip("one");
        if (typeof saved.showTechnicalReadout === "boolean") {
          setTechnicalReadoutRequested(saved.showTechnicalReadout);
        }
        if (saved.keyBindings && BINDING_ORDER.every((button) => typeof saved.keyBindings[button] === "string")) {
          setKeyBindings(saved.keyBindings);
        }
      } catch {
        // Corrupt local preferences should never block the emulator.
      }
      setPreferencesReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    keyBindingsRef.current = keyBindings;
    bindingTargetRef.current = bindingTarget;
    audioFilterRef.current = audioFilter;
    audioLatencyRef.current = audioLatency;
    catchUpBudgetRef.current = catchUpBudget;
    frameSkipRef.current = frameSkip;
    showTechnicalReadoutRef.current = showTechnicalReadout;
    document.documentElement.dataset.theme = resolvedTheme;
    if (!preferencesReady) return;
    try {
      localStorage.setItem("gbc-lab-preferences", JSON.stringify({
        theme,
        themeVersion: 2,
        viewMode,
        libraryView,
        compatibilityPalette,
        lcdMode,
        ghostingEnabled,
        ghostStrength,
        dmgContrast,
        keyboardMotion,
        muted,
        volume,
        keyBindings,
        pauseOnMenu,
        scalingDefaultsVersion: SCALING_DEFAULTS_VERSION,
        integerScaling,
        manualScale,
        backgroundPause,
        cgbColorCorrection,
        cartridgeAnimationEnabled,
        audioFilter,
        audioLatency,
        catchUpBudget,
        frameSkip,
        showTechnicalReadout: technicalReadoutRequested,
      }));
    } catch {
      // Preferences are optional.
    }
  }, [
    theme,
    resolvedTheme,
    viewMode,
    libraryView,
    compatibilityPalette,
    lcdMode,
    ghostingEnabled,
    ghostStrength,
    dmgContrast,
    keyboardMotion,
    muted,
    volume,
    keyBindings,
    bindingTarget,
    pauseOnMenu,
    integerScaling,
    manualScale,
    backgroundPause,
    cgbColorCorrection,
    cartridgeAnimationEnabled,
    audioFilter,
    audioLatency,
    catchUpBudget,
    frameSkip,
    showTechnicalReadout,
    technicalReadoutRequested,
    preferencesReady,
  ]);

  useEffect(() => {
    const isInteractiveControl = (target) => target?.matches?.(
      'button, input, select, textarea, [contenteditable="true"]',
    );
    const down = (event) => {
      const target = bindingTargetRef.current;
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        if (event.code === "Escape") {
          setBindingTarget(null);
          return;
        }
        setKeyBindings((current) => {
          const next = { ...current };
          const duplicate = BINDING_ORDER.find((button) => button !== target && current[button] === event.code);
          if (duplicate) next[duplicate] = current[target];
          next[target] = event.code;
          return next;
        });
        setBindingTarget(null);
        return;
      }
      if (isInteractiveControl(event.target)) return;
      const button = BINDING_ORDER.find((name) => keyBindingsRef.current[name] === event.code);
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      startAudio();
      setEmulatedButton(button, true, keyboardMotion);
    };
    const up = (event) => {
      if (isInteractiveControl(event.target)) return;
      const button = BINDING_ORDER.find((name) => keyBindingsRef.current[name] === event.code);
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      setEmulatedButton(button, false, keyboardMotion);
    };
    const blur = () => {
      for (const timer of buttonReleaseTimerRef.current.values()) window.clearTimeout(timer);
      buttonReleaseTimerRef.current.clear();
      buttonPressStartedRef.current.clear();
      emulatorRef.current.joypad = 0xff;
      setPressedButtons(new Set());
    };
    window.addEventListener("keydown", down, { passive: false, capture: true });
    window.addEventListener("keyup", up, { passive: false, capture: true });
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
      for (const timer of buttonReleaseTimerRef.current.values()) window.clearTimeout(timer);
      buttonReleaseTimerRef.current.clear();
      buttonPressStartedRef.current.clear();
    };
  }, [keyboardMotion, setEmulatedButton, startAudio]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        if (backgroundPause) pauseGame("hidden");
        return;
      }
      if (pauseReasonRef.current !== "hidden") return;
      if (anyDrawerOpen && pauseOnMenu) {
        pauseReasonRef.current = "menu";
        setPauseReason("menu");
      } else {
        resumeGame("hidden");
      }
    };
    if (!backgroundPause && pauseReasonRef.current === "hidden") resumeGame("hidden");
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [anyDrawerOpen, backgroundPause, pauseGame, pauseOnMenu, resumeGame]);

  useEffect(() => {
    const resize = () => {
      if (viewMode === "screen") {
        setConsoleScale(1);
        return;
      }
      const stage = consoleWrapRef.current;
      const availableWidth = Math.max(1, stage?.clientWidth ?? window.innerWidth);
      const availableHeight = Math.max(1, stage?.clientHeight ?? window.innerHeight);
      const shellWidth = model === "cgb" ? 358 : 397;
      const shellHeight = model === "cgb" ? 612 : 652;
      const screenContentWidth = model === "cgb" ? 230 : 258;
      // Manual 100% fits the complete resting silhouette: cartridge tip through
      // shell bottom. Temporary reveals are still handled by the duck below.
      const insertedTipHeight = cartridgePresent ? 20 : 0;
      const fit = Math.min(
        availableWidth / shellWidth,
        availableHeight / (shellHeight + insertedTipHeight),
      );
      if (integerScaling) {
        const density = window.devicePixelRatio || 1;
        const pixelScale = Math.max(
          1,
          Math.floor(fit * screenContentWidth * density / GAMEBOY_WIDTH),
        );
        setConsoleScale(pixelScale * GAMEBOY_WIDTH / (screenContentWidth * density));
        return;
      }
      setConsoleScale(fit * manualScale / 100);
    };
    resize();
    const observer = new window.ResizeObserver(resize);
    if (consoleWrapRef.current) observer.observe(consoleWrapRef.current);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [anyDrawerOpen, cartridgePresent, integerScaling, manualScale, model, viewMode]);

  useLayoutEffect(() => {
    let frame = 0;
    const measureEnvelope = () => {
      const wrap = consoleWrapRef.current;
      const rig = deviceRigRef.current;
      if (!wrap || !rig) {
        consoleOffsetYRef.current = 0;
        setConsoleOffsetY(0);
        return;
      }

      const wrapRect = wrap.getBoundingClientRect();
      const rigRect = rig.getBoundingClientRect();
      const collisionAnchor = rig.querySelector(".cartridge-collision-anchor");
      if (!collisionAnchor) {
        consoleOffsetYRef.current = 0;
        setConsoleOffsetY(0);
        return;
      }

      const relativeEnvelopeTop = collisionAnchor.getBoundingClientRect().top - rigRect.top;
      // Compute the unshifted center directly rather than subtracting the
      // target state from an element midway through its CSS transition.
      const rigTopWithoutOffset = wrapRect.top + (wrapRect.height - rigRect.height) / 2;
      const minimumTop = wrapRect.top;
      const collisionSafeOffset = (
        minimumTop - (rigTopWithoutOffset + relativeEnvelopeTop)
      );
      // Hover always gives the physical shell its familiar 28 px duck. When the
      // cartridge needs more clearance, the measured offset replaces that value
      // instead of adding a second transform/animation on the handheld itself.
      const visualScale = viewMode === "screen" ? 1 : consoleScale;
      const screenOnlyScale = integerScaling ? 1 : manualScale / 100;
      const baselineCenterOffset = cartridgePresent
        ? viewMode === "screen"
          ? SCREEN_ONLY_CARTRIDGE_CENTER_OFFSET * screenOnlyScale
          : 10 * visualScale
        : 0;
      const hoverDuck = baselineCenterOffset
        + (cartridgeHovered
          ? 28 * (viewMode === "screen" ? screenOnlyScale : visualScale)
          : 0);
      const clearanceActive = (
        cartridgeHovered
        || cartridgePreflight
        || showSaveTooltip
      );
      const nextOffset = clearanceActive
        ? Math.max(hoverDuck, Math.max(0, collisionSafeOffset))
        : baselineCenterOffset;
      consoleOffsetYRef.current = nextOffset;
      setConsoleOffsetY(nextOffset);
    };
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measureEnvelope);
    };

    measureEnvelope();
    const observer = new window.ResizeObserver(scheduleMeasure);
    if (consoleWrapRef.current) observer.observe(consoleWrapRef.current);
    if (deviceRigRef.current) observer.observe(deviceRigRef.current);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [
    anyDrawerOpen,
    cartridgeHovered,
    cartridgeInserting,
    cartridgePreflight,
    cartridgePresent,
    consoleScale,
    integerScaling,
    manualScale,
    model,
    showSaveTooltip,
    viewMode,
  ]);

  useEffect(() => {
    const snapScreenToDevicePixels = () => {
      const density = window.devicePixelRatio || 1;
      let outerWidth;
      let integerScale;
      if (viewMode === "screen") {
        const stage = consoleWrapRef.current;
        const availableWidth = Math.max(1, stage?.clientWidth ?? window.innerWidth);
        const availableHeight = Math.max(1, stage?.clientHeight ?? window.innerHeight);
        const insertedTipHeight = cartridgePresent
          ? SCREEN_ONLY_CARTRIDGE_OVERHANG
          : 0;
        // Fit the full visible silhouette. The screen-frame box ends at its
        // border, while the screen-only bezel is an 8 px outer ring drawn by
        // box-shadow. Reserve that ring explicitly so 100% ends at the bezel's
        // bottom edge rather than clipping it at the LCD or border edge.
        const verticalOutline = cartridgePresent
          ? SCREEN_ONLY_BEZEL_OUTLINE
          : SCREEN_ONLY_BEZEL_OUTLINE * 2;
        const maximumOuterHeight = Math.max(
          SCREEN_ONLY_FRAME_BORDER + 1,
          availableHeight
            - insertedTipHeight
            - verticalOutline
            - SCREEN_ONLY_EDGE_GUARD,
        );
        const horizontalChrome = (
          SCREEN_ONLY_FRAME_BORDER
          + SCREEN_ONLY_BEZEL_OUTLINE * 2
        );
        const contentLimit = Math.max(
          1,
          Math.min(
            availableWidth - horizontalChrome - SCREEN_ONLY_EDGE_GUARD,
            (maximumOuterHeight - SCREEN_ONLY_FRAME_BORDER)
              * GAMEBOY_WIDTH / GAMEBOY_HEIGHT,
          ),
        );
        if (integerScaling) {
          integerScale = Math.max(1, Math.floor(contentLimit * density / GAMEBOY_WIDTH));
          outerWidth = (
            integerScale * GAMEBOY_WIDTH / density
            + SCREEN_ONLY_FRAME_BORDER
          );
        } else {
          // Keep the layout at its 100% fit and let the shared device rig
          // perform manual zoom as one compositor transform. This matches
          // console mode: the bezel, cartridge, label, tooltip and shader all
          // move in one layer instead of triggering a full layout on each
          // wheel notch.
          const contentWidth = contentLimit;
          integerScale = Math.max(
            1,
            Math.ceil(
              contentWidth * (manualScale / 100) * density / GAMEBOY_WIDTH,
            ),
          );
          outerWidth = Math.min(
            availableWidth
              - SCREEN_ONLY_BEZEL_OUTLINE * 2
              - SCREEN_ONLY_EDGE_GUARD,
            contentWidth + SCREEN_ONLY_FRAME_BORDER,
          );
        }
      } else {
        const baseContentWidth = model === "cgb" ? 230 : 258;
        const displayedContentWidth = baseContentWidth * consoleScale;
        integerScale = Math.max(
          1,
          (integerScaling ? Math.round : Math.ceil)(
            displayedContentWidth * density / GAMEBOY_WIDTH,
          ),
        );
        // The LCD is a fixed part of the shell in console mode. Integer scaling
        // snaps the whole console transform, never the screen independently.
        outerWidth = baseContentWidth + 6;
      }
      setScreenGeometry((current) => (
        current.frameWidth !== null
        && Math.abs(current.frameWidth - outerWidth) < 0.01
        && current.pixelScale === integerScale
          ? current
          : { frameWidth: outerWidth, pixelScale: integerScale }
      ));
    };
    snapScreenToDevicePixels();
    const observer = new window.ResizeObserver(snapScreenToDevicePixels);
    if (consoleWrapRef.current) observer.observe(consoleWrapRef.current);
    window.addEventListener("resize", snapScreenToDevicePixels);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", snapScreenToDevicePixels);
    };
  }, [
    anyDrawerOpen,
    cartridgePresent,
    consoleScale,
    integerScaling,
    manualScale,
    model,
    viewMode,
  ]);

  useEffect(() => {
    const animation = requestAnimationFrame(() => {
      lcdRendererRef.current?.resizeAndRender();
    });
    return () => cancelAnimationFrame(animation);
  }, [
    anyDrawerOpen,
    consoleScale,
    integerScaling,
    manualScale,
    screenGeometry.frameWidth,
    viewMode,
  ]);

  useEffect(() => {
    runningRef.current = running;
    pausedRef.current = paused;
    modelRef.current = model;
    titleRef.current = info.title;
    presentFrameRef.current = presentFrame;
  }, [running, paused, model, info.title, presentFrame]);

  useEffect(() => {
    correctedFrameRef.current = null;
    lcdRendererRef.current?.resetPersistence();
    if (runningRef.current) presentFrame();
  }, [cgbColorCorrection, presentFrame]);

  useEffect(() => {
    let cancelled = false;
    let ownAnimation = 0;
    const generation = ++loopGenerationRef.current;
    const pageLoopToken = {};
    window.__gbcLabLoopToken = pageLoopToken;
    const frame = () => {
      if (
        cancelled ||
        generation !== loopGenerationRef.current ||
        window.__gbcLabLoopToken !== pageLoopToken
      ) return;
      const emulator = emulatorRef.current;
      const sourceCanvas = sourceCanvasRef.current;
      let context = sourceContextRef.current;
      if (!context && sourceCanvas) {
        context = sourceCanvas.getContext("2d", { alpha: false });
        sourceContextRef.current = context;
      }
      const wallTime = Date.now();
      const hostTime = window.performance.now();
      if (!context) {
        ownAnimation = requestAnimationFrame(frame);
        animationRef.current = ownAnimation;
        return;
      }

      if (bootRef.current.active) {
        const progress = (wallTime - bootRef.current.start) / 1850;
        drawBootScreen(context, modelRef.current, Math.min(1, progress), titleRef.current);
        uploadSoftwareScreen();
        if (progress >= 1) {
          bootRef.current.active = false;
          setStatus(`${modelLabel(modelRef.current)} · running`);
          lastAnimationRef.current = hostTime;
          frameAccumulatorRef.current = 0;
        }
        ownAnimation = requestAnimationFrame(frame);
        animationRef.current = ownAnimation;
        return;
      }
      if (!runningRef.current || pausedRef.current) {
        ownAnimation = requestAnimationFrame(frame);
        animationRef.current = ownAnimation;
        return;
      }

      if (!lastAnimationRef.current) lastAnimationRef.current = hostTime;
      const delta = Math.min(250, hostTime - lastAnimationRef.current);
      lastAnimationRef.current = hostTime;
      frameAccumulatorRef.current += delta;
      const frameDuration = 1000 / 59.7275;
      let frames = 0;
      const catchUpStarted = window.performance.now();
      const catchUpLimit = CATCH_UP_BUDGETS[catchUpBudgetRef.current].milliseconds;
      while (
        frameAccumulatorRef.current >= frameDuration
        && window.performance.now() - catchUpStarted < catchUpLimit
      ) {
        emulator.runFrame();
        frameAccumulatorRef.current -= frameDuration;
        frames += 1;
        fpsRef.current.frames += 1;
      }
      frameAccumulatorRef.current = Math.min(frameAccumulatorRef.current, frameDuration * 12);
      if (frames) {
        const skipPreset = FRAME_SKIP_PRESETS[frameSkipRef.current] ?? FRAME_SKIP_PRESETS.off;
        let shouldPresent;
        if (skipPreset.frames === "auto") {
          const catchUpTime = window.performance.now() - catchUpStarted;
          const underPressure = (
            frames > 1
            || frameAccumulatorRef.current >= frameDuration * 0.75
            || catchUpTime >= catchUpLimit * 0.8
          );
          shouldPresent = !underPressure || hostTime - lastPresentRef.current >= 50;
        } else {
          const cadence = skipPreset.frames + 1;
          presentationPhaseRef.current += frames;
          shouldPresent = presentationPhaseRef.current >= cadence;
          if (shouldPresent) presentationPhaseRef.current %= cadence;
        }
        if (shouldPresent) {
          if (presentFrameRef.current) presentFrameRef.current();
          lastPresentRef.current = hostTime;
        }
        fpsRef.current.presented += shouldPresent ? 1 : 0;
        fpsRef.current.skipped += Math.max(0, frames - (shouldPresent ? 1 : 0));
        if (nativeBootRef.current && !emulator.bootEnabled) {
          nativeBootRef.current = false;
          setStatus(`${modelLabel(modelRef.current)} · running`);
        }
        const audio = emulator.drainAudio();
        enqueueAudio(audio);
      }
      if (!fpsRef.current.start) fpsRef.current.start = hostTime;
      if (hostTime - fpsRef.current.start >= 500) {
        const seconds = (hostTime - fpsRef.current.start) / 1000;
        const intervalAudioPeak = audioRef.current.maxPeak;
        audioRef.current.maxPeak = 0;
        if (showTechnicalReadoutRef.current) {
          const debug = emulator.getDebugState();
          setDiagnostics({
            fps: (fpsRef.current.frames / seconds).toFixed(1),
            presentedFps: (fpsRef.current.presented / seconds).toFixed(1),
            skippedFps: (fpsRef.current.skipped / seconds).toFixed(1),
            frame: debug.frame,
            pc: debug.pc.toString(16).padStart(4, "0").toUpperCase(),
            ly: debug.ly,
            ppu: debug.mode,
            runs: debug.runFrameCalls,
            audioBuffered: Math.max(0, audioRef.current.buffered),
            audioPeak: intervalAudioPeak,
            audioUnderruns: audioRef.current.underruns,
            audioOverruns: audioRef.current.overruns,
            audioEnqueued: audioRef.current.enqueued,
            audioMode: audioRef.current.mode ?? "off",
            audioSampleRate: audioRef.current.context?.sampleRate
              ?? emulator.audioRate
              ?? 48000,
          });
        }
        fpsRef.current = {
          start: hostTime,
          frames: 0,
          presented: 0,
          skipped: 0,
        };
      }
      ownAnimation = requestAnimationFrame(frame);
      animationRef.current = ownAnimation;
    };
    ownAnimation = requestAnimationFrame(frame);
    animationRef.current = ownAnimation;
    return () => {
      cancelled = true;
      if (loopGenerationRef.current === generation) loopGenerationRef.current += 1;
      if (window.__gbcLabLoopToken === pageLoopToken) window.__gbcLabLoopToken = null;
      cancelAnimationFrame(ownAnimation);
    };
  }, [enqueueAudio, uploadSoftwareScreen]);

  useEffect(() => {
    const save = () => saveBattery();
    const guardClose = (event) => {
      saveBattery();
      if (!runningRef.current || !romRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guardClose);
    const timer = window.setInterval(save, 5000);
    return () => {
      window.removeEventListener("beforeunload", guardClose);
      window.clearInterval(timer);
    };
  }, [saveBattery]);

  useEffect(() => {
    if (!pendingModel && !pendingRestore) return undefined;
    const cancelSafetyPrompt = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (pendingRestore) cancelSaveRestore();
      else cancelModelSwitch();
    };
    window.addEventListener("keydown", cancelSafetyPrompt, { capture: true });
    return () => window.removeEventListener("keydown", cancelSafetyPrompt, true);
  }, [
    cancelModelSwitch,
    cancelSaveRestore,
    pendingModel,
    pendingRestore,
  ]);

  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
    audioLatencyRef.current = audioLatency;
    const context = audioRef.current.context;
    if (!context) return;
    const preset = AUDIO_LATENCY_PRESETS[audioLatency];
    audioRef.current.target = preset.target;
    if (
      audioRef.current.mode === "fallback"
      && audioRef.current.ring?.length !== preset.maximum * 2
    ) {
      audioRef.current.ring = new Float32Array(preset.maximum * 2);
      audioRef.current.readIndex = 0;
      audioRef.current.writeIndex = 0;
      audioRef.current.available = 0;
      audioRef.current.started = false;
    }
    if (audioRef.current.mode === "worklet") {
      audioRef.current.node.port.postMessage({
        type: "settings",
        target: preset.target,
        maximum: preset.maximum,
        gain: muted ? 0 : volume / 100,
        filter: audioFilter,
      });
    }
    if (paused) {
      context.suspend().then(() => setAudioState("PAUSED")).catch(() => {});
      return;
    }
    context.resume().then(() => setAudioState("ON")).catch(() => setAudioState("LOCKED"));
  }, [audioFilter, audioLatency, muted, paused, volume]);

  useEffect(() => {
    audioFilterRef.current = audioFilter;
    const audio = audioRef.current;
    audio.previousInputLeft = 0;
    audio.previousInputRight = 0;
    audio.previousOutputLeft = 0;
    audio.previousOutputRight = 0;
    if (audio.mode === "worklet") {
      audio.node.port.postMessage({
        type: "settings",
        target: AUDIO_LATENCY_PRESETS[audioLatencyRef.current].target,
        maximum: AUDIO_LATENCY_PRESETS[audioLatencyRef.current].maximum,
        gain: mutedRef.current ? 0 : volumeRef.current / 100,
        filter: audioFilter,
      });
    }
  }, [audioFilter]);

  return (
    <main
      className={`app-shell theme-${resolvedTheme} ${viewMode === "screen" ? "screen-only" : ""} ${paused ? "is-paused" : ""} ${anyDrawerOpen ? "drawer-open" : ""} ${showTechnicalReadout ? "technical-open" : ""}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        loadFile(event.dataTransfer.files[0]);
      }}
    >
      <div className="ambient-grid" aria-hidden="true" />
      <header className="topbar">
        <div className="brand-lockup">
          <BrandMark />
          <div>
            <strong>GAMEBOY LAB</strong>
            <span>PLAY · SAVE · PRESERVE</span>
          </div>
        </div>
        <div className="system-status">
          <span className={`status-light ${running && !paused ? "live" : ""}`} />
          <span>{paused ? "PAUSED" : status.toUpperCase()}</span>
          <button
            className="options-trigger"
            onClick={openOptions}
            aria-expanded={drawerOpen}
            aria-controls="options-drawer"
          >
            OPTIONS
          </button>
        </div>
      </header>

      <TechnicalReadout
        audioLatency={audioLatency}
        audioState={audioState}
        diagnostics={diagnostics}
        frameSkip={frameSkip}
        info={info}
        model={model}
        paused={paused}
        running={running}
        visible={showTechnicalReadout}
      />

      <input
        ref={fileRef}
        className="visually-hidden"
        type="file"
        accept=".gb,.gbc,application/octet-stream"
        onChange={(event) => {
          loadFile(event.target.files?.[0]);
          event.target.value = "";
        }}
        aria-label="Choose a Game Boy ROM"
      />
      <LibraryStackButton
        count={libraryRoms.length}
        onOpen={openLibraryDrawer}
        open={libraryDrawerOpen}
        showDiscoveryHint={showLibraryDiscovery}
      />

      <section className="workspace">
        <div
          ref={consoleWrapRef}
          className={`console-wrap model-${model} ${integerScaling ? "integer-scale" : "flexible-scale"} ${dragging ? "is-dragging" : ""} ${cartridgePresent ? "has-cartridge" : ""} ${cartridgeHovered ? "cartridge-hovered" : ""} ${cartridgePreflight ? "cartridge-preflight" : ""} ${cartridgeInserting && cartridgeAnimationEnabled ? "cartridge-inserting" : ""} ${showSaveTooltip || cartridgePreflight ? "tooltip-visible" : ""}`}
          onWheel={resizeWithWheel}
          style={{
            "--console-scale": consoleScale,
            "--screen-only-scale": integerScaling ? 1 : manualScale / 100,
            "--console-height": `${(model === "cgb" ? 612 : 652) * consoleScale}px`,
            "--console-width": `${(model === "cgb" ? 358 : 397) * consoleScale}px`,
            "--console-offset-y": `${consoleOffsetY}px`,
            "--console-offset-local": `${consoleOffsetY / Math.max(consoleScale, 0.001)}px`,
            "--shell-base-height": `${model === "cgb" ? 612 : 652}px`,
            "--shell-base-width": `${model === "cgb" ? 358 : 397}px`,
            "--screen-frame-width": `${screenGeometry.frameWidth ?? (model === "cgb" ? 236 : 264)}px`,
            "--screen-frame-height": `${(
              Math.max(0, (screenGeometry.frameWidth ?? (model === "cgb" ? 236 : 264)) - 8)
              * GAMEBOY_HEIGHT / GAMEBOY_WIDTH
              + 8
            )}px`,
          }}
        >
          <div className="device-rig" ref={deviceRigRef}>
            {cartridgePresent && (
              <CartridgeDock
                animationKey={cartridgeAnimationKey}
                cartridgeArtwork={cartridgeArtwork}
                cartridgeKind={cartridgeKind}
                cartridgeName={cartridgeName}
                inserting={cartridgeInserting || cartridgePreflight}
                onHoverChange={setCartridgeHovered}
                onOpenSaves={openSaveDrawer}
                showTooltip={showSaveTooltip}
              />
            )}
            <div className={`handheld ${model}`}>
            <div className="handheld-top" aria-hidden="true">
              <span>{model === "dmg" ? "◀ OFF · ON ▶" : ""}</span>
            </div>
            <div className="display-bezel">
              {model === "dmg" && viewMode === "console" && (
                <div className="dmg-bezel-label" aria-hidden="true">
                  <span className="dmg-lines"><i /><i /></span>
                  <b>DOT MATRIX WITH STEREO SOUND</b>
                  <span className="dmg-lines short"><i /><i /></span>
                </div>
              )}
              <div className="power-label">
                <i className={running ? "on" : ""} />
                {model === "cgb" ? "POWER" : "BATTERY"}
              </div>
              <div
                className="screen-frame"
                style={screenGeometry.frameWidth === null
                  ? undefined
                  : { width: `${screenGeometry.frameWidth}px` }}
              >
                <canvas
                  ref={sourceCanvasRef}
                  className="frame-source"
                  width={GAMEBOY_WIDTH}
                  height={GAMEBOY_HEIGHT}
                  aria-hidden="true"
                />
                <canvas
                  ref={canvasRef}
                  className="lcd-output"
                  width={GAMEBOY_WIDTH}
                  height={GAMEBOY_HEIGHT}
                  aria-label={`${modelLabel(model)} emulation display`}
                />
                <span className="screen-glass" aria-hidden="true" />
                {paused && running && (
                  <div
                    className={`pause-overlay pause-${pauseReason ?? "manual"}`}
                    role="status"
                    aria-live="polite"
                  >
                    <span className="pause-symbol" aria-hidden="true"><i /><i /></span>
                    <strong>{pauseReason === "menu" ? "MENU PAUSE" : "EMULATION PAUSED"}</strong>
                    <small>{pauseReason === "menu" ? "CLOSE DRAWER TO RESUME" : "CORE TIMING FROZEN"}</small>
                  </div>
                )}
              </div>
              {model === "cgb" && viewMode === "console" && (
                <div className="screen-caption">
                  <strong>GAME BOY</strong>
                  <em className="color-word" aria-label="COLOR">
                    <i>C</i><i>O</i><i>L</i><i>O</i><i>R</i>
                  </em>
                </div>
              )}
            </div>
            {model === "dmg" && viewMode === "console" && (
              <div className="dmg-brand" aria-hidden="true">
                <em>Nintendo</em>
                <strong>GAME BOY</strong>
                <sup>TM</sup>
              </div>
            )}

            <div className="hardware-controls" aria-label="Game Boy controls">
              <div
                className={[
                  "dpad",
                  pressedButtons.has("up") ? "press-up" : "",
                  pressedButtons.has("down") ? "press-down" : "",
                  pressedButtons.has("left") ? "press-left" : "",
                  pressedButtons.has("right") ? "press-right" : "",
                ].filter(Boolean).join(" ")}
                aria-label="Directional pad"
                style={{
                  "--dpad-tilt-x": `${(
                    (pressedButtons.has("down") ? -1 : 0)
                    + (pressedButtons.has("up") ? 1 : 0)
                  ) * 5}deg`,
                  "--dpad-tilt-y": `${(
                    (pressedButtons.has("right") ? 1 : 0)
                    + (pressedButtons.has("left") ? -1 : 0)
                  ) * 5}deg`,
                  "--dpad-press-x": `${(
                    (pressedButtons.has("right") ? 1 : 0)
                    + (pressedButtons.has("left") ? -1 : 0)
                  ) * 1.25}px`,
                  "--dpad-press-y": `${(
                    (pressedButtons.has("down") ? 1 : 0)
                    + (pressedButtons.has("up") ? -1 : 0)
                  ) * 1.25}px`,
                }}
              >
                <span className="dpad-cross" aria-hidden="true" />
                <svg className="dpad-outline" viewBox="0 0 100 100" aria-hidden="true">
                  <path d="M33.333 1H66.667V33.333H99V66.667H66.667V99H33.333V66.667H1V33.333H33.333Z" />
                </svg>
                <ControlButton className="dpad-up" label="▲" sublabel="Up" button="up" onPress={pressButton} pressed={pressedButtons.has("up")} />
                <ControlButton className="dpad-left" label="◀" sublabel="Left" button="left" onPress={pressButton} pressed={pressedButtons.has("left")} />
                <span className="dpad-center" aria-hidden="true" />
                <ControlButton className="dpad-right" label="▶" sublabel="Right" button="right" onPress={pressButton} pressed={pressedButtons.has("right")} />
                <ControlButton className="dpad-down" label="▼" sublabel="Down" button="down" onPress={pressButton} pressed={pressedButtons.has("down")} />
              </div>
              <div className="action-buttons">
                <ControlButton className="button-b" label="B" button="b" onPress={pressButton} pressed={pressedButtons.has("b")} />
                <ControlButton className="button-a" label="A" button="a" onPress={pressButton} pressed={pressedButtons.has("a")} />
                {model === "dmg" && (
                  <>
                    <span className="action-label action-label-b" aria-hidden="true">B</span>
                    <span className="action-label action-label-a" aria-hidden="true">A</span>
                  </>
                )}
              </div>
              <div className="meta-buttons">
                <ControlButton label="" sublabel="Select" button="select" onPress={pressButton} pressed={pressedButtons.has("select")} />
                <ControlButton label="" sublabel="Start" button="start" onPress={pressButton} pressed={pressedButtons.has("start")} />
              </div>
              <div className="speaker" aria-hidden="true">
                {Array.from({ length: model === "cgb" ? 20 : 6 }, (_, index) => (
                  <i key={index} />
                ))}
              </div>
              {model === "cgb" && <div className="cgb-nintendo" aria-hidden="true">Nintendo®</div>}
            </div>
            </div>
          </div>
        </div>

        <RomLibraryDrawer
          activeLibraryId={activeLibraryId}
          libraryFilter={libraryFilter}
          libraryQuery={libraryQuery}
          libraryReady={libraryReady}
          libraryRoms={libraryRoms}
          libraryStatus={libraryStatus}
          libraryView={libraryView}
          loadLibraryRom={loadLibraryRom}
          onAddRom={() => {
            startAudio();
            fileRef.current?.click();
          }}
          onClose={closeLibraryDrawer}
          onFilter={setLibraryFilter}
          onQuery={setLibraryQuery}
          onRemove={removeFromLibrary}
          onView={setLibraryView}
          open={libraryDrawerOpen}
          removingLibraryId={removingLibraryId}
        />

        <aside
          id="options-drawer"
          className={`control-deck ${drawerOpen ? "open" : ""}`}
          aria-hidden={!drawerOpen}
          inert={!drawerOpen}
        >
          <div className="drawer-heading">
            <div>
              <span>GAMEBOY LAB · v{APP_VERSION}</span>
              <h2>Options</h2>
            </div>
            <button onClick={closeOptions} aria-label="Close options">CLOSE ×</button>
          </div>

          <section className="deck-section">
            <div className="section-heading">
              <span>00</span>
              <div>
                <h2>Hardware</h2>
                <p>Cold-switch console model</p>
              </div>
            </div>
            <div className="segmented model-switch" aria-label="Console model">
              <button className={model === "dmg" ? "active" : ""} onClick={() => switchModel("dmg")} aria-pressed={model === "dmg"}>
                <b>DMG</b><small>1989</small>
              </button>
              <button className={model === "cgb" ? "active" : ""} onClick={() => switchModel("cgb")} aria-pressed={model === "cgb"}>
                <b>GBC</b><small>1998</small>
              </button>
            </div>
            {model === "cgb" && (
              <label className="palette-picker">
                <span>DMG cartridge palette</span>
                <select
                  value={compatibilityPalette}
                  onChange={(event) => chooseCompatibilityPalette(event.target.value)}
                  aria-label="DMG compatibility palette"
                >
                  {CGB_COMPATIBILITY_PALETTES.map((palette) => (
                    <option key={palette.id} value={palette.id}>
                      {palette.label} · {palette.buttons}
                    </option>
                  ))}
                </select>
                <small>Original GBC startup colors · monochrome cartridges only</small>
                {compatibilityPalette !== "auto" && (
                  <span className="palette-swatches" aria-hidden="true">
                    {CGB_COMPATIBILITY_PALETTES
                      .find((palette) => palette.id === compatibilityPalette)
                      ?.colors.map((color, index) => (
                        <i key={index} style={{ background: `rgb(${color.join(",")})` }} />
                      ))}
                  </span>
                )}
              </label>
            )}
            <div className="transport">
              <button
                onClick={() => {
                  if (paused) resumeGame();
                  else pauseGame("manual");
                }}
                disabled={!running}
                data-testid="pause-toggle"
              >
                {paused ? "▶ RESUME" : "Ⅱ PAUSE"}
              </button>
              <button onClick={reset} disabled={!running}>↻ RESET</button>
            </div>
          </section>

          <section className="deck-section">
            <div className="section-heading">
              <span>01</span>
              <div>
                <h2>Presentation</h2>
                <p>Console shell, screen focus, and theme</p>
              </div>
            </div>
            <div className="option-stack">
              <div>
                <span className="option-label">View</span>
                <div className="segmented two-way" aria-label="Presentation mode">
                  <button className={viewMode === "console" ? "active" : ""} onClick={() => switchViewMode("console")} aria-pressed={viewMode === "console"}>Console</button>
                  <button className={viewMode === "screen" ? "active" : ""} onClick={() => switchViewMode("screen")} aria-pressed={viewMode === "screen"}>Screen only</button>
                </div>
              </div>
              <div>
                <span className="option-label">Theme</span>
                <div className="segmented three-way" aria-label="Color theme">
                  <button className={theme === "system" ? "active" : ""} onClick={() => setTheme("system")} aria-pressed={theme === "system"}>System</button>
                  <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")} aria-pressed={theme === "light"}>Light</button>
                  <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")} aria-pressed={theme === "dark"}>Dark</button>
                </div>
              </div>
            </div>
          </section>

          <section className="deck-section">
            <div className="section-heading">
              <span>02</span>
              <div>
                <h2>LCD response</h2>
                <p>Pixel grid and independent persistence</p>
              </div>
            </div>
            <div className="segmented lcd-options" aria-label="LCD processing mode">
              {[
                ["sharp", "Sharp"],
                ["response", "LCD"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={lcdMode === value ? "active" : ""}
                  onClick={() => {
                    setLcdMode(value);
                    lcdRendererRef.current?.resetPersistence();
                  }}
                  aria-pressed={lcdMode === value}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              className={`preference-toggle ghosting-toggle ${ghostingEnabled ? "active" : ""}`}
              onClick={() => {
                setGhostingEnabled((value) => !value);
                lcdRendererRef.current?.resetPersistence();
              }}
              aria-pressed={ghostingEnabled}
            >
              <span>Ghosting</span>
              <b>{ghostingEnabled ? "ON" : "OFF"}</b>
            </button>
            <label className="range-control">
              <span><b>Ghosting strength</b><output>{ghostStrength}%</output></span>
              <input
                type="range"
                min="8"
                max="72"
                value={ghostStrength}
                disabled={!ghostingEnabled}
                onChange={(event) => setGhostStrength(Number(event.target.value))}
                aria-label="Ghosting strength"
              />
            </label>
            {model === "dmg" && (
              <label className="range-control dmg-contrast-control">
                <span><b>Game Boy contrast</b><output>{dmgContrast}%</output></span>
                <input
                  type="range"
                  min="70"
                  max="150"
                  step="1"
                  value={dmgContrast}
                  onChange={(event) => setDmgContrast(Number(event.target.value))}
                  aria-label="Game Boy display contrast"
                />
                <small>Darker production-LCD tone · 112% default</small>
              </label>
            )}
          </section>

          <section className="deck-section">
            <div className="section-heading">
              <span>03</span>
              <div>
                <h2>Audio</h2>
                <p>Browser output · {audioState}</p>
              </div>
            </div>
            <button
              className={`sound-toggle ${muted ? "" : "active"}`}
              onClick={() => {
                startAudio();
                setMuted((value) => !value);
              }}
              aria-pressed={!muted}
              data-testid="mute-toggle"
            >
              <span>{muted ? "MUTED" : "SOUND ON"}</span>
              <b>{muted ? "UNMUTE" : "MUTE"}</b>
            </button>
            <label className="range-control">
              <span><b>Volume</b><output>{volume}%</output></span>
              <input
                type="range"
                min="0"
                max="100"
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
                aria-label="Audio volume"
              />
            </label>
          </section>

          <section className="deck-section">
            <div className="section-heading">
              <span>04</span>
              <div>
                <h2>Controls</h2>
                <p>Click a key, then press its replacement</p>
              </div>
            </div>
            <button
              className={`preference-toggle ${keyboardMotion ? "active" : ""}`}
              onClick={() => setKeyboardMotion((value) => !value)}
              aria-pressed={keyboardMotion}
            >
              <span>Keyboard button motion</span>
              <b>{keyboardMotion ? "ON" : "OFF"}</b>
            </button>
            <div className="keybind-grid" aria-label="Keyboard bindings">
              {BINDING_ORDER.map((button) => (
                <div key={button}>
                  <span>{button.toUpperCase()}</span>
                  <button
                    className={bindingTarget === button ? "listening" : ""}
                    onClick={() => setBindingTarget((current) => current === button ? null : button)}
                    aria-label={`Bind ${button}`}
                  >
                    {bindingTarget === button ? "PRESS KEY…" : keyLabel(keyBindings[button])}
                  </button>
                </div>
              ))}
            </div>
            <button
              className="reset-bindings"
              onClick={() => {
                setKeyBindings(DEFAULT_BINDINGS);
                setBindingTarget(null);
              }}
            >
              RESET KEYBINDS
            </button>
          </section>

          <section className="deck-section advanced-section">
            <div className="section-heading">
              <span>05</span>
              <div>
                <h2>Advanced</h2>
                <p>Timing, scaling, audio, and video</p>
              </div>
            </div>
            <div className="advanced-settings">
              <article className="advanced-setting advanced-choice backup-restore-setting">
                <div className="advanced-choice-heading">
                  <span>Restore all saved games</span>
                  <b>{backupStatus}</b>
                </div>
                <div className="backup-restore-actions">
                  <button type="button" onClick={() => backupFileRef.current?.click()}>
                    CHOOSE BACKUP FILE
                  </button>
                </div>
                <input
                  ref={backupFileRef}
                  className="visually-hidden"
                  type="file"
                  accept=".json,application/json"
                  aria-label="Restore all GAMEBOY LAB saves from backup"
                  onChange={(event) => {
                    prepareSaveRestore(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <details className="setting-info">
                  <summary>Backup restore safety</summary>
                  <p>
                    Loads one GAMEBOY LAB backup containing battery-backed cartridge RAM,
                    real-time clock data, and emulator save-state slots for every game.
                    The complete file is checked before any browser storage is changed.
                  </p>
                  <p>
                    Restore replaces all save records currently cached by this app. It does
                    not replace ROMs, cover art, key bindings, display settings, or other
                    preferences. A final warning shows the exact record counts before restore.
                  </p>
                  <p><b>Recommended:</b> Download a fresh complete backup from Save options first.</p>
                </details>
              </article>

              <article className="advanced-setting">
                <button
                  className={`preference-toggle ${showTechnicalReadout ? "active" : ""}`}
                  onClick={() => setTechnicalReadoutRequested((value) => !value)}
                  aria-pressed={showTechnicalReadout}
                  disabled={!technicalReadoutSupported}
                >
                  <span>
                    {technicalReadoutSupported
                      ? "Show technical readout"
                      : "Technical readout · wide window only"}
                  </span>
                  <b>
                    {technicalReadoutSupported
                      ? showTechnicalReadout ? "ON" : "OFF"
                      : "UNAVAILABLE"}
                  </b>
                </button>
                <details className="setting-info">
                  <summary>What this shows</summary>
                  <p>
                    Opens a live monitor on the main emulator screen. It separates emulated
                    frame rate from frames actually presented by the browser, reports skipped
                    presentations, audio queue depth and target, underruns, latency trims,
                    current CPU/PPU state, and the inserted cartridge&apos;s mapper, memory,
                    target hardware, header result, and real-time clock support.
                  </p>
                  <p>
                    The monitor only reads counters that the core already maintains. It does
                    not add logging inside CPU or pixel hot paths, and hiding it removes its
                    visual updates without changing emulation timing.
                  </p>
                  <p><b>Recommended:</b> Off while playing; on when tuning performance or audio.</p>
                </details>
              </article>

              <article className="advanced-setting">
                <button
                  className={`preference-toggle ${pauseOnMenu ? "active" : ""}`}
                  onClick={togglePauseOnMenu}
                  aria-pressed={pauseOnMenu}
                >
                  <span>Opening menu pauses gameplay</span>
                  <b>{pauseOnMenu ? "ON" : "OFF"}</b>
                </button>
                <details className="setting-info">
                  <summary>What this changes</summary>
                  <p>
                    Stops the emulated CPU, PPU, APU, timers, DMA, cartridge clock, and joypad
                    state before the drawer begins moving. The audio queue is suspended rather
                    than allowed to drain into silence, so closing the drawer resumes from the
                    same machine cycle without a timing jump.
                  </p>
                  <p>
                    This is a true emulator pause, not just a dark overlay. Turn it off only
                    when you deliberately want a game to keep running while changing display
                    or audio settings.
                  </p>
                  <p><b>Recommended:</b> On for predictable gameplay and safe menu use.</p>
                </details>
              </article>

              <article className="advanced-setting">
                <button
                  className={`preference-toggle ${cartridgeAnimationEnabled ? "active" : ""}`}
                  onClick={() => setCartridgeAnimationEnabled((value) => !value)}
                  aria-pressed={cartridgeAnimationEnabled}
                >
                  <span>Cartridge insertion animation</span>
                  <b>{cartridgeAnimationEnabled ? "ON" : "OFF"}</b>
                </button>
                <details className="setting-info">
                  <summary>What this changes</summary>
                  <p>
                    Plays the quick cartridge slide and hardware knockback before a newly
                    selected ROM begins its BIOS boot. It is presentation-only and never
                    changes ROM bytes, cartridge RAM, save states, BIOS execution, or the
                    timing seen by the emulated hardware.
                  </p>
                  <p>
                    Switching console model or presentation mode replays the motion so the
                    cartridge remains visually attached to the new shell. Disable it to skip
                    that presentation delay; compatibility and accuracy are identical.
                  </p>
                  <p><b>Recommended:</b> On. Off is useful for rapid ROM testing.</p>
                </details>
              </article>

              <article className="advanced-setting">
                <button
                  className={`preference-toggle ${integerScaling ? "active" : ""}`}
                  onClick={() => setIntegerScaling((value) => !value)}
                  aria-pressed={integerScaling}
                >
                  <span>Integer display scaling</span>
                  <b>{integerScaling ? "ON" : "OFF"}</b>
                </button>
                <details className="setting-info">
                  <summary>What this changes</summary>
                  <p>
                    A Game Boy frame is exactly 160×144 source pixels. Integer scaling maps every
                    source pixel to a whole block of physical display pixels—such as 3×3 or 6×6—
                    after accounting for the screen&apos;s device-pixel density. No source pixel
                    has to share a physical column or row with its neighbour.
                  </p>
                  <p>
                    With the DMG LCD shader, that keeps every dot and the gap around it the same
                    width. With the GBC shader, it keeps the LCD cell and RGB stripe pattern
                    evenly aligned. Sharp mode also benefits because all pixel blocks remain
                    identical instead of alternating between wider and narrower samples.
                  </p>
                  <p>
                    When integer scaling is off, the manual slider can use fractional sizes to
                    fill more of the available space. The shader analytically averages its LCD
                    pattern to reduce moiré, but the browser must still distribute 160 source
                    pixels across a non-whole number of physical pixels, so some boundaries can
                    differ by one pixel.
                  </p>
                  <p><b>Recommended:</b> On for the most even DMG dots and GBC LCD grid.</p>
                </details>
                {!integerScaling && (
                  <div className="manual-scale-control">
                    <label className="range-control">
                      <span><b>Manual device scale</b><output>{manualScale}%</output></span>
                      <input
                        type="range"
                        min="55"
                        max="100"
                        step="1"
                        value={manualScale}
                        onChange={(event) => setManualScale(Number(event.target.value))}
                        aria-label="Manual Game Boy scale"
                      />
                    </label>
                    <div>
                      <small>Desktop: scroll over the console to resize.</small>
                      {manualScale !== 90 && (
                        <button onClick={() => setManualScale(90)}>RESET DEFAULT</button>
                      )}
                    </div>
                  </div>
                )}
              </article>

              <article className="advanced-setting advanced-choice">
                <div className="advanced-choice-heading">
                  <span>Audio buffering</span>
                  <b>{AUDIO_LATENCY_PRESETS[audioLatency].label}</b>
                </div>
                <div className="segmented four-way" aria-label="Audio buffering">
                  {Object.entries(AUDIO_LATENCY_PRESETS).map(([value, preset]) => (
                    <button
                      key={value}
                      className={audioLatency === value ? "active" : ""}
                      onClick={() => {
                        setAudioLatency(value);
                        flushAudio();
                      }}
                      aria-pressed={audioLatency === value}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <details className="setting-info">
                  <summary>What this changes</summary>
                  <p>
                    Sets how much completed stereo audio is ready on the browser&apos;s dedicated
                    audio thread before playback starts. At 48 kHz, the targets are roughly
                    16 ms for Low, 27 ms for Balanced, 53 ms for Stable, and 85 ms for Deep.
                    The browser and audio device add their own output latency after this queue.
                  </p>
                  <p>
                    Low reacts fastest but has the least protection from a busy main thread.
                    Stable and Deep absorb longer scheduling stalls. The queue now has a strict
                    ceiling and gently sheds excess timing debt instead of growing to several
                    times the target and then deleting an entire sound-effect chunk.
                  </p>
                  <p>
                    An underrun means the audio thread ran out of samples and had to restart after
                    refilling; an overrun means stale buffered time was trimmed to stop latency
                    growing. Try Stable if sound drops. Use Low only when the diagnostic counters
                    remain at zero.
                  </p>
                  <p><b>Recommended:</b> Balanced for desktop use; Stable for busy or power-limited systems.</p>
                </details>
              </article>

              <article className="advanced-setting advanced-choice">
                <div className="advanced-choice-heading">
                  <span>Host catch-up budget</span>
                  <b>{CATCH_UP_BUDGETS[catchUpBudget].label}</b>
                </div>
                <div className="segmented three-way" aria-label="Host catch-up budget">
                  {Object.entries(CATCH_UP_BUDGETS).map(([value, preset]) => (
                    <button
                      key={value}
                      className={catchUpBudget === value ? "active" : ""}
                      onClick={() => setCatchUpBudget(value)}
                      aria-pressed={catchUpBudget === value}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <details className="setting-info">
                  <summary>What this changes</summary>
                  <p>
                    Controls how much real CPU time one browser refresh may spend recovering
                    emulated frames after the host stalls: Cool allows 4 ms, Balanced 8 ms, and
                    Aggressive 14 ms. Recovery remains cycle-accurate—the core executes every
                    missed CPU, timer, PPU, APU, DMA, and mapper step in order.
                  </p>
                  <p>
                    This does not overclock the Game Boy or raise its 59.7275 Hz hardware rate.
                    It only decides how quickly wall-clock debt is repaid. Cool reduces heat and
                    long tasks; Aggressive reduces prolonged slow motion after a large host pause.
                  </p>
                  <p><b>Recommended:</b> Balanced. Use Cool for battery life and Aggressive for fast hosts.</p>
                </details>
              </article>

              <article className="advanced-setting advanced-choice">
                <div className="advanced-choice-heading">
                  <span>Frame skipping</span>
                  <b>{FRAME_SKIP_PRESETS[frameSkip].label}</b>
                </div>
                <div className="segmented four-way" aria-label="Frame skipping">
                  {Object.entries(FRAME_SKIP_PRESETS).map(([value, preset]) => (
                    <button
                      key={value}
                      className={frameSkip === value ? "active" : ""}
                      onClick={() => {
                        setFrameSkip(value);
                        frameSkipRef.current = value;
                        presentationPhaseRef.current = 0;
                        lastPresentRef.current = 0;
                        presentFrameRef.current?.();
                      }}
                      aria-pressed={frameSkip === value}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <details className="setting-info">
                  <summary>What this changes</summary>
                  <p>
                    Off presents every completed Game Boy frame at its native 59.7275 Hz cadence.
                    Skip 1 presents every second frame (about 29.86 Hz); Skip 2 presents every
                    third (about 19.91 Hz). Auto presents every frame when there is headroom and
                    temporarily skips display uploads while the host is catching up.
                  </p>
                  <p>
                    CPU, PPU, timers, DMA, mappers, input polling, save RAM, and audio still run
                    at full hardware speed. Only the final canvas/WebGL presentation is skipped,
                    so gameplay timing, audio pitch, input polling, saves, and the emulated LCD
                    state remain correct. This is a GPU/presentation relief control, not an
                    emulation shortcut.
                  </p>
                  <p>
                    Auto guarantees a fresh display at least every 50 ms while under pressure.
                    Fixed skipping is useful for very high-resolution shaders or battery life,
                    but motion becomes visibly less smooth.
                  </p>
                  <p><b>Recommended:</b> Off normally; Auto if the shader or display scale causes stutter.</p>
                </details>
              </article>

              <article className="advanced-setting">
                <button
                  className={`preference-toggle ${backgroundPause ? "active" : ""}`}
                  onClick={() => setBackgroundPause((value) => !value)}
                  aria-pressed={backgroundPause}
                >
                  <span>Pause in background</span>
                  <b>{backgroundPause ? "ON" : "OFF"}</b>
                </button>
                <details className="setting-info">
                  <summary>What this changes</summary>
                  <p>
                    Stops the emulated machine when the page becomes hidden. Browsers heavily
                    throttle animation callbacks in background tabs; without this guard, the
                    scheduler can accumulate wall-clock debt and then spend several refreshes
                    catching up while audio queues refill.
                  </p>
                  <p>
                    Returning restores the same emulated cycle and clears stale host timing. Turn
                    it off only for games that must deliberately advance while the page is hidden;
                    background execution still depends on the browser&apos;s own throttling policy.
                  </p>
                  <p><b>Recommended:</b> On for stable timing and lower background power use.</p>
                </details>
              </article>

              <article className="advanced-setting">
                <button
                  className={`preference-toggle ${cgbColorCorrection ? "active" : ""}`}
                  onClick={() => {
                    setCgbColorCorrection((value) => !value);
                    correctedFrameRef.current = null;
                    lcdRendererRef.current?.resetPersistence();
                  }}
                  aria-pressed={cgbColorCorrection}
                >
                  <span>GBC LCD color correction</span>
                  <b>{cgbColorCorrection ? "ON" : "RAW"}</b>
                </button>
                <details className="setting-info">
                  <summary>What this changes</summary>
                  <p>
                    Converts the GBC&apos;s 15-bit BGR output through a cross-channel color matrix
                    before the LCD shader. Real reflective GBC panels were dimmer and their color
                    channels influenced one another, so an uncorrected modern display looks more
                    saturated and higher-contrast than the handheld.
                  </p>
                  <p>
                    Raw preserves the cartridge&apos;s decoded 5-bit channel values for clean
                    pixel-art capture. This option does not alter palette RAM, blending rules,
                    sprite priority, or DMG compatibility palettes; DMG rendering is unaffected.
                  </p>
                  <p><b>Recommended:</b> On for hardware-like color; Raw for source-color capture.</p>
                </details>
              </article>

              <article className="advanced-setting">
                <button
                  className={`preference-toggle ${audioFilter ? "active" : ""}`}
                  onClick={() => setAudioFilter((value) => !value)}
                  aria-pressed={audioFilter}
                >
                  <span>Analog audio coupling</span>
                  <b>{audioFilter ? "ON" : "RAW"}</b>
                </button>
                <details className="setting-info">
                  <summary>What this changes</summary>
                  <p>
                    Applies a DC-blocking high-pass stage like the handheld&apos;s output
                    coupling capacitors. The filter removes constant speaker offset and slow
                    baseline drift from the four-channel mix, which reduces power-on and register
                    transition clicks without muting legitimate square, wave, or noise content.
                  </p>
                  <p>
                    It runs after NR50/NR51 volume and stereo routing, so duty timing, envelope,
                    sweep, length counters, wave RAM, noise LFSR, pitch, and channel placement are
                    unchanged. Raw exposes the unfiltered digital mix for waveform diagnostics.
                  </p>
                  <p><b>Recommended:</b> On for normal listening; Raw for APU debugging.</p>
                </details>
              </article>
            </div>
          </section>

          <p className="key-hint">
            <span>KEYS</span>
            {BINDING_ORDER.map((button, index) => (
              <span key={button}>
                {index > 0 ? " · " : ""}
                <kbd>{keyLabel(keyBindings[button])}</kbd> {button.toUpperCase()}
              </span>
            ))}
          </p>
        </aside>

        <aside
          id="save-drawer"
          className={`control-deck save-deck ${saveDrawerOpen ? "open" : ""}`}
          aria-hidden={!saveDrawerOpen}
          inert={!saveDrawerOpen}
        >
          <div className="drawer-heading save-drawer-heading">
            <div>
              <span>CARTRIDGE DOCK</span>
              <h2>Save options</h2>
            </div>
            <button onClick={closeSaveDrawer} aria-label="Close save options">CLOSE ×</button>
          </div>

          <section className="deck-section save-cartridge-summary">
            <div className="save-summary-art" aria-hidden="true">
              {cartridgeArtwork ? (
                <img src={cartridgeArtwork} alt="" />
              ) : (
                <span>{cartridgeKind === "gbc" ? "GBC" : "GB"}</span>
              )}
            </div>
            <div className="save-summary-body">
              <span className="save-summary-eyebrow">INSERTED CARTRIDGE</span>
              <h2>{info.title}</h2>
              <div className="save-summary-meta">
                <span>{modelLabel(model)}</span>
                <span>LOCAL STORAGE</span>
                <span className={info.battery ? "available" : ""}>
                  {info.battery ? "BATTERY SAVE READY" : "NO BATTERY SAVE"}
                </span>
              </div>
            </div>
          </section>

          <SaveCenter
            backupStatus={backupStatus}
            confirmingSlot={confirmingSlot}
            downloadAllSaves={downloadAllSaves}
            downloadCartridgeSave={downloadCartridgeSave}
            importCartridgeSave={importCartridgeSave}
            info={info}
            loadStateSlot={loadStateSlot}
            clearStateSlot={clearStateSlot}
            running={running}
            saveFileRef={saveFileRef}
            saveSlots={saveSlots}
            saveStateSlot={saveStateSlot}
            saveStatus={saveStatus}
          />
        </aside>

        {anyDrawerOpen && (
          <button
            className="drawer-backdrop"
            aria-label={libraryDrawerOpen
              ? "Close game library"
              : saveDrawerOpen
                ? "Close save options"
                : "Close options"}
            onClick={closeDrawers}
          />
        )}
      </section>
      {pendingModel && (
        <SafetyPrompt
          eyebrow="RUNNING GAME"
          title={`Switch to ${modelLabel(pendingModel)}?`}
          detail={`Changing console restarts ${info.title} from its cartridge save. GAMEBOY LAB will save battery-backed progress first; the current live machine state is not preserved unless you create a save state.`}
          confirmLabel={`SWITCH TO ${modelLabel(pendingModel)}`}
          onCancel={cancelModelSwitch}
          onConfirm={confirmModelSwitch}
        />
      )}
      {pendingRestore && (
        <SafetyPrompt
          eyebrow="REPLACE LOCAL SAVE DATA"
          title="Restore complete backup?"
          detail={`${pendingRestore.fileName} contains ${pendingRestore.summary.batterySaves} cartridge saves and ${pendingRestore.summary.saveStates} save states across ${pendingRestore.summary.games} games. Continuing replaces every save currently cached by GAMEBOY LAB.`}
          confirmLabel="REPLACE & RESTORE"
          onCancel={cancelSaveRestore}
          onConfirm={restoreAllSaves}
        />
      )}
      {scaleToast && (
        <div className="scale-toast" role="status" aria-live="polite">
          {scaleToast}
        </div>
      )}
      {availableUpdate && (
        <UpdatePrompt
          update={availableUpdate}
          onDismiss={() => setAvailableUpdate(null)}
        />
      )}
    </main>
  );
}
