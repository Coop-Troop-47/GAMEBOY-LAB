# GAMEBOY LAB v2.1.0 Emulation Audit

This audit compares the v2.1.0 candidate with the tagged v2.0.0 core. It keeps
measured results separate from ambition: a finite collection of ROMs cannot
prove equivalence to every Game Boy silicon revision, cartridge peripheral,
browser, or audio device.

## Measured results

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

v2.1.0 is materially more accurate than v2.0.0 and exceptionally fast for a
from-scratch JavaScript core, but the evidence does **not** establish “the most
accurate browser emulator in the world.” The largest measured gap is PPU
behavior: 86.6361% Mealybug structural similarity and 1/24 pixel-exact cases.
SameSuite APU at 47/70 also leaves 23 revision-sensitive or unimplemented cases.

High-value remaining work includes a true fetcher/FIFO PPU verified per model,
APU revision profiles, broader OAM-corruption and DMA-bus validation, additional
cartridge hardware (MBC6, MBC7 sensors, Camera, HuC-1/HuC-3), deterministic
link-cable transport, and browser/device input-to-photon and audio-latency
measurement. Efficiency work should then be profiled around those exact models,
potentially including a Worker/SharedArrayBuffer path where cross-origin
isolation is available and a transferable-buffer fallback where it is not.
