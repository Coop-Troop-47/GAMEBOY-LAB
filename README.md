# GAMEBOY LAB

Open one file. Pick a cartridge. Play.

GAMEBOY LAB is a browser-based Game Boy and Game Boy Color emulator packaged
as a single self-contained HTML file. It is designed to feel like a small,
well-made handheld rather than a developer tool: the library, stylised DMG and
GBC shells, LCD treatments, cartridge animation, sound controls, and saves all
work offline in the browser.

## Accuracy and performance snapshot

The table below is the honest result of the current pinned runs, not a claim
that any finite suite proves perfect hardware emulation. LAB and SameBoy used
the same ROM bytes, revision policy, BIOS mapping, 80-million-cycle limit,
30-second safety timeout, and result detector. Gambatte was run too, but its
public interface cannot expose the CGB revision or the CPU-register marker
required for a strict SameSuite score, so those results are labelled
diagnostic rather than turned into a misleading percentage.

| Test | GAMEBOY LAB | SameBoy 1.0.3 | Gambatte-libretro |
| --- | ---: | ---: | --- |
| SameSuite · 76 non-SGB CGB cases | **60/76** | **65/76** | 8 diagnostic passes · 61 diagnostic fails · 7 unavailable |
| Mooneye acceptance · 70 applicable cases | **70/70** | **70/70** | Not comparable: marker is not exposed |
| Mealybug DMG-blob · 24 image cases | **1/24 exact** · 96.03% average structure match | Not scored: no shared frame-boundary adapter | Not scored: no shared frame-boundary adapter |

The SameSuite checkout currently contains more cases than the historical
SameBoy APU note describes. We report the measured 65/76 result from the
pinned v1.0.3 build instead of changing the denominator to match an older
headline. Failures, timeouts, crashes, protocol errors, and unsupported cases
remain separate in the audit data.

The complete machine-readable summaries are in
[`release/benchmarks/v3.0.3-summary.json`](release/benchmarks/v3.0.3-summary.json).
The method and the individual SameSuite cases are documented in
[`EMULATION_AUDIT.md`](EMULATION_AUDIT.md).

### What the speed result means

On a 2021 MacBook Pro with an Apple M1 Pro, using the same post-boot Tetris
ROMs, nine rotated-order trials, a 120-frame warm-up, and 600 measured frames:

- LAB completed the DMG core workload **86.9% faster than SameBoy** in this
  core-only run.
- LAB completed the CGB core workload **48.4% faster than SameBoy**.
- Gambatte-libretro was ahead of LAB by **357.8% on DMG** and **446.1% on CGB**
  in its native adapter. That is useful context, not a claim of equal
  end-to-end browser performance: the native path does not share LAB's DOM,
  WebGL LCD shader, browser audio, or library work.

Only relative percentages are published here. Raw host throughput stays in
the local benchmark report so the result cannot be mistaken for a game's
fixed 59.7 Hz hardware clock.

## See it in use

![Options and the DMG shell](docs/images/options-overview.png)

![Technical readout and a running GBC game](docs/images/technical-readout.png)

![The tabletop cartridge library](docs/images/library-tabletop.png)

## Start playing

1. Download [`public/gbc-lab.html`](public/gbc-lab.html).
2. Open it in a current desktop browser. No server or installation is needed.
3. Open **Library**, choose a cartridge, and press **Play**.

The included cartridges and BIOS files are for local development and testing.
Use only ROMs and firmware you are legally allowed to use; this project does
not redistribute Nintendo software.

## The parts players notice

- **Two proper presentations.** Switch between a DMG and GBC shell, or let the
  LCD grow into a clean screen-only view. The live frame is carried through
  the transition rather than replaced by a blurry second canvas.
- **LCD choices that behave like displays.** DMG dot-and-gap pixels, a cleaner
  GBC LCD, sharp output, independent ghosting, contrast, palettes, and dark or
  light themes are all separate choices.
- **A library that feels physical.** Add `.gb` and `.gbc` files once, search,
  filter, sort by title/recent use/size, and choose a detail or tabletop view.
  Artwork, cartridge colour, and the cartridge label follow the game into the
  insertion animation.
- **Save data without guesswork.** A cartridge save is the game's battery RAM;
  a save state is an emulator snapshot. They have separate controls and can be
  backed up together from Options.
- **Sound and input controls.** Arrow keys, X, Z, Enter, and Shift work out of
  the box. Remap them, show button depression, mute or adjust volume, and use
  the audio buffering choices when a browser is busy.
- **Useful diagnostics when you want them.** The optional technical readout
  stays on the main screen and shows frame pacing, skipped presentation,
  audio queue health, cartridge size, mapper, battery, and RTC status.

## Controls

| Game Boy control | Default key |
| --- | --- |
| D-pad | Arrow keys |
| A | `X` |
| B | `Z` |
| Start | `Enter` |
| Select | `Shift` |

Arrow keys are captured while the emulator is focused so they do not scroll
the page. Bindings can be changed in **Options → Controls**.

## Saves and backups

Open **Save options** from the cartridge hint above the console.

- A **cartridge save** is progress written by the game to battery-backed RAM.
  Downloading it produces the portable `.sav` data a cartridge would keep.
- A **save state** freezes the whole machine—CPU, video, audio, timers, mapper,
  and cartridge RAM—at one instant. It is not an in-game save.
- **Application data** exports all cached cartridge saves, RTC data, and the
  three save-state slots in one backup. Restoring it asks for confirmation
  before replacing local records.

## Options in plain language

**Options** covers appearance, controls, sound, ghosting, LCD treatment,
scaling, pause-on-menu, library layout, and application backup/restore.

**Emulation settings** covers timing and presentation choices. Integer scaling
keeps source pixels at whole-number sizes; turning it off enables the 90%
manual default and the scale slider. Frame skipping affects only display
uploads, not CPU, timers, PPU, audio, input, or saves. Audio buffering changes
how much browser-side queue is kept to trade latency against resilience to
short scheduling stalls.

## BIOS and legality

The build accepts the legally sourced BIOS profiles placed in the local
`Bios/` directory and embeds the selected profiles in the portable artifact.
The app does not expose a BIOS uploader or ask players to find firmware at
runtime. Do not redistribute Nintendo firmware or game ROMs without the rights
to do so.

## Developer notes

The emulator core and UI are JavaScript, React, CSS, and WebGL. Vite produces
the portable single-file artifact at [`public/gbc-lab.html`](public/gbc-lab.html);
there is no emulator WebAssembly dependency.

```bash
npm install
npm run dev
npm test                   # build plus project tests
npm run lint
npm run benchmark:core
```

The checked-in harnesses record ROM hashes, suite snapshots, BIOS hashes,
model/revision selection, cycle budgets, timeouts, and pass detection. Unknown
CGB suffixes fail closed. The strict SameSuite and Mooneye adapters are pinned
to their reference source; Gambatte's adapter remains diagnostic where its
public API cannot prove the protocol.

The public emulator projects used for context are [SameBoy](https://github.com/LIJI32/SameBoy),
[Gambatte-libretro](https://github.com/libretro/gambatte-libretro),
[SameSuite](https://github.com/LIJI32/SameSuite), and the
[Mooneye test suite](https://github.com/Gekkio/mooneye-test-suite). Their
published pages describe accuracy goals and test behaviour, but do not publish
an apples-to-apples result for this exact laptop and ROM snapshot; the table
above is therefore based on our reproducible local run.

## Maintaining releases

The short player-facing update text and the GitHub release notes are kept
separate on purpose.

1. Put concise, game-facing bullets in
   [`release/update-manifest.json`](release/update-manifest.json). The
   standalone app reads this file when it checks for an update.
2. Put the developer changelog, method, caveats, and test commands in
   `release/vX.Y.Z.md`.
3. Bump `app/version.js`, `package.json`, and the lockfile, then build, test,
   lint, verify the standalone hash, and publish the matching HTML asset.
