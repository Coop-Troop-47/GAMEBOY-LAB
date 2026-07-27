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
- Keyboard, pointer, and touch controls
- Browser-local battery-backed saves
- Header/logo lockout checks and model-specific startup animation

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

ROMs remain local to the browser and are never uploaded.
