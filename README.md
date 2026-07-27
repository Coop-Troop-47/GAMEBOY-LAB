# GB/C Lab

A browser-based Game Boy and Game Boy Color emulator written from scratch in
JavaScript. No emulator core, WebAssembly binary, boot ROM, or cartridge is
bundled with the app.

## Features

- Complete LR35902 opcode and CB-opcode decoder
- DMG and native CGB hardware modes
- MBC1, MBC2, MBC3/RTC, and MBC5 cartridges
- Scanline PPU with window, sprites, priority, palettes, VRAM/OAM lockouts,
  OAM DMA, and CGB HDMA
- Four-channel stereo audio synthesis
- Hardware-inspired timer edges, interrupt behavior, delayed `EI`, and HALT bug
- Sharp, adjacent-frame transparency blend, and multi-frame LCD response modes
- Remappable keyboard controls with optional physical-button motion
- Pointer and touch controls, volume/mute controls, and light/dark themes
- Console and large screen-only presentation modes
- Browser-local battery-backed saves
- Header/logo lockout checks and model-specific startup animation
- Optional user-supplied DMG and CGB boot ROM support
- A self-contained, offline-capable HTML build at `public/gbc-lab.html`

## Controls

- D-pad: arrow keys
- A: X
- B: Z
- Start: Enter
- Select: Shift

## Development

```bash
npm install
npm run dev
npm test
```

`npm run build:single` regenerates the one-file browser build. ROMs, boot ROMs,
preferences, and battery saves remain local to the browser and are never
uploaded.
