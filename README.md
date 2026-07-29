# GAMEBOY LAB

A browser-based Game Boy and Game Boy Color emulator written from scratch in
JavaScript. No third-party emulator core or WebAssembly binary is used.

## Features

- Complete LR35902 opcode and CB-opcode decoder
- DMG and native GBC hardware modes
- MBC1, MBC2, MBC3/RTC, and MBC5 cartridges; MBC3 clock latch, halt,
  carry/overflow, elapsed-time restoration, and browser persistence are covered
- Scanline PPU with window, sprites, priority, palettes, VRAM/OAM lockouts,
  OAM DMA, and GBC HDMA
- Four-channel stereo audio synthesis with hardware-rate NR43 noise, DIV-driven
  envelopes/length/sweep, and analog-style DC coupling
- Hardware-inspired timer edges, interrupt behavior, delayed `EI`, and HALT bug
- Sharp and hardware-grid LCD modes with independently adjustable ghosting
- Remappable keyboard controls with optional physical-button motion
- Pointer and touch controls, volume/mute controls, and an OS-following theme
- Console and large screen-only presentation modes
- Fractional scaling at 90% by default, with optional whole-device integer scaling
- Clearly separated cartridge `.sav` files and three browser-local snapshot slots
- Browser-local battery RAM/RTC persistence with standard `.sav` import/export
- One-file backups for every cached battery/RTC save and save-state slot, with
  validated, transactional restore and no ROM or preference replacement
- Running-game confirmation before console changes and close-tab protection
- Bounded AudioWorklet output with four buffering profiles, adaptive backlog
  correction, underrun/trim diagnostics, and stereo-safe fallback buffering
- Off, one-frame, two-frame, and automatic presentation frame skipping; the
  emulated CPU, PPU, APU, timers, input, and saves always remain full speed
- Toggleable main-screen technical monitor for emulated/presented/skipped FPS,
  audio queue health, CPU/PPU state, and cartridge/RTC details
- Reusable render buffers, precomputed GBC color conversion, variable PPU mode 3
  timing, DIV-driven APU sequencing, and GBC double-speed clock domains
- Header/logo lockout checks and model-specific startup animation
- Embedded production DMG and GBC startup firmware
- Every `.gb` and `.gbc` cartridge in `SELECT_ROMS/` embedded into the local
  library, with offline Libretro cover artwork, detail cards, and filterable
  tabletop layouts
- Original GBC manual palette choices for monochrome cartridges
- A self-contained, offline-capable HTML build at `public/gbc-lab.html`
- Semantic release versioning and a non-blocking update card that checks a
  public version manifest, then downloads the newest private GitHub release

## Controls

- D-pad: arrow keys
- A: X
- B: Z
- Start: Enter
- Select: Shift

## Development

```bash
npm install
npm run sync:artwork
npm run dev
npm test
```

`npm run sync:artwork` refreshes the local cover-art cache in
`SELECT_ROMS/artwork/` from the matching Libretro Game Boy and Game Boy Color
thumbnail repositories. Normal builds use only those local PNGs and make no
network requests.

`npm run build` regenerates the only distributable,
`public/gbc-lab.html`. The project has no deployment adapter, server runtime,
database, or cloud configuration. Cartridge files, preferences, and battery
saves remain local to the browser and are never uploaded.

## Private releases

The app version lives in `app/version.js` and `package.json`. The matching
update record is `release/update-manifest.json`. For a new release:

1. Increment all three version values.
2. Build and test the one-file app.
3. Publish `public/gbc-lab.html` as the `gbc-lab.html` asset on the matching
   private GitHub release.
4. Update the public manifest Gist with `release/update-manifest.json`.

Only the version number and private release link are public. The repository,
firmware, cartridge data, and downloadable standalone remain private. Update
checks fail silently while offline; downloading a private release requires the
owner to be signed in to GitHub.
