# GAMEBOY LAB v2.0.0 Emulation Audit

This audit separates measured behavior from aspiration. The figures below are
repeatable comparisons against the tagged v1.3.0 core. They do not claim that
passing a finite test suite proves equivalence to every revision of real
hardware.

## Measured results

### Accuracy and compatibility

| Test group | v1.3.0 | v2.0.0 | Absolute gain | Relative gain |
| --- | ---: | ---: | ---: | ---: |
| Mooneye production-model acceptance | 33/66 | 66/66 | +50 percentage points | +100% passing tests |
| Mooneye emulator-only | 14/28 | 28/28 | +50 percentage points | +100% passing tests |
| Mooneye PPU acceptance | — | 12/12 | — | — |
| Blargg APU selector | — | 26/26 | — | — |
| Blargg CPU/instruction selector | — | 22/22 | — | — |
| dmg-acid2 reference image | — | 100%, 0 mismatched pixels | — | — |
| cgb-acid2 reference image | — | 100%, 0 mismatched pixels | — | — |

The production-model denominator excludes four boot-state ROMs written for
different silicon or firmware than the legally supplied production DMG and CGB
ABCDE boot ROMs: DMG0, MGB, and CGB0-specific cases. Counting those incompatible
boot-revision tests anyway gives a raw v2.0.0 Mooneye acceptance result of 66/70,
compared with 33/70 in v1.3.0.

The Blargg CPU total includes the visual-only `interrupt_time` ROM, whose
on-screen “Passed” result was inspected because it does not expose the normal
serial or cartridge-RAM automation protocol.

### Throughput

Seven trials were run per cartridge after 400 warm-up frames, measuring 1,000
frames per trial under Node with explicit garbage collection between trials.

| Cartridge/model | v1.3.0 median | v2.0.0 median | Improvement |
| --- | ---: | ---: | ---: |
| Tetris, DMG | 825.99 frames/s | 1,100.66 frames/s | +33.25% |
| Tetris DX, GBC | 893.99 frames/s | 1,053.37 frames/s | +17.83% |

These are core-throughput figures, not the emulated refresh rate: gameplay
continues to target the hardware cadence of approximately 59.7275 Hz. Browser,
display, shader, and device results vary by machine.

## Systems audited and changed

- **CPU and interrupts:** M-cycle reads, writes, internal cycles, interrupt
  cancellation/reprioritisation, delayed `EI`, HALT behavior, illegal-opcode
  lockup, stack/IDU interactions, and STOP/speed-switch timing.
- **Timers and serial:** divider falling-edge behavior, TIMA overflow/reload
  windows, DIV/TAC glitches, free-running serial phase, internal fast CGB
  clocks, externally clocked transfers, and endpoint hooks.
- **Bus, DMA, and CGB registers:** CPU-visible DMA bus conflicts, startup and
  restart timing, DMG OAM corruption patterns, GDMA/HDMA stalls, palette/VRAM
  access windows, infrared register behavior, and undocumented CGB registers.
- **PPU:** event-driven mode progression, LCD startup phase, line 153 LY
  behavior, STAT edge/quirk handling, dynamic sprite penalties, priority, and
  framebuffer cadence.
- **Cartridges and RTC:** MBC1 multicart wiring, MBC2 nibble RAM and banking,
  MBC3 RTC-only/invalid selections, MBC5 rumble-bank masking, ROM/RAM bank
  behavior, elapsed-time RTC restoration, and backward-compatible snapshots.
- **APU:** hardware channel timers, length/envelope/sweep edge cases, trigger
  ordering, DAC enable behavior, wave RAM access, noise LFSR timing, NR52 power
  behavior, and zero-order-hold sample-window integration.
- **Browser audio:** sample-rate-derived analog coupling, bounded queueing,
  interpolated clock correction, startup/restart ramps, queue-health
  diagnostics, and a fixed 512-frame fallback callback that no longer exceeds
  the Low/Balanced/Stable startup targets.
- **Scheduling:** event batching across quiet CPU, PPU, and APU intervals,
  exact base-clock frame accounting while the LCD is disabled, bounded host
  catch-up, and presentation-only frame skipping.

## Reproduction

The repository includes:

- `scripts/core-conformance.mjs` for Mooneye and Blargg protocol tests, including
  comparisons to a tagged core.
- `scripts/visual-conformance.mjs` for framebuffer/reference comparisons.
- `scripts/core-benchmark.mjs` for repeatable tagged-core throughput comparison.
- Unit tests for the CPU/APU/PPU/bus/state edge cases and a 30-second exact
  hardware-cadence AudioWorklet simulation.

The external ROM suites are not distributed in GAMEBOY LAB. The audit used:
[Pan Docs](https://gbdev.io/pandocs/),
[Mooneye Test Suite](https://github.com/Gekkio/mooneye-test-suite),
[Blargg test ROMs](https://github.com/retrio/gb-test-roms),
[SameBoy](https://github.com/LIJI32/SameBoy),
[dmg-acid2](https://github.com/mattcurrie/dmg-acid2), and
[cgb-acid2](https://github.com/mattcurrie/cgb-acid2).

## Deliberate boundaries

The release does not advertise untested hardware revisions or unsupported
special cartridges. MBC6, MBC7 sensors, the Game Boy Camera, HuC-1/HuC-3, and
network transport for the serial/infrared endpoints remain outside the exposed
feature set. The PPU remains an event-driven scanline renderer rather than a
full dot FIFO. Replacing it wholesale after the complete applicable timing and
Acid2 passes would have introduced disproportionate regression risk without a
test-backed benefit.

Those boundaries are explicit because “most accurate” cannot be established by
marketing language. v2.0.0 instead ships the strongest measured GAMEBOY LAB core
to date, with reproducible evidence and no fabricated percentage claims.
