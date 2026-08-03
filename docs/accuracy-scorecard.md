# Accuracy scorecard

This page explains exactly what GAMEBOY LAB's comparison table means. It is
deliberately conservative: a ROM that runs without a compatible pass marker is
not a failed test, and a native benchmark is not presented as browser speed.

## Release run

The v3.0.3 run was made on 2026-08-03 from these pinned inputs:

- SameSuite commit `f15645fb049a47ea235f6d2c9a033e72d8087901`;
- SameSuite ROM manifest SHA-256
  `589528fa4273246504c38acc2dee8b7d03cdf8180c2c4fb3e2b2286fa8e993fb`;
- the same ROM bytes, model, revision-aware BIOS mapping, 80,000,000
  base-clock cycles, 30-second safety timeout, and pass detector for LAB and
  SameBoy;
- Mooneye acceptance manifest SHA-256
  `fd3e40f337da1e09b41d61282cc83343d0786ff0ab7cd7a93e17461cb6b74a61`;
- nine rotated performance trials, 120 warm-up frames, and 600 measured
  frames for the core-only speed comparison.

## Strict results

| Emulator / adapter | SameSuite CGB | Mooneye acceptance | Mealybug DMG image |
| --- | ---: | ---: | ---: |
| GAMEBOY LAB | 60/76 pass | 70/70 applicable | 1/24 exact; 96.0343% structural average |
| SameBoy 1.0.3 | 65/76 pass | 70/70 applicable | Not scored: no shared frame-boundary adapter |
| Gambatte-libretro | Diagnostic only | Not comparable | Not scored |
| mGBA headless build | Adapter required | Adapter required | Adapter required |
| BGB | Adapter required | Adapter required | Adapter required |
| RetroArch | Core/version required | Core/version required | Core/version required |

For LAB and SameBoy, every SameSuite case finished as a pass or fail: zero
timeouts, crashes, protocol errors, or unsupported cases. Gambatte's diagnostic
run produced 8 apparent passes, 61 apparent fails, and 7 unavailable cases,
but its public interface exposes neither the requested CGB silicon revision nor
the CPU-register marker required for a strict score. Those numbers are useful
for adapter debugging, not for ranking emulators.

Mooneye has five SGB/AGB targets outside the DMG/MGB scope, so they are recorded
as explicitly unsupported rather than put in the denominator. Mealybug compares
the framebuffer at a frame checkpoint; without the same breakpoint and capture
adapter, a result is not comparable.

## Why the matrix includes more emulators than strict scores

All of these projects can execute Game Boy ROMs, but they do not expose the
same test interface:

- [SameBoy](https://github.com/LIJI32/SameBoy) has the model/revision and
  debugger hooks needed for this paired run.
- [Gambatte-libretro](https://github.com/libretro/gambatte-libretro) is exposed
  here through a public libretro adapter. It can produce frames and bytes but
  cannot prove the revision/register protocol.
- [mGBA](https://github.com/mgba-emu/mgba) can be built with a headless frontend,
  but its public runner does not expose the SameSuite marker contract. A future
  adapter can make it strict; the current report does not pretend it already
  has.
- [BGB](https://bgb.bircd.org/index-orig.html) is an excellent Windows-first
  reference with debugger tooling, but this repository has no pinned macOS/Wine
  runner that can capture the same checkpoints.
- [RetroArch](https://www.retroarch.com/) is a frontend, not one emulator. A
  fair result must name the core, core version, BIOS, and configuration.

The rule is simple: **unavailable means the harness could not prove the test,
not that the emulator failed it**.

## Performance, without game-speed theatre

On the release laptop's core-only run, LAB measured 86.9% higher DMG workload
throughput and 48.4% higher CGB workload throughput than SameBoy 1.0.3. A native
Gambatte diagnostic path measured 357.8% higher DMG and 446.1% higher CGB
throughput than LAB, but it did not include browser compositing, WebGL LCD
processing, WebAudio, or the library. The public README therefore reports only
these relative percentages; it does not publish raw host FPS.

The complete per-case records, failure names, boot hashes, and historical
harness corrections remain in [`EMULATION_AUDIT.md`](../EMULATION_AUDIT.md).
