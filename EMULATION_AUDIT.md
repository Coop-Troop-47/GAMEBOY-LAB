# GAMEBOY LAB v2.5.2 Emulation Audit

This audit starts with the v2.5.2 DMG raster-timing patch. The user-facing
notes in `release/v2.5.2.md` describe the practical result without internal emulator
terminology; this document keeps the measurement detail and release gates for
maintainers.

## v2.5.2 delta

### DMG live palette handoff and short-line completion

The DMG live-transfer path now preserves the additional in-flight fetch phase
seen when BGP is written during mode 3. The adjustment is limited to the
DMG-only register path and does not change the fixed line clock or the CGB
fetcher. If a dynamic transfer reaches HBlank before its visible x counter has
reached 160, the remaining pixels are emitted through the same live renderer
instead of retaining bytes from the preceding row. The state is already part
of the existing save-state transfer snapshot, so mid-line saves remain
deterministic.

In games, this is visible in raster colour bars, palette-based fades, status
panel wipes, and split-screen effects: the colour transition is less likely to
start a few pixels late, and a short line cannot flash a stale strip from the
previous scanline.

| Test group | v2.5.1 | v2.5.2 | Change |
| --- | ---: | ---: | ---: |
| Project tests | 58/58 | 59/59 | +1 focused live-transfer regression |
| Mealybug DMG picture match | 92.9402% | 94.1665% | **+1.2263 pp / +1.32% relative** |
| SameSuite full set | 55/78, 0 timeouts | 55/78, 0 timeouts | held |

The paired six-cartridge benchmark used 120 warm-up frames, 600 measured
frames, and three fresh-process trials per cartridge. Available host
throughput was **+1.65% at the median** (individual results +1.12% to
+3.08%), while all six frame/CPU checksums remained identical to v2.5.1:
`d65b3bb2`, `ac84ed26`, `bade4d3c`, `e272a94f`, `329a0a7c`, and `2c200251`.

This patch is intentionally not described as full hardware equivalence. The
remaining Mealybug mismatches and revision-specific SameSuite cases stay in
the v3.0 gate.

## v2.5.1 delta

### Allocation-free sprite compositing loop

The renderer now indexes the already-selected scanline sprite pool directly
instead of creating an iterator for each sprite pass. This is a host-side
optimization only: sprite order, transparency, priority, palette selection,
and every emulated clock remain unchanged.

The paired benchmark used 120 warm-up frames and 600 measured frames in three
fresh-process trials per cartridge. Available core throughput improved for all
six representative cartridges, while the checksums stayed identical:

| Cartridge/model | v2.5.0 median | v2.5.1 median | Relative change |
| --- | ---: | ---: | ---: |
| Super Mario Land, DMG | 1,048.32 fps | 1,072.34 fps | **+2.29%** |
| Link's Awakening DX, CGB | 704.56 fps | 724.41 fps | **+2.82%** |
| Pokémon Blue, DMG | 1,486.02 fps | 1,522.26 fps | **+2.44%** |
| Wario Land 3, CGB | 735.79 fps | 750.79 fps | **+2.04%** |
| Shantae, CGB | 696.00 fps | 706.38 fps | **+1.49%** |
| Pokémon Crystal, CGB | 844.48 fps | 859.63 fps | **+1.79%** |

The six-game median gain is **+2.17%**. These are available host frames, not
gameplay speed: the emulated clock remains fixed at the Game Boy cadence. The
frame/CPU checksums were `d65b3bb2`, `ac84ed26`, `bade4d3c`, `e272a94f`,
`329a0a7c`, and `2c200251` in both runs.

| Test group | v2.5.0 | v2.5.1 | Change |
| --- | ---: | ---: | ---: |
| Project tests | 58/58 | 58/58 | held |
| Mealybug DMG structural frame match | 92.9402% | 92.9402% | held |
| SameSuite CGB APU | 49/70 | 49/70 | held |
| SameSuite APU timeouts | 0 | 0 | held |

This is intentionally a host-side performance patch. No timing behavior was
changed, and the larger revision-aware accuracy work remains gated for v3.0.

The v2.5.0 audio timing change remains separate from the earlier
performance releases. The user-facing notes in `release/v2.5.0.md` explain the
same result without emulator-internal terminology; this document records the
test method and the remaining limits for maintainers.

## v2.5.0 delta

### CGB envelope divider timing

The CGB APU has a primary divider edge used by the frame sequencer and a
secondary edge that arms the volume envelope counter. The core now tracks that
secondary phase for the two pulse channels, including the CGB write-glitch,
counter-lock, and save-state phase. The established DMG envelope path remains
unchanged. Period-one CGB envelopes retain the existing compatibility path
because that path is still the best match for the current mixed-revision test
set; this is intentionally not presented as universal CGB-revision emulation.

In a game, this is the timing behind short note fades, volume changes while a
channel is already playing, and divider-triggered retriggers. The audio sample
rate, fixed CPU clock, mixer, and final cartridge checksums are unchanged.

| Test group | v2.4.0 | v2.5.0 | Change |
| --- | ---: | ---: | ---: |
| Project tests | 58/58 | 58/58 | held |
| Mealybug DMG structural frame match | 92.9402% | 92.9402% | held |
| SameSuite CGB APU | 47/70 | 49/70 | **+2 cases / +2.86 pp / +4.26% relative** |
| SameSuite APU timeouts | 0 | 0 | held |

The two additional passing cases are the generic CGB NRx2 envelope-glitch
checks for channels 1 and 2. The remaining failures are left visible in the
test report rather than being hidden behind a broad model claim. The external
suite includes revision-specific tests that need separate hardware-model
selection before they can be safely folded into a larger release.

## v2.5.0 verification commands

```text
npm test
npm run lint
npm run test:mealybug -- --roms <extracted-roms> --expected <DMG-blob> --model dmg --quiet
node scripts/core-conformance.mjs --suite samesuite <apu-roms> --model cgb --quiet
```

The final standalone build and six-game checksum smoke tests remain required
release gates. The next major release is deliberately held until the broader
PPU/APU work improves coverage while preserving the measured browser headroom.

The historical v2.4.0 section below compares that candidate with the tagged v2.3.0 core and keeps
the older v2.3.0, v2.2.2, v2.2.1, v2.2.0, and v2.1.0 results below as historical
release baselines. It keeps
measured results separate from ambition: a finite collection of ROMs cannot
prove equivalence to every Game Boy silicon revision, cartridge peripheral,
browser, or audio device.

## v2.4.0 delta

### Practical cartridge-fetch headroom

The CPU reads cartridge ROM continuously, while the mapper only changes its
visible banks occasionally. The core now keeps the two active ROM-bank offsets
ready and refreshes them only when a mapper write, reset, or save-state restore
can change them. This removes repeated bank-selection work from ordinary
opcode and data fetches without changing the bytes returned by any mapper.

In games, the extra headroom is most useful in scenes that combine scrolling
maps, sprite work, audio, and an LCD shader: Super Mario Land, Pokémon, Link's
Awakening, Wario Land 3, Shantae, and Pokémon Crystal all completed with the
same final checksums while leaving more CPU time for presentation and audio
delivery. It does **not** make the emulated machine run faster than its fixed
hardware clock.

Five fresh-process trials used 120 warm-up frames and 600 measured frames per
cartridge. Median available throughput improved for every tested game:

| Cartridge/model | v2.3.0 median | v2.4.0 median | Relative change |
| --- | ---: | ---: | ---: |
| Super Mario Land, DMG | 1,103.13 fps | 1,124.98 fps | **+1.98%** |
| Link's Awakening, DMG | 1,241.52 fps | 1,289.85 fps | **+3.89%** |
| Pokémon Blue, DMG | 1,587.72 fps | 1,638.45 fps | **+3.20%** |
| Wario Land 3, CGB | 771.14 fps | 795.14 fps | **+3.11%** |
| Shantae, CGB | 743.71 fps | 758.15 fps | **+1.94%** |
| Pokémon Crystal, CGB | 881.01 fps | 915.34 fps | **+3.90%** |

That is a **+3.16% median gain across the six-game set**. The framebuffer and
CPU checksums matched the v2.3.0 run for all six cartridges.

### Accuracy and safety gates

| Test group | v2.3.0 | v2.4.0 | Change |
| --- | ---: | ---: | ---: |
| Project tests | 58/58 | 58/58 | held |
| Mealybug DMG structural frame match | 92.9402% | 92.9402% | held |
| SameSuite APU | 47/70 | 47/70 | held; no timeouts |
| Six-game checksums | matched | matched | held |

An attempted CGB envelope-timing change was rejected because it did not move
the SameSuite result and would have expanded the regression surface. The
larger revision-aware PPU/APU work remains deliberately reserved for v3.0.0;
this release claims a measured performance improvement, not full hardware
equivalence.

## v2.3.0 delta

### Practical DMG window timing

The DMG now has a small, dot-timed pixel-fetch path for the difficult left-edge
window cases where WX is changed during a scanline. It follows the hardware's
discarded pixels, tile fetch order, window restart, and one-dot DMG horizontal
desynchronisation instead of deciding the whole line from a single x-coordinate.
In games, this reduces stale tiles, misplaced window starts, and one-pixel seams
in raster wipes, status panels, score bars, and split-screen effects. The path is
deliberately limited to the tested DMG edge cases; normal lines and the CGB core
remain on their established fast path until the revision differences are fully
covered.

The external Mealybug DMG-blob suite improved from **88.7153% to 92.9402%**
structural frame agreement: **+4.2249 percentage points (+4.76% relative)**.
The three WX edge cases moved as follows:

| Case | v2.2.2 | v2.3.0 | Change |
| --- | ---: | ---: | ---: |
| WX = 4 | 56.6623% | 99.0061% | +74.70% relative |
| WX = 5 | 61.9358% | 97.2309% | +56.98% relative |
| WX = 6 | 49.1797% | 72.9384% | +48.31% relative |

These figures describe reference-frame agreement, not a change to the fixed
59.7275 Hz hardware cadence. The CGB path is intentionally unchanged by this
DMG-only experiment.

### Regression and performance gates

| Test group | v2.2.2 | v2.3.0 | Change |
| --- | ---: | ---: | ---: |
| Project tests | 57/57 | 58/58 | +1 FIFO save-state test |
| SameSuite APU | 47/70 | 47/70 | held; no timeouts |
| Super Mario Land checksum | matched | matched | held |
| Six-game median throughput | baseline | +1.6% | checksum matched |

The six-game measurement used five fresh processes, 120 warm-up frames, and
600 measured frames. The modest throughput increase is available headroom, not
an emulation-speed change; game timing stays cycle-locked.

The next major v3.0.0 release remains reserved for a broader revision-aware PPU
fetcher and the outstanding audio edge cases. This release intentionally does
not claim full hardware equivalence.

## v2.2.2 delta

### Practical CGB rendering throughput

Native CGB and CGB-compatible rendering now keeps a write-coherent packed
palette cache: eight background and eight object palettes, four packed colours
per palette. The cache is refreshed at the same point palette RAM accepts a
write, while mode-3 access blocking and indexed auto-increment remain intact.
Both the ordinary whole-line renderer and the live renderer used after
mid-scanline writes consume the cache. In games, this reduces repeated RGB555
byte assembly and colour-LUT work in colour-heavy battle effects, scrolling
playfields, text/status panels, and sprite-rich scenes. The resulting CPU
headroom is available to the LCD shader, audio queue, input, and browser UI;
the emulated machine still runs at its fixed hardware cadence.

Five fresh-process trials used 120 warm-up frames and 600 measured frames per
cartridge. Framebuffer/CPU checksums matched v2.2.1 in every paired run:

| Cartridge/model | v2.2.1 median | v2.2.2 median | Change |
| --- | ---: | ---: | ---: |
| Super Mario Land, DMG | 1,034.57 fps | 1,055.22 fps | +2.00% |
| Link's Awakening, DMG | 1,133.54 fps | 1,180.28 fps | +4.12% |
| Pokémon Blue, DMG | 1,494.00 fps | 1,538.71 fps | +2.99% |
| Wario Land 3, GBC | 715.53 fps | 730.24 fps | +2.06% |
| Shantae, GBC | 688.37 fps | 710.97 fps | +3.28% |
| Pokémon Crystal, GBC | 819.26 fps | 854.28 fps | +4.27% |

### Accuracy and regression gates

| Test group | v2.2.1 | v2.2.2 | Change |
| --- | ---: | ---: | ---: |
| Mealybug Tearoom structural image match | 88.7153% | 88.7153% | held |
| SameSuite APU | 47/70 | 47/70 | held |
| Project core/unit suite | 37/37 | 38/38 | +1 cache-coherence test |

The release deliberately does not include two tempting WX timing shortcuts:
both reduced the complete Mealybug score in isolated experiments. The next
accuracy target remains a revision-aware PPU FIFO/fetcher, followed by the 23
remaining SameSuite APU cases.

## v2.2.1 delta

### Practical rendering throughput

The DMG background and sprite paths now index the prebuilt packed-colour table
directly. This removes a helper dispatch for every rendered DMG pixel while
leaving the palette register mapping, framebuffer bytes, CPU timing, and CGB
path unchanged. In games, the saved processing time is most useful on
scrolling tile layers, text-heavy HUDs, and sprite-rich scenes: it leaves more
main-thread headroom for LCD shader work, audio delivery, input, and UI
compositing without changing the 59.7275 Hz machine cadence.

The paired benchmark used five fresh Node processes per cartridge, 120 warm-up
frames, and 600 measured frames. Checksums matched v2.2.0 in every case:

| Cartridge/model | v2.2.0 median | v2.2.1 median | Change |
| --- | ---: | ---: | ---: |
| Super Mario Land, DMG | 960.27 fps | 977.13 fps | +1.76% |
| Link's Awakening, DMG | 1,026.88 fps | 1,103.50 fps | +7.46% |
| Pokémon Blue, DMG | 1,436.81 fps | 1,469.39 fps | +2.27% |
| Wario Land 3, GBC | 703.17 fps | 720.21 fps | +2.42% |
| Shantae, GBC | 682.30 fps | 680.22 fps | −0.30% |
| Pokémon Crystal, GBC | 819.24 fps | 835.35 fps | +1.97% |

The small Shantae decrease is within run variance and is not a CGB rendering
regression; the optimization does not enter its native CGB palette path.

### Accuracy and safety gates

| Test group | v2.2.0 | v2.2.1 | Change |
| --- | ---: | ---: | ---: |
| Mealybug Tearoom structural image match | 88.7153% | 88.7153% | held |
| Mooneye production-model acceptance | 66/66 | 66/66 | held |
| Selected Blargg CPU/APU/memory ROMs | 41/41 | 41/41 | held |
| SameSuite APU | 47/70 | 47/70 | held |
| Project test suite | 56/56 | 56/56 | held |

## v2.2.0 delta

### Accuracy

| Test group | v2.1.0 | v2.2.0 | Absolute gain | Relative gain |
| --- | ---: | ---: | ---: | ---: |
| Mealybug Tearoom structural image match | 86.6361% | 88.7153% | +2.0792 points | +2.40% |
| `m3_lcdc_win_en_change_multiple` | 65.8594% | 83.1944% | +17.3350 points | +26.32% |
| `m3_lcdc_win_en_change_multiple_wx` | 75.412% | 95.4036% | +19.9916 points | +26.51% |
| Mooneye production-model acceptance | 66/66 | 66/66 | held | held |
| Selected Blargg CPU/APU/memory ROMs | 41/41 | 41/41 | held | held |
| SameSuite APU | 47/70 | 47/70 | held | held |

The practical accuracy improvement is concentrated in the LCD fetch phase:
window enable/WX/WY/map changes are resolved at the source-tile boundary, the
window row advances only after a visible window line, and background fetch
latches persist through the fine-scroll discard. Games using status-panel
windows, raster wipes, split-screen playfields, and mid-line scroll changes
therefore receive fewer stale tiles, wrong map halves, and one-pixel seams.

### Fresh-process throughput

The v2.2 benchmark uses five trials of 600 measured frames after 120 warm-up
frames, with each trial in a new `node --expose-gc` process. This removes the
same-process last-cartridge artifact that previously made a long mixed run
unreliable. Median frame throughput changed as follows:

| Cartridge/model | v2.1.0 | v2.2.0 | Change |
| --- | ---: | ---: | ---: |
| Super Mario Land, DMG | 1,035.41 | 1,052.55 | +1.66% |
| Link's Awakening, DMG | 1,128.53 | 1,164.90 | +3.22% |
| Pokémon Blue, DMG | 1,418.51 | 1,481.26 | +4.42% |
| Wario Land 3, GBC | 703.56 | 717.61 | +2.00% |
| Shantae, GBC | 672.46 | 683.24 | +1.60% |
| Pokémon Crystal, GBC | 817.44 | 840.61 | +2.83% |

All six paired checksums matched. These numbers are core headroom, not a new
emulation speed: presentation remains locked to the hardware's approximately
59.7275 Hz cadence. The extra headroom reduces contention with the LCD shader,
AudioWorklet, input, and library animations, lowering the chance of a missed
browser frame on busy scenes.

### State and regression safety

The new `ppuWindowRow`, `ppuWindowLineCursor`, `ppuFetchScx`, `ppuFetchLcdc`,
and `ppuFetchWindowMap` values are serialized with save states. The full unit,
build, and lint gates remain green; Mooneye, Blargg, SameSuite, mapper, RTC,
audio, BIOS, save-state, and standalone checks were re-run after the PPU
change.

## Historical v2.1.0 results (retained for comparison)

### Accuracy

| Test group | v2.0.0 | v2.1.0 | Absolute gain | Relative gain |
| --- | ---: | ---: | ---: | ---: |
| SameSuite APU | 11/70 | 47/70 | +51.43 points | +327.27% passing cases |
| Mealybug Tearoom structural image match | 82.7421% | 86.6361% | +3.8940 points | +4.71% |
| Mooneye production-model acceptance | 66/66 | 66/66 | held | held |
| Mooneye emulator-only | 28/28 | 28/28 | held | held |
| Selected Blargg CPU/APU/memory ROMs | 41/41 | 41/41 | held | held |

The raw Mooneye acceptance result is 66/70. Four ROMs require boot state from
DMG0 or MGB revisions rather than the supplied production DMG, or target a
different CGB revision. They are reported, not silently counted as compatible.
The 66-test denominator is the applicable production-model set.

The selected Blargg total comprises 11 individual CPU-instruction ROMs, 12 DMG
sound ROMs, 12 CGB sound ROMs, and six memory-timing ROMs. Three legitimate
tests complete after 70 million T-cycles, so the runner's bounded default was
raised to 80 million to prevent false timeout reports.

Mealybug uses palette-independent structural image comparison against 24
DMG-blob references. One case is pixel exact; the aggregate percentage exposes
the substantial remaining PPU gap instead of disguising it behind a pass count.

### Throughput

Five alternating-order paired trials were run per cartridge after 120 warm-up
frames, measuring 800 frames per trial with explicit garbage collection. The
figures are available core throughput—not gameplay speed, which remains locked
to the hardware cadence of approximately 59.7275 Hz.

| Cartridge/model | v2.0.0 median | v2.1.0 median | Change |
| --- | ---: | ---: | ---: |
| Super Mario Land, DMG | 1,081.10 fps | 1,109.35 fps | +2.61% |
| Link's Awakening, DMG | 1,110.71 fps | 1,217.93 fps | +9.65% |
| Pokémon Blue, DMG | 1,206.99 fps | 1,584.24 fps | +31.26% |
| Wario Land 3, GBC | 779.44 fps | 701.54 fps | -9.99% |
| Shantae, GBC | 679.94 fps | 705.16 fps | +3.71% |
| Pokémon Crystal, GBC | 917.82 fps | 953.53 fps | +3.89% |

Five of six games improved. Wario Land 3 became slower because its rendering
path exercises the new dot-sensitive work more heavily; the accuracy work was
not removed to manufacture a universal speed claim. Even that case measured
more than 11 times the native frame cadence on the audit machine.

### Host latency and audio delivery

- The previous Low queue target was 768 samples (16 ms at 48 kHz). The new
  Minimal profile targets 384 samples (8 ms): **50% less configured queue
  latency**, for hosts that remain underrun-free.
- Audio clock correction is now limited to ±0.25% instead of the previous
  -0.4%/+0.8% range. The maximum correction fell from 0.8% to 0.25%:
  **68.75% lower peak resampling deviation**.
- Keyboard release no longer waits for the 50 ms physical-button animation.
  This removes **up to 50 ms (100%) of the artificial release delay** while
  retaining the visible press travel.
- The 30-second AudioWorklet cadence simulation completes with zero underruns
  and zero latency trims at the Balanced target.

These are software-path measurements. Browser scheduling, operating-system
mixers, Bluetooth, and the physical output device add latency outside the app.

## Changes found and implemented

### Pixel pipeline and DMA

- Replaced whole-line rendering during timing-sensitive periods with a live,
  dot-sensitive transfer state. Register changes can now split a scanline at
  the point they become observable.
- Added window activation, fine-scroll discard, mode-3 warm-up, sprite-fetch
  stalls, and dynamic transfer completion state that survives save/load.
- Corrected GBC HDMA working registers and cancellation behavior, palette
  auto-increment while mode-3 data access is blocked, and an `EI`→`HALT`
  interrupt edge.
- Added a decoded VRAM tile-row cache updated on writes, direct packed
  framebuffer writes, reusable sprite storage, and allocation-free per-line
  sprite priority tracking.

### APU

- Corrected pulse duty latching, trigger phase, restart suppression, envelope
  period-zero behavior, frame-sequencer edges, and midpoint register sampling.
- Added a latched wave sample and retrigger behavior, plus corrected noise
  startup and restart periods.
- Persisted the new sequencer/channel state in snapshots.
- The host high-pass stage now uses separate documented DMG and GBC capacitor
  curves and converts their per-T-cycle coefficients to the actual host sample
  rate.

### RTC and input

- MBC3 RTC saves now preserve sub-second phase, invalid hardware values roll
  over like the clock counters, and halt/resume does not discard the fractional
  second.
- Emulated button release is immediate; only the decorative shell button keeps
  the minimum press duration.

### Test and benchmark reliability

- SameSuite's Fibonacci-register completion signal is now detected rather than
  misreported as a timeout.
- Model selection respects an explicit DMG/GBC override.
- The benchmark alternates candidate/baseline order on every trial to reduce
  JIT, temperature, and run-order bias.
- Added an automated Mealybug framebuffer/reference runner with
  palette-independent structural comparison.

## Rejected experiments

- Rebuilding both 32-entry GBC packed-palette tables inside each rendered
  range caused Pokémon Crystal to fall to roughly 96 fps. The paired benchmark
  caught the regression and the experiment was removed; the final candidate
  returned to roughly 954 fps in the release matrix.
- Deferring PPU-register visibility by two dots changed Mealybug only from
  86.6361% to 86.6421% while regressing object-size cases. The change was
  rejected rather than tuning globally to one aggregate score.
- The core was not moved wholesale into a Web Worker. That can improve UI
  isolation, but a one-file offline app needs a carefully designed audio,
  input, save, and framebuffer protocol; doing it without browser-level
  latency and determinism evidence would be a risky architectural change.

## Reproduction

The repository includes:

- `scripts/core-conformance.mjs` for Mooneye, Blargg, and SameSuite protocols.
- `scripts/mealybug-conformance.mjs` for DMG-blob structural image comparison.
- `scripts/visual-conformance.mjs` for framebuffer/reference comparisons.
- `scripts/core-benchmark.mjs` for alternating-order tagged-core benchmarks.
- Unit coverage for CPU/APU/PPU/bus/RTC/state edge cases and a 30-second exact
  hardware-cadence AudioWorklet simulation.

The external ROM suites are not distributed in GAMEBOY LAB. The audit used
[Pan Docs](https://gbdev.io/pandocs/),
[Mooneye Test Suite](https://github.com/Gekkio/mooneye-test-suite),
[Blargg test ROMs](https://github.com/retrio/gb-test-roms),
[SameSuite](https://github.com/LIJI32/SameSuite), and
[Mealybug Tearoom Tests](https://github.com/mattcurrie/mealybug-tearoom-tests).

## Distance from the stated goal

v2.2.2 is materially more accurate than v2.1.0 and exceptionally fast for a
from-scratch JavaScript core, but the evidence does **not** establish “the most
accurate browser emulator in the world.” The largest measured gap is still PPU
behavior: 88.7153% Mealybug structural similarity and 1/24 pixel-exact cases.
SameSuite APU at 47/70 also leaves 23 revision-sensitive or unimplemented cases.

High-value remaining work includes a true fetcher/FIFO PPU verified per model,
APU revision profiles, broader OAM-corruption and DMA-bus validation, additional
cartridge hardware (MBC6, MBC7 sensors, Camera, HuC-1/HuC-3), deterministic
link-cable transport, and browser/device input-to-photon and audio-latency
measurement. Efficiency work should then be profiled around those exact models,
potentially including a Worker/SharedArrayBuffer path where cross-origin
isolation is available and a transferable-buffer fallback where it is not.
