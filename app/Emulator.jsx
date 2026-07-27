"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GAMEBOY_HEIGHT, GAMEBOY_WIDTH, GameBoy } from "./lib/gameboy";

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
};

function formatBytes(bytes) {
  if (!bytes) return "—";
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
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

function drawWaitingScreen(context, model) {
  const image = context.createImageData(GAMEBOY_WIDTH, GAMEBOY_HEIGHT);
  const isColor = model === "cgb";
  const background = isColor ? [232, 232, 224] : [202, 220, 159];
  for (let i = 0; i < image.data.length; i += 4) {
    const noise = ((i / 4 * 17) % 7) - 3;
    image.data[i] = background[0] + noise;
    image.data[i + 1] = background[1] + noise;
    image.data[i + 2] = background[2] + noise;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  context.fillStyle = isColor ? "#303038" : "#183a34";
  context.textAlign = "center";
  context.font = "bold 10px monospace";
  context.fillText("INSERT CARTRIDGE", 80, 66);
  context.font = "6px monospace";
  context.fillText("DROP .GB OR .GBC FILE", 80, 80);
  context.fillRect(42, 91, 76, 1);
}

function drawBootScreen(context, model, progress, title) {
  const cgb = model === "cgb";
  context.fillStyle = cgb ? "#f4f1e9" : "#cadc9f";
  context.fillRect(0, 0, 160, 144);
  const eased = 1 - Math.pow(1 - Math.min(1, progress / 0.62), 3);
  const y = -28 + eased * 94;
  context.save();
  context.textAlign = "center";
  if (cgb) {
    context.font = "italic 900 21px Arial Black, sans-serif";
    context.fillStyle = "#4d64b4";
    context.textAlign = "center";
    context.fillText("GAME BOY", 80, y);
    context.font = "700 5px monospace";
    const colorWord = "COLOR";
    const colorPalette = ["#e34868", "#755bb0", "#4eaa73", "#d3a739", "#3f7db4"];
    const letterGap = 1;
    const widths = [...colorWord].map((letter) => context.measureText(letter).width);
    const totalWidth = widths.reduce((sum, width) => sum + width, 0) + letterGap * (colorWord.length - 1);
    let colorX = 80 - totalWidth / 2;
    context.textAlign = "left";
    [...colorWord].forEach((letter, index) => {
      context.fillStyle = colorPalette[index];
      context.fillText(letter, colorX, y + 8);
      colorX += widths[index] + letterGap;
    });
  } else {
    context.fillStyle = "#1c443c";
    context.font = "italic 900 20px Arial Black, sans-serif";
    context.fillText("GAME BOY", 80, y);
    context.font = "5px monospace";
    context.fillText("DOT MATRIX WITH STEREO SOUND", 80, y + 10);
  }
  if (progress > 0.62) {
    const fade = Math.min(1, (progress - 0.62) / 0.2);
    context.globalAlpha = fade;
    context.fillStyle = cgb ? "#2f2d3d" : "#183a34";
    context.textAlign = "center";
    context.font = "bold 8px monospace";
    context.fillText("Nintendo", 80, 100);
    context.font = "5px monospace";
    context.fillText(title.slice(0, 18), 80, 116);
  }
  if (progress > 0.9) {
    context.globalAlpha = Math.min(1, (progress - 0.9) * 10);
    context.fillStyle = cgb ? "#f4f1e9" : "#cadc9f";
    context.fillRect(0, 0, 160, 144);
  }
  context.restore();
}

function ControlButton({ label, sublabel, button, onPress, pressed = false, className = "" }) {
  const stop = (event) => {
    event.preventDefault();
    window.setTimeout(() => onPress(button, false), 70);
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
      onClick={() => {
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

export default function Emulator() {
  const canvasRef = useRef(null);
  const fileRef = useRef(null);
  const bootFileRef = useRef(null);
  const emulatorRef = useRef(new GameBoy("dmg"));
  const romRef = useRef(null);
  const romKeyRef = useRef("");
  const bootRomsRef = useRef({ dmg: null, cgb: null });
  const nativeBootRef = useRef(false);
  const animationRef = useRef(0);
  const previousFrameRef = useRef(null);
  const persistentFrameRef = useRef(null);
  const audioRef = useRef({ context: null, node: null, queue: [], readIndex: 0, peak: 0, maxPeak: 0 });
  const bootRef = useRef({ active: false, start: 0 });
  const lastAnimationRef = useRef(0);
  const frameAccumulatorRef = useRef(0);
  const fpsRef = useRef({ start: 0, frames: 0 });
  const volumeRef = useRef(70);
  const mutedRef = useRef(false);
  const keyBindingsRef = useRef(DEFAULT_BINDINGS);
  const bindingTargetRef = useRef(null);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const modelRef = useRef("dmg");
  const titleRef = useRef(EMPTY_INFO.title);
  const presentFrameRef = useRef(null);
  const loopGenerationRef = useRef(0);

  const [model, setModelState] = useState("dmg");
  const [info, setInfo] = useState(EMPTY_INFO);
  const [status, setStatus] = useState("Awaiting cartridge");
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [lcdMode, setLcdMode] = useState("response");
  const [ghostStrength, setGhostStrength] = useState(42);
  const [volume, setVolume] = useState(70);
  const [muted, setMuted] = useState(false);
  const [audioState, setAudioState] = useState("LOCKED");
  const [theme, setTheme] = useState("light");
  const [viewMode, setViewMode] = useState("console");
  const [consoleScale, setConsoleScale] = useState(1);
  const [keyboardMotion, setKeyboardMotion] = useState(true);
  const [keyBindings, setKeyBindings] = useState(DEFAULT_BINDINGS);
  const [bindingTarget, setBindingTarget] = useState(null);
  const [pressedButtons, setPressedButtons] = useState(() => new Set());
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [diagnostics, setDiagnostics] = useState({
    fps: "—", frame: 0, pc: "0100", ly: 0, ppu: 0, runs: 0, audioBuffered: 0, audioPeak: 0,
  });
  const [message, setMessage] = useState("Choose a legally obtained ROM. Nothing is uploaded.");
  const [booting, setBooting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [bootInfo, setBootInfo] = useState({ dmg: 0, cgb: 0 });

  const saveBattery = useCallback(() => {
    const emulator = emulatorRef.current;
    const battery = emulator.exportBattery();
    if (!battery || !romKeyRef.current) return;
    try {
      localStorage.setItem(`gbc-lab-save:${romKeyRef.current}`, bytesToBase64(battery));
    } catch {
      // A full storage quota must never interrupt emulation.
    }
  }, []);

  const startAudio = useCallback(() => {
    if (typeof window === "undefined") return;
    if (audioRef.current.context) {
      audioRef.current.context.resume().then(() => setAudioState("ON")).catch(() => setAudioState("LOCKED"));
      return;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      setAudioState("UNAVAILABLE");
      return;
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    const node = context.createScriptProcessor(1024, 0, 2);
    const audioStateRef = { context, node, queue: [], readIndex: 0, peak: 0, maxPeak: 0 };
    node.onaudioprocess = (event) => {
      const left = event.outputBuffer.getChannelData(0);
      const right = event.outputBuffer.getChannelData(1);
      const audio = audioRef.current;
      const gain = mutedRef.current ? 0 : volumeRef.current / 100;
      let peak = 0;
      for (let i = 0; i < left.length; i += 1) {
        const leftSample = audio.queue[audio.readIndex++] || 0;
        const rightSample = audio.queue[audio.readIndex++] || 0;
        left[i] = leftSample * gain;
        right[i] = rightSample * gain;
        peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
      }
      audio.peak = peak;
      audio.maxPeak = Math.max(audio.maxPeak, peak);
      if (audio.readIndex > 8192) {
        audio.queue = audio.queue.slice(audio.readIndex);
        audio.readIndex = 0;
      }
    };
    node.connect(context.destination);
    audioRef.current = audioStateRef;
    context.onstatechange = () => setAudioState(context.state === "running" ? "ON" : context.state.toUpperCase());
    context.resume().then(() => setAudioState("ON")).catch(() => setAudioState("LOCKED"));
  }, []);

  const presentFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const emulator = emulatorRef.current;
    const context = canvas.getContext("2d", { alpha: false });
    const current = emulator.framebuffer;
    let output = current;
    if (lcdMode !== "sharp") {
      if (!previousFrameRef.current) previousFrameRef.current = new Uint8ClampedArray(current);
      if (!persistentFrameRef.current) persistentFrameRef.current = new Uint8ClampedArray(current);
      const previous = previousFrameRef.current;
      const persistent = persistentFrameRef.current;
      if (lcdMode === "blend") {
        for (let i = 0; i < current.length; i += 4) {
          persistent[i] = (current[i] + previous[i]) >> 1;
          persistent[i + 1] = (current[i + 1] + previous[i + 1]) >> 1;
          persistent[i + 2] = (current[i + 2] + previous[i + 2]) >> 1;
          persistent[i + 3] = 255;
        }
      } else {
        const base = ghostStrength / 100;
        for (let i = 0; i < current.length; i += 4) {
          for (let channel = 0; channel < 3; channel += 1) {
            const oldValue = persistent[i + channel];
            const newValue = current[i + channel];
            const response = newValue < oldValue ? base : base * 0.72;
            persistent[i + channel] = Math.round(oldValue * response + newValue * (1 - response));
          }
          persistent[i + 3] = 255;
        }
      }
      previous.set(current);
      output = persistent;
    }
    context.putImageData(new ImageData(new Uint8ClampedArray(output), GAMEBOY_WIDTH, GAMEBOY_HEIGHT), 0, 0);
  }, [lcdMode, ghostStrength]);

  const loadFile = useCallback(async (file) => {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".gb") && !lower.endsWith(".gbc")) {
      setMessage("That is not a .gb or .gbc cartridge image.");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const key = `${file.name}:${bytes.length}:${hashBytes(bytes)}`;
      let battery = null;
      try {
        const saved = localStorage.getItem(`gbc-lab-save:${key}`);
        if (saved) battery = base64ToBytes(saved);
      } catch {
        battery = null;
      }
      saveBattery();
      const emulator = new GameBoy(model);
      if (bootRomsRef.current[model]) emulator.setBootROM(bootRomsRef.current[model]);
      const header = emulator.loadROM(bytes, battery);
      emulatorRef.current = emulator;
      romRef.current = bytes;
      romKeyRef.current = key;
      previousFrameRef.current = null;
      persistentFrameRef.current = null;
      setInfo(header);
      if ((!header.logoValid || !header.checksumValid) && !emulator.bootEnabled) {
        setStatus("Header check failed");
        runningRef.current = false;
        setRunning(false);
        setMessage("Hardware lockout: cartridge logo or header checksum is invalid.");
        return;
      }
      startAudio();
      nativeBootRef.current = emulator.bootEnabled;
      bootRef.current = emulator.bootEnabled
        ? { active: false, start: 0 }
        : { active: true, start: Date.now() };
      setBooting(true);
      runningRef.current = true;
      pausedRef.current = false;
      setRunning(true);
      setPaused(false);
      setStatus(emulator.bootEnabled ? `${model.toUpperCase()} BIOS running` : `${model.toUpperCase()} fallback startup`);
      setMessage(
        emulator.bootEnabled
          ? "Executing your local boot ROM. It remains on this device."
          : battery
            ? "Battery-backed save restored from this browser."
            : "Cartridge verified. Running locally in your browser.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to read this cartridge.");
      setStatus("Load error");
      setRunning(false);
    }
  }, [model, saveBattery, startAudio]);

  const switchModel = useCallback((nextModel) => {
    if (nextModel === model) return;
    saveBattery();
    setModelState(nextModel);
    modelRef.current = nextModel;
    setStatus(romRef.current ? "Restarting core" : "Awaiting cartridge");
    setMessage(nextModel === "cgb"
      ? "CGB hardware selected. Color-capable cartridges use native color mode."
      : "DMG hardware selected. CGB-only cartridges are blocked like original hardware.");
    const emulator = new GameBoy(nextModel);
    if (bootRomsRef.current[nextModel]) emulator.setBootROM(bootRomsRef.current[nextModel]);
    emulatorRef.current = emulator;
    previousFrameRef.current = null;
    persistentFrameRef.current = null;
    if (romRef.current) {
      let battery = null;
      try {
        const saved = localStorage.getItem(`gbc-lab-save:${romKeyRef.current}`);
        if (saved) battery = base64ToBytes(saved);
      } catch {
        battery = null;
      }
      const header = emulator.loadROM(romRef.current, battery);
      setInfo(header);
      nativeBootRef.current = emulator.bootEnabled;
      bootRef.current = emulator.bootEnabled
        ? { active: false, start: 0 }
        : { active: true, start: Date.now() };
      setBooting(true);
      runningRef.current = true;
      pausedRef.current = false;
      setRunning(true);
      setPaused(false);
    }
  }, [model, saveBattery]);

  const reset = useCallback(() => {
    if (!romRef.current) return;
    saveBattery();
    emulatorRef.current.reset();
    previousFrameRef.current = null;
    persistentFrameRef.current = null;
    nativeBootRef.current = emulatorRef.current.bootEnabled;
    bootRef.current = emulatorRef.current.bootEnabled
      ? { active: false, start: 0 }
      : { active: true, start: Date.now() };
    setBooting(true);
    pausedRef.current = false;
    setPaused(false);
    setStatus(`${model.toUpperCase()} cold boot`);
  }, [model, saveBattery]);

  const loadBootFile = useCallback(async (file) => {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const verifier = new GameBoy(model);
      verifier.setBootROM(bytes);
      bootRomsRef.current[model] = bytes;
      setBootInfo((current) => ({ ...current, [model]: bytes.length }));
      setMessage(`${model.toUpperCase()} boot ROM loaded locally (${bytes.length.toLocaleString()} bytes).`);
      if (romRef.current) {
        const emulator = emulatorRef.current;
        emulator.setBootROM(bytes);
        emulator.reset();
        previousFrameRef.current = null;
        persistentFrameRef.current = null;
        nativeBootRef.current = true;
        bootRef.current = { active: false, start: 0 };
        runningRef.current = true;
        pausedRef.current = false;
        setRunning(true);
        setPaused(false);
        setBooting(true);
        setStatus(`${model.toUpperCase()} BIOS running`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to read that boot ROM.");
    }
  }, [model]);

  const clearBootRom = useCallback(() => {
    bootRomsRef.current[model] = null;
    setBootInfo((current) => ({ ...current, [model]: 0 }));
    const emulator = emulatorRef.current;
    emulator.setBootROM(null);
    if (romRef.current) {
      emulator.reset();
      nativeBootRef.current = false;
      bootRef.current = { active: true, start: Date.now() };
      setBooting(true);
      setRunning(true);
      runningRef.current = true;
    }
    setMessage(`${model.toUpperCase()} boot ROM removed. The documented fallback startup is active.`);
  }, [model]);

  const setButtonVisual = useCallback((button, pressed) => {
    setPressedButtons((current) => {
      const next = new Set(current);
      if (pressed) next.add(button);
      else next.delete(button);
      return next;
    });
  }, []);

  const pressButton = useCallback((button, pressed) => {
    if (pressed) startAudio();
    emulatorRef.current.setButton(button, pressed);
    setButtonVisual(button, pressed);
  }, [setButtonVisual, startAudio]);

  useEffect(() => {
    const draw = () => {
      if (runningRef.current) return;
      const context = canvasRef.current?.getContext("2d", { alpha: false });
      if (context) drawWaitingScreen(context, model);
    };
    draw();
    const animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [model]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(localStorage.getItem("gbc-lab-preferences") || "{}");
        if (saved.theme === "dark" || saved.theme === "light") setTheme(saved.theme);
        if (saved.viewMode === "console" || saved.viewMode === "screen") setViewMode(saved.viewMode);
        if (typeof saved.keyboardMotion === "boolean") setKeyboardMotion(saved.keyboardMotion);
        if (typeof saved.muted === "boolean") setMuted(saved.muted);
        if (Number.isFinite(saved.volume)) setVolume(Math.max(0, Math.min(100, saved.volume)));
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
    document.documentElement.dataset.theme = theme;
    if (!preferencesReady) return;
    try {
      localStorage.setItem("gbc-lab-preferences", JSON.stringify({
        theme, viewMode, keyboardMotion, muted, volume, keyBindings,
      }));
    } catch {
      // Preferences are optional.
    }
  }, [theme, viewMode, keyboardMotion, muted, volume, keyBindings, bindingTarget, preferencesReady]);

  useEffect(() => {
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
      const button = BINDING_ORDER.find((name) => keyBindingsRef.current[name] === event.code);
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      startAudio();
      emulatorRef.current.setButton(button, true);
      if (keyboardMotion) setButtonVisual(button, true);
    };
    const up = (event) => {
      const button = BINDING_ORDER.find((name) => keyBindingsRef.current[name] === event.code);
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      window.setTimeout(() => emulatorRef.current.setButton(button, false), 45);
      window.setTimeout(() => setButtonVisual(button, false), 115);
    };
    const blur = () => {
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
    };
  }, [keyboardMotion, setButtonVisual, startAudio]);

  useEffect(() => {
    const resize = () => {
      if (viewMode === "screen") {
        setConsoleScale(1);
        return;
      }
      const mobile = window.innerWidth <= 620;
      const reservedWidth = drawerOpen && window.innerWidth >= 1150 ? 570 : 0;
      const availableWidth = window.innerWidth - reservedWidth - (mobile ? 24 : 56);
      const availableHeight = window.innerHeight - (mobile ? 82 : 106);
      const next = Math.min(1.14, availableWidth / 397, availableHeight / 652);
      setConsoleScale(Math.max(0.64, next));
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [drawerOpen, viewMode]);

  useEffect(() => {
    runningRef.current = running;
    pausedRef.current = paused;
    modelRef.current = model;
    titleRef.current = info.title;
    presentFrameRef.current = presentFrame;
  }, [running, paused, model, info.title, presentFrame]);

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
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d", { alpha: false });
      const wallTime = Date.now();
      if (!context) {
        ownAnimation = requestAnimationFrame(frame);
        animationRef.current = ownAnimation;
        return;
      }

      if (bootRef.current.active) {
        const progress = (wallTime - bootRef.current.start) / 1850;
        drawBootScreen(context, modelRef.current, Math.min(1, progress), titleRef.current);
        if (progress >= 1) {
          bootRef.current.active = false;
          setBooting(false);
          setStatus(`${modelRef.current.toUpperCase()} · running`);
          lastAnimationRef.current = wallTime;
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

      if (!lastAnimationRef.current) lastAnimationRef.current = wallTime;
      const delta = Math.min(50, wallTime - lastAnimationRef.current);
      lastAnimationRef.current = wallTime;
      frameAccumulatorRef.current += delta;
      const frameDuration = 1000 / 59.7275;
      let frames = 0;
      while (frameAccumulatorRef.current >= frameDuration && frames < 3) {
        emulator.runFrame();
        frameAccumulatorRef.current -= frameDuration;
        frames += 1;
        fpsRef.current.frames += 1;
      }
      if (frames) {
        if (presentFrameRef.current) presentFrameRef.current();
        if (nativeBootRef.current && !emulator.bootEnabled) {
          nativeBootRef.current = false;
          setBooting(false);
          setStatus(`${modelRef.current.toUpperCase()} · running`);
        }
        const audio = emulator.drainAudio();
        if (audio.length) {
          const audioOutput = audioRef.current;
          const queue = audioOutput.queue;
          for (let i = 0; i < audio.length; i += 1) queue.push(audio[i]);
          const unread = queue.length - audioOutput.readIndex;
          if (unread > 96000) {
            audioOutput.queue = queue.slice(queue.length - 48000);
            audioOutput.readIndex = 0;
          }
        }
      }
      if (!fpsRef.current.start) fpsRef.current.start = wallTime;
      if (wallTime - fpsRef.current.start >= 500) {
        const seconds = (wallTime - fpsRef.current.start) / 1000;
        const debug = emulator.getDebugState();
        setDiagnostics({
          fps: (fpsRef.current.frames / seconds).toFixed(1),
          frame: debug.frame,
          pc: debug.pc.toString(16).padStart(4, "0").toUpperCase(),
          ly: debug.ly,
          ppu: debug.mode,
          runs: debug.runFrameCalls,
          audioBuffered: Math.max(0, audioRef.current.queue.length - audioRef.current.readIndex),
          audioPeak: audioRef.current.maxPeak,
        });
        fpsRef.current = { start: wallTime, frames: 0 };
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
  }, []);

  useEffect(() => {
    const save = () => saveBattery();
    window.addEventListener("beforeunload", save);
    const timer = window.setInterval(save, 10000);
    return () => {
      window.removeEventListener("beforeunload", save);
      window.clearInterval(timer);
    };
  }, [saveBattery]);

  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
    if (!paused && audioRef.current.context) {
      audioRef.current.context.resume().then(() => setAudioState("ON")).catch(() => setAudioState("LOCKED"));
    }
  }, [paused, volume, muted]);

  return (
    <main
      className={`app-shell theme-${theme} ${viewMode === "screen" ? "screen-only" : ""}`}
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
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <div>
            <strong>GB/C LAB</strong>
            <span>HARDWARE RESPONSE CORE</span>
          </div>
        </div>
        <div className="system-status">
          <span className={`status-light ${running && !paused ? "live" : ""}`} />
          <span>{paused ? "PAUSED" : status.toUpperCase()}</span>
          <button
            className="options-trigger"
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-controls="options-drawer"
          >
            OPTIONS
          </button>
        </div>
      </header>

      <section className="workspace">
        <div
          className={`console-wrap ${dragging ? "is-dragging" : ""}`}
          style={{
            "--console-scale": consoleScale,
            "--console-height": `${652 * consoleScale}px`,
            "--console-width": `${397 * consoleScale}px`,
          }}
        >
          <div className={`handheld ${model}`}>
            <div className="handheld-top">
              <span>DOT MATRIX</span>
              <span>STEREO</span>
            </div>
            <div className={`display-bezel ${lcdMode !== "sharp" ? "lcd-grid" : ""}`}>
              <div className="power-label">
                <i className={running ? "on" : ""} />
                BATTERY
              </div>
              <div className="screen-frame">
                <canvas
                  ref={canvasRef}
                  width={GAMEBOY_WIDTH}
                  height={GAMEBOY_HEIGHT}
                  aria-label={`${model.toUpperCase()} emulation display`}
                />
                <span className="screen-glass" aria-hidden="true" />
                {booting && (
                  <span className="boot-tag">
                    {bootInfo[model] ? "EXTERNAL BIOS" : "DOCUMENTED STARTUP"}
                  </span>
                )}
              </div>
              <div className="screen-caption">
                <strong>GAME BOY</strong>
                <em>{model === "cgb" ? "COLOR" : "DMG-01"}</em>
              </div>
            </div>

            <div className="hardware-controls" aria-label="Game Boy controls">
              <div className="dpad" aria-label="Directional pad">
                <ControlButton className="dpad-up" label="▲" sublabel="Up" button="up" onPress={pressButton} pressed={pressedButtons.has("up")} />
                <ControlButton className="dpad-left" label="◀" sublabel="Left" button="left" onPress={pressButton} pressed={pressedButtons.has("left")} />
                <span className="dpad-center" aria-hidden="true" />
                <ControlButton className="dpad-right" label="▶" sublabel="Right" button="right" onPress={pressButton} pressed={pressedButtons.has("right")} />
                <ControlButton className="dpad-down" label="▼" sublabel="Down" button="down" onPress={pressButton} pressed={pressedButtons.has("down")} />
              </div>
              <div className="action-buttons">
                <ControlButton className="button-b" label="B" button="b" onPress={pressButton} pressed={pressedButtons.has("b")} />
                <ControlButton className="button-a" label="A" button="a" onPress={pressButton} pressed={pressedButtons.has("a")} />
              </div>
              <div className="meta-buttons">
                <ControlButton label="" sublabel="Select" button="select" onPress={pressButton} pressed={pressedButtons.has("select")} />
                <ControlButton label="" sublabel="Start" button="start" onPress={pressButton} pressed={pressedButtons.has("start")} />
              </div>
              <div className="speaker" aria-hidden="true">
                <i /><i /><i /><i /><i />
              </div>
            </div>
          </div>
          {dragging && <div className="drop-overlay">DROP CARTRIDGE TO LOAD</div>}
        </div>

        <aside
          id="options-drawer"
          className={`control-deck ${drawerOpen ? "open" : ""}`}
          aria-hidden={!drawerOpen}
          inert={!drawerOpen}
        >
          <div className="drawer-heading">
            <div>
              <span>GB/C LAB</span>
              <h2>Options</h2>
            </div>
            <button onClick={() => setDrawerOpen(false)} aria-label="Close options">CLOSE ×</button>
          </div>

          <section className="deck-section bootrom-section">
            <div className="section-heading">
              <span>00</span>
              <div>
                <h2>Boot ROM</h2>
                <p>Optional local BIOS · never uploaded</p>
              </div>
            </div>
            <div className="bootrom-row">
              <button className="secondary-load" onClick={() => bootFileRef.current?.click()} data-testid="load-boot-rom">
                LOAD {model.toUpperCase()} BIOS
              </button>
              {bootInfo[model] > 0 && <button className="clear-button" onClick={clearBootRom}>REMOVE</button>}
            </div>
            <input
              ref={bootFileRef}
              className="visually-hidden"
              type="file"
              accept=".bin,.rom,.boot,application/octet-stream"
              onChange={(event) => loadBootFile(event.target.files?.[0])}
              aria-label={`Choose a ${model.toUpperCase()} boot ROM`}
            />
            <div className="bios-status">
              <span>DMG <b>{bootInfo.dmg ? `${bootInfo.dmg} B · READY` : "FALLBACK"}</b></span>
              <span>CGB <b>{bootInfo.cgb ? `${bootInfo.cgb} B · READY` : "FALLBACK"}</b></span>
            </div>
          </section>

          <section className="deck-section cartridge-section">
            <div className="section-heading">
              <span>01</span>
              <div>
                <h2>Cartridge</h2>
                <p>Runs entirely on this device</p>
              </div>
            </div>
            <button
              className="load-button"
              onClick={() => {
                startAudio();
                fileRef.current?.click();
              }}
              data-testid="load-rom"
            >
              <span>LOAD ROM</span>
              <kbd>.GB / .GBC</kbd>
            </button>
            <input
              ref={fileRef}
              className="visually-hidden"
              type="file"
              accept=".gb,.gbc,application/octet-stream"
              onChange={(event) => loadFile(event.target.files?.[0])}
              aria-label="Choose a Game Boy ROM"
            />
            <p className="message-line">{message}</p>
            <dl className="cartridge-grid">
              <div className="cart-title"><dt>Title</dt><dd>{info.title}</dd></div>
              <div><dt>Mapper</dt><dd>{info.mapper}</dd></div>
              <div><dt>ROM</dt><dd>{formatBytes(info.romSize)}</dd></div>
              <div><dt>RAM</dt><dd>{formatBytes(info.ramSize)}</dd></div>
              <div><dt>Header</dt><dd className={info === EMPTY_INFO ? "" : info.checksumValid ? "pass" : "fail"}>{info === EMPTY_INFO ? "—" : info.checksumValid ? "PASS" : "FAIL"}</dd></div>
              <div><dt>Target</dt><dd>{info.cgb ? "CGB" : info === EMPTY_INFO ? "—" : "DMG"}</dd></div>
            </dl>
          </section>

          <section className="deck-section">
            <div className="section-heading">
              <span>02</span>
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
                <b>CGB</b><small>1998</small>
              </button>
            </div>
            <div className="transport">
              <button
                onClick={() => setPaused((value) => {
                  pausedRef.current = !value;
                  return !value;
                })}
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
              <span>03</span>
              <div>
                <h2>Presentation</h2>
                <p>Console shell, screen focus, and theme</p>
              </div>
            </div>
            <div className="option-stack">
              <div>
                <span className="option-label">View</span>
                <div className="segmented two-way" aria-label="Presentation mode">
                  <button className={viewMode === "console" ? "active" : ""} onClick={() => setViewMode("console")} aria-pressed={viewMode === "console"}>Console</button>
                  <button className={viewMode === "screen" ? "active" : ""} onClick={() => setViewMode("screen")} aria-pressed={viewMode === "screen"}>Screen only</button>
                </div>
              </div>
              <div>
                <span className="option-label">Theme</span>
                <div className="segmented two-way" aria-label="Color theme">
                  <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")} aria-pressed={theme === "light"}>Light</button>
                  <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")} aria-pressed={theme === "dark"}>Dark</button>
                </div>
              </div>
            </div>
          </section>

          <section className="deck-section">
            <div className="section-heading">
              <span>04</span>
              <div>
                <h2>LCD response</h2>
                <p>Persistence restores flicker transparency</p>
              </div>
            </div>
            <div className="segmented lcd-options" aria-label="LCD processing mode">
              {[
                ["sharp", "Sharp"],
                ["blend", "Blend"],
                ["response", "LCD"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={lcdMode === value ? "active" : ""}
                  onClick={() => {
                    setLcdMode(value);
                    previousFrameRef.current = null;
                    persistentFrameRef.current = null;
                  }}
                  aria-pressed={lcdMode === value}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="range-control">
              <span><b>Ghosting</b><output>{ghostStrength}%</output></span>
              <input
                type="range"
                min="8"
                max="72"
                value={ghostStrength}
                disabled={lcdMode !== "response"}
                onChange={(event) => setGhostStrength(Number(event.target.value))}
                aria-label="LCD ghosting strength"
              />
            </label>
          </section>

          <section className="deck-section">
            <div className="section-heading">
              <span>05</span>
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
              <span>06</span>
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

          <section
            className="diagnostic-strip"
            aria-label="Live emulator diagnostics"
            data-run-calls={diagnostics.runs}
            data-audio-state={audioState}
            data-audio-buffered={diagnostics.audioBuffered}
            data-audio-peak={diagnostics.audioPeak.toFixed(4)}
          >
            <div><span>FPS</span><b>{diagnostics.fps}</b></div>
            <div><span>FRAME</span><b>{diagnostics.frame}</b></div>
            <div><span>PC</span><b>{diagnostics.pc}</b></div>
            <div><span>LY</span><b>{diagnostics.ly}</b></div>
            <div><span>PPU</span><b>M{diagnostics.ppu}</b></div>
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
        {drawerOpen && (
          <button
            className="drawer-backdrop"
            aria-label="Close options"
            onClick={() => setDrawerOpen(false)}
          />
        )}
      </section>
    </main>
  );
}
