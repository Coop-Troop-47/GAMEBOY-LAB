# GAMEBOY LAB

A browser-based Game Boy and Game Boy Color emulator written from scratch in
JavaScript. No third-party emulator core or WebAssembly binary is used.

## Features

- Complete LR35902 opcode and CB-opcode decoder
- DMG and native GBC hardware modes
- MBC1, MBC2, MBC3/RTC, and MBC5 cartridges; MBC3 clock latch, halt,
  carry/overflow, elapsed-time restoration, and browser persistence are covered
- Event-driven, dot-sensitive PPU transfer pipeline with mid-line register
  effects, dynamic window and sprite stalls, priority, palettes, VRAM/OAM bus
  lockouts, timed OAM DMA, and GBC HDMA
- Four-channel stereo audio synthesis with hardware-rate channel timers,
  DIV-driven envelopes/length/sweep, exact sample-window integration, and
  sample-rate-correct analog-style DC coupling
- M-cycle CPU bus behavior, timer reload/glitch timing, interrupt cancellation,
  delayed `EI`, HALT bug, STOP, and GBC double-speed switching
- Sharp and hardware-grid LCD modes with independently adjustable ghosting
- Remappable keyboard controls with optional physical-button motion
- Pointer and touch controls, volume/mute controls, and an OS-following theme
- Console and large screen-only presentation modes
- Fractional scaling at 90% by default, with optional whole-device integer scaling
- Clearly separated cartridge `.sav` files and three browser-local snapshot slots
- Library cards show battery-save support, stored-save status, and all three
  save-state slots without opening the save drawer
- Browser-local battery RAM/RTC persistence with standard `.sav` import/export
- One-file backups for every cached battery/RTC save and save-state slot, with
  validated, transactional restore and no ROM or preference replacement
- Running-game confirmation before console changes and close-tab protection
- Bounded AudioWorklet output with five buffering profiles, adaptive backlog
  correction through interpolated resampling, soft underrun recovery,
  underrun/trim diagnostics, and stereo-safe fallback buffering
- Off, one-frame, two-frame, and automatic presentation frame skipping; the
  emulated CPU, PPU, APU, timers, input, and saves always remain full speed
- Toggleable main-screen technical monitor for emulated/presented/skipped FPS,
  audio queue health, CPU/PPU state, and cartridge/RTC details
- Batched event-domain execution, reusable render/audio buffers, precomputed
  GBC color conversion, and separate CPU/base-speed clock domains
- Engine-level serial-link and GBC infrared endpoints for external integrations
- Header/logo lockout checks and model-specific startup animation
- Guarded physical cartridge swaps with neutral LCD fade, power-light sequencing,
  and drawer pauses queued to the first safe BIOS frame
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
npm run benchmark:core -- --baseline-ref v1.3.0
```

Core benchmark trials run in fresh Node processes by default, so JIT warm-up,
heap growth, and the previous cartridge cannot bias a later cartridge. Use
`--no-isolate` only for a quick same-process profile; release figures should
use the default isolated mode and report the exact frames, warm-up, and trial
count.

`npm run sync:artwork` refreshes the local cover-art cache in
`SELECT_ROMS/artwork/` from the matching Libretro Game Boy and Game Boy Color
thumbnail repositories. Normal builds use only those local PNGs and make no
network requests.

`npm run build` regenerates the only distributable,
`public/gbc-lab.html`. The project has no deployment adapter, server runtime,
database, or cloud configuration. Cartridge files, preferences, and battery
saves remain local to the browser and are never uploaded.

The external conformance runners in `scripts/` accept locally sourced test-ROM
  directories. See `EMULATION_AUDIT.md` for the v2.5.1 methodology, measured
results, hardware-revision exclusions, and deliberately unclaimed areas.

## Releases

The updater has two separate changelogs:

- **In-app update changelog:** the `changes` array in
  `release/update-manifest.json`. This file is the repository copy of the
  public `update-manifest.json` Gist fetched by `app/version.js`. These are the
  concise changes shown inside GAMEBOY LAB before the user downloads an
  update. The app displays at most six non-empty entries.
- **GitHub release changelog:** the matching file in `release/` is supplied as
  the GitHub release body. This is the longer release page for people viewing
  the repository. GAMEBOY LAB does not read this text, so changing it does not
  update the in-app changelog.

Keep both descriptions accurate, but maintain them independently. For every
release:

1. Increment the version in `app/version.js`, `package.json`, and the two
   top-level package version fields in `package-lock.json`.
2. Update `release/update-manifest.json` with the same version, matching
   release/download URLs, and up to six short user-facing `changes`.
3. Run `npm test`, `npm run lint`, and `git diff --check`. `npm test` rebuilds
   the distributable at `public/gbc-lab.html`.
4. Commit the exact tested state, create the matching annotated version tag,
   and push the branch and tag.
5. Create the GitHub release using the matching detailed notes in `release/`
   as its body, and upload `public/gbc-lab.html` as `gbc-lab.html`.
6. Verify that the uploaded asset is available and matches the local SHA-256.
7. **Last**, copy `release/update-manifest.json` to the public manifest Gist.
   Publishing the Gist earlier can advertise an update before its download is
   ready.
8. Read the Gist back and confirm its version, download URL, notes URL, and
   `changes` exactly match the release.

The manifest Gist ID and fetch URL live in `app/version.js`. The manifest
metadata is public, while the standalone follows the visibility of its GitHub
repository and release. Update checks fail silently while offline; downloading
a private release requires the owner to be signed in to GitHub.
