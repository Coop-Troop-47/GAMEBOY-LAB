# GAMEBOY LAB v3.0 Emulation Audit

## Harness correction — comparison held (2026-08-02)

The older **64/76**, **60/76**, and **65/76** labels in the historical notes
are not interchangeable results. The 64/76 reference label and the earlier
60/76 LAB label were produced before the final paired manifest, boot, revision,
and protocol evidence was frozen. They are retained below as history only;
they are not accuracy evidence. The corrected 65/76 reference run is the only
one used for comparison, and it is still **not a release claim** because the
reference documentation and the reproducible reference behaviour disagree.

### Controlled SameSuite inputs

- SameSuite commit: `f15645fb049a47ea235f6d2c9a033e72d8087901` (2025-10-11).
- 76 non-SGB ROMs were measured; two SGB/SGB2 files are explicitly excluded,
  not counted as failures. The sorted ROM manifest is
  `589528fa4273246504c38acc2dee8b7d03cdf8180c2c4fb3e2b2286fa8e993fb`.
- Every case records its ROM byte count and SHA-256, model, requested
  revision, selected revision, the complete revision-family candidate list,
  boot-ROM path/hash, cycle budget, result code,
  and terminal status. Unknown revision suffixes fail closed instead of being
  silently assigned to CGB-E.
- The SameSuite P/F protocol is strict: opcode `0x40`, result byte `P` or `F`,
  and the expected Fibonacci register tuple must agree. Missing or malformed
  output is `protocol-error`, not a fail.
- The current report schema is harness version 8. It adds explicit excluded
  ROM records, measured-versus-unsupported counts, per-case boot evidence,
  wall-clock safety limits for the external adapter, and paired-trial
  improvement statistics. Boot policy is now mandatory on the command line;
  a single embedded BIOS cannot be used for a revision-specific case, and the
  external adapter's JSON result must agree with its process exit code.

### Harness validation patch (2026-08-02)

The matrix was re-run after those gates were made executable. The v8 LAB and
SameBoy reports both contain 76 measured ROMs, the same manifest hash
`589528fa4273246504c38acc2dee8b7d03cdf8180c2c4fb3e2b2286fa8e993fb`, zero
timeouts/crashes/errors/protocol errors, and zero requested/selected revision
mismatches. LAB remains **60/76** and SameBoy remains **65/76**; the numbers
did not move when the harness changed, which is the expected result of a
measurement correction rather than an emulator change. The harness regression
suite now covers implicit boot rejection, unknown suffix handling, and a
reference adapter that lies about its exit status, an adapter that claims the
wrong requested revision, and a truncated boot image. Both final reports
record 2304-byte boot images for every measured case.

The follow-up hardening pass makes a single `--boot-path` or `--boot none` run
explicitly diagnostic: it now exits non-zero and sets `bootPolicyVerified` to
false instead of being eligible for a revision score. An invalid explicit boot
path is rejected before the adapter is launched; it can no longer accidentally
turn into a no-boot run. The adapter must also
report the requested revision it received as well as its actual model and
selected revision. Directory-based CGB boot inputs are now size-checked at
exactly 0x900 bytes; a compact, truncated, missing, or otherwise invalid file
is recorded as unsupported and invalidates the boot-policy gate instead of
being padded or silently replaced. Both runners now enforce the same normalized
DMG base-clock cycle budget; SameBoy's 8 MHz counter is converted at the
adapter boundary. A separate host wall-clock stop is recorded and classified
as `timeout`. `scripts/compare-conformance.mjs`
is the final paired-input gate; it refuses to compare reports unless ROM
manifests, per-case hashes, revision labels, boot hashes and sizes, model, cycle
budget, pass detection, and excluded-case policy all agree. It also validates
report totals, status counts, hashes, selected revisions, boot sizes, and
normalized cycle evidence before doing any arithmetic. This closes the remaining
ways to produce a numerically tidy but unfair 65/76-style comparison.

### Reference callback audit (2026-08-03)

The independent SameBoy adapter had one measurement hazard that was not visible
in its JSON output: its execution-marker callback read `$CFFE` through the
public `GB_read_memory()` API. SameBoy correctly models that API's data-bus and
open-bus decay side effects, so a diagnostic read could in principle perturb
the machine being measured. The callback now reads the already-selected bank-0
WRAM byte directly and the adapter loads the ROM through the same path as
SameBoy's official Tester. The final v1.0.3 run was rebuilt from the clean
tagged source with adapter SHA-256
`6b4dc8e5ca0c6ba2ef9e309a41013ad8551343010db08ed8b798d52511bb4df1` and
remained **65/76**. That unchanged result is useful evidence: the callback
hazard was corrected, but it was not the cause of the documentation mismatch.

The **74/76** figure is not present in the cited SameSuite documentation. The
APU README was last changed at commit `d45b44f` in 2018, when the checked-in
suite contained 60 APU ROMs; its “all but two” statement describes a historical
58/60-era set. The current `f15645f` suite has 76 non-SGB ROMs, including later
revision-specific fixtures, while that README has never been updated to
describe the expanded denominator. On the current 76-ROM manifest, both
SameBoy 1.0.3 and a current SameBoy source build reproduce 65/76 with zero
timeouts, crashes, errors, unsupported cases, or protocol errors. We therefore
do not relabel the observed run as 74/76 or use that number as a ranking claim.

The generic Mooneye runner now also requires an explicit `--embedded-boot`,
`--no-boot`, or `--boot-path` choice. Its controlled acceptance re-run remains
**70/70 applicable cases**, with five explicitly unsupported SGB/AGB targets.
The core benchmark now hashes PCM output and terminal APU state as well as the
framebuffer; a speed result is marked `performanceEligible: false` whenever
the paired output differs, instead of silently presenting it as a pure
optimization.

### Corrected external reference run

SameBoy 1.0.3 was built from the annotated tag commit
`208ba4afabffab9edde416f2dbb8ae459e34adb8` using the independent C adapter in
`scripts/reference/sameboy-conformance-runner.c` (runner SHA-256
`6b4dc8e5ca0c6ba2ef9e309a41013ad8551343010db08ed8b798d52511bb4df1`). The
adapter reads SameBoy's
internal model enum after initialization and reports it; it no longer echoes
the requested label as proof. The matrix therefore verifies
`requestedRevision === selectedRevision` for every measured case.

The boot policy follows [SameBoy's boot-ROM callback documentation](https://github.com/LIJI32/SameBoy/wiki/GB_set_boot_rom_load_callback):
CGB-0 uses `cgb0_boot.bin`, CGB-A through CGB-D use the ordinary CGB image,
and CGB-E uses the ordinary image only as an explicitly recorded fallback.
There is no CGB-0 fallback. The measured boot hashes are
`2c297b6cb762cd0a50253449fd026ae30c76f0cc30b919e2ff498bca7682eacc` for
CGB-0 and
`f767b8e7e510a255f81328c89dba6e0c996b370e1bc86aebb8584a7da47a5bba` for the
ordinary CGB image.

The corrected SameBoy result is **65/76 pass, 11 fail, 0 timeout, 0 crash,
0 error, 0 protocol-error, 0 unsupported**. The 11 failing fixtures are:

```text
apu/channel_1/channel_1_extra_length_clocking-cgb0B.gb
apu/channel_1/channel_1_freq_change_timing-A.gb
apu/channel_1/channel_1_stop_div.gb
apu/channel_1/channel_1_sweep_restart.gb
apu/channel_1/channel_1_sweep.gb
apu/channel_1/channel_1_volume_div.gb
apu/channel_2/channel_2_extra_length_clocking-cgb0B.gb
apu/channel_2/channel_2_stop_div.gb
apu/channel_2/channel_2_volume_div.gb
apu/channel_3/channel_3_extra_length_clocking-cgbB.gb
apu/channel_4/channel_4_extra_length_clocking-cgb0B.gb
```

Revision routing is visible in the report: CGB-0 `1/1`, CGB-C `1/1`, CGB-E
`63/69`, CGB-A `0/1`, and CGB-B `0/4`. The four CGB-B failures are the
revision-specific extra-length fixtures; the CGB-A failure is its frequency
change timing fixture; the six remaining failures are unsuffixed CGB-E APU
fixtures.

The [SameSuite APU documentation](https://github.com/LIJI32/SameSuite/tree/master/apu)
describes CGB-E as passing all but `channel_4_freq_change` and
`channel_1_sweep_restart_2`. In the controlled run those two documented
exceptions pass, while six other CGB-E fixtures fail. The result is
reproducible with the tagged SameBoy source and with a current source build,
but the upstream documentation does not explain the mismatch. This is why the
reference score is recorded as **observed behaviour**, not as a ranking or an
accuracy target. The old 64/76 result is discarded because it cannot be
reconstructed under the corrected revision, boot, and protocol checks. The
available old output has no per-case hashes, selected-revision evidence, or
protocol trace, so it is not possible to assign its one-point difference to a
single cause with confidence; the CGB-0 boot-policy correction is the only
known changed input. That is a provenance failure, not a basis for a score.

The version-8 reports also carry a ROM source snapshot. SameSuite's generated
`.gb` files are intentionally ignored by its repository, so the snapshot
records that limitation and the manifest pins every tested byte. A comparison
is rejected if the source commit is missing, tracked ROMs are dirty, or the
snapshot does not cover the tested and excluded files.
The reference report also records a clean SameBoy source-tree snapshot, so a
runner cannot be attributed to a commit while silently using uncommitted core
files.

The v8 LAB report additionally content-addresses the exact emulator core and
embedded BIOS source files used for the run. This is separate from the suite
snapshot: the suite commit identifies the test-ROM repository, while the core
manifest identifies the working-tree bytes being measured. A dirty LAB tree is
allowed only when those hashes are present; the comparator rejects a report
that merely names a commit without pinning the files.

### LAB and other-suite fairness checks

GAMEBOY LAB was run against the same 76-ROM manifest and reports **60/76**,
with 0 timeout, crash, error, or protocol-error. The final paired run used the
same revision-aware `--boot-dir` mapping as the reference run: identical
manifest hash `589528fa...e993fb`, identical CGB-0 boot hash, and identical
ordinary CGB fallback hash for every other measured revision. The result is
not compared as “better than SameBoy” while the upstream reference mismatch is
open.

The Mooneye acceptance artifact reports 70 applicable DMG cases passing and
five explicitly unsupported SGB/SGB2 files; its source commit was unavailable,
so the report pins its manifest hash rather than pretending to pin a repository
revision. The model naming policy follows the
[Mooneye test-suite conventions](https://github.com/Gekkio/mooneye-test-suite).
The Mealybug run is a visual/structural diagnostic (1/24 pixel-exact and
96.0343% structural average), not a CPU pass-rate substitute.

### Performance rebaseline

The previous **+26.13% DMG / +12.64% CGB** headline is superseded. The final
three-way smoke run used the same two ROM hashes, model selection, post-boot
policy, 120 warm-up frames, 600 measured frames, and nine rotated-order trials
for each backend. Median FPS was:

| Case | GAMEBOY LAB | SameBoy 1.0.3 | Gambatte-libretro |
| --- | ---: | ---: | ---: |
| Tetris (DMG) | 792.70 | 405.94 | 3,628.48 |
| Tetris DX (CGB) | 665.75 | 477.36 | 3,996.78 |

LAB's p10–p90 ranges were `625.15–822.60` FPS (DMG) and `577.73–741.97`
FPS (CGB); per-backend hashes were stable across all nine trials. These are
host-throughput figures, not faster-than-hardware gameplay. The benchmark
covers core execution, PPU framebuffer delivery, and APU generation only; it
excludes DOM, CSS, shaders, WebAudio, and UI work. The older paired percentage
headline is retained in the historical notes below, not used for this release.

No release or “more accurate than SameBoy” claim is permitted until the
SameSuite documentation/fixture discrepancy is resolved or explicitly
documented upstream.

## v3.0 release gate and scope

The v3.0 gate is deliberately broader than a successful build: the project
suite is fully green, the production-model Mooneye set has no timeouts and
passes 70/70 applicable cases, revision-appropriate SameSuite cases remain
stable, the Mealybug structural average improves without trading away exact
cases, and paired game benchmarks retain a clear throughput gain with
identical frame checksums. Four Mooneye ROMs target DMG0/MGB boot firmware that
is not the supplied production DMG BIOS; they remain reported as revision
diagnostics rather than silently counted as production failures. v3.0 is
therefore a production DMG/GBC accuracy milestone, not a claim of equivalence
to every historical silicon revision.

## Post-v3.0.1 startup-audio checkpoint

The production browser mixer now uses one deliberately gentle DC-blocking
curve for the DMG and GBC output paths. The coefficient is converted to the
active host sample rate, so it removes speaker offset and transition clicks
without shaving the quiet end off a boot jingle. Audio produced before the
asynchronous `AudioContext`/`AudioWorklet` hand-off is queued for at most two
seconds, then fed to the selected backend once it exists. The queue is bounded
and is cleared on an intentional audio reset, so a stalled autoplay context
cannot replay an old cartridge after a switch.

The regression evidence for this patch is **81/81** project tests, **70/70**
Mooneye acceptance ROMs with zero timeouts, and a production GBC BIOS-tail
regression that observes the closing note after frame 105. The revision-aware
SameSuite matrix remains **60/76** with zero timeouts. A SameBoy-style delayed
envelope experiment was run against the full matrix and rejected because it
did not improve the complete score; it is not in the shipped path. The
pre-correction revision-labelled SameBoy value of **64/76** is historical and
superseded by the controlled **65/76** reference run documented above. Gambatte
was checked through the available libretro binary for boot and frame delivery;
there is no source-level Gambatte score in this audit. The 600-frame hashes
are recorded in the release note, but are not treated as pixel identity
because the reference frontends used different boot-ROM and colour-correction
policies.

The current working tree contains the v3 engine pass. The audio mixer now
reuses exact finite-state channel levels, skips mixer arithmetic during
provably silent batches, clears a stale partial sample when a channel stops,
keeps channel references local to the APU event loop, and uses a precomputed
NR50 gain/crossbar path. The write-free static background renderer also emits
tile-row spans instead of repeating the same tile lookup for every pixel, and
CPU register-pair reads no longer allocate a temporary array. The ordinary
CPU cartridge-read path now uses the already-derived visible ROM bank bases
after boot and DMA hazards have been ruled out; mapper writes still refresh
those bases and the slow path remains authoritative for boot, DMA, RAM, I/O,
and truncated images. These changes do not alter the emulated clock, audio
sample boundaries, framebuffer bytes, or save-state format.

## Post-v3 accuracy checkpoint (working tree)

The supplied `Bios/dmg0_rom.bin` and `Bios/mgb_boot.bin` are embedded as
internal diagnostic profiles and routed only to the Mooneye ROMs that require
those historical boot images. DMG-0 moved from **0/3 to 3/3**, and the newly
supplied MGB image moves `boot_regs-mgb.gb` to a real pass without changing the
production DMG boot path. The applicable acceptance run is now **70/70
(100%)**, with zero timeouts. No boot ROM picker is exposed in GAMEBOY LAB.

The revision-aware SameSuite matrix now applies the documented pre-CGB-C
extra-length-write quirk only to the internal CGB-0/A/B profiles, including
the CGB-B wave-channel write pipeline. It rises from **56/76 to 60/76
(78.95%)**, a **+5.26 percentage-point / +7.14% relative** gain, with no
production-profile change. In a game this affects very narrow double-speed
sound-length edge cases: square/noise channels no longer cut off one divider
edge early, and CGB-B wave playback remains audible through the exact
two-write handoff instead of ending prematurely. The normal emulator still
selects its production profile automatically.

The maintainer-facing matrix is reproducible with:

```sh
node scripts/samesuite-matrix.mjs --boot-dir /path/to/SameBoy/BootROMs \
  --source-root "$PWD" /path/to/SameSuite --cycles 80000000
```

The broad CGB-E audio timing work is still gated. A direct SameBoy-style
square-start delay improved a handful of PCM traces but regressed more timing
ROMs overall, so it has not been promoted. This is deliberate: a benchmark
headline is only accepted when the complete suite improves, not when one
fixture is made to pass at the expense of several others.

The core accepts an internal `hardwareRevision` profile only for conformance
experiments (`production`, `cgb0`, `cgbA` through `cgbE`). GAMEBOY LAB does not
expose that switch: normal users choose only Game Boy or Game Boy Color, and
the app always uses the production profile. The profile is useful because
some diagnostic ROMs intentionally probe undocumented differences between
historical CGB silicon; requiring users to understand those revisions would
make the normal emulator harder to use without improving ordinary games.

In five fresh-process paired trials (120 warm-up frames, 600 measured frames)
against v2.5.7, the earlier run measured **+26.13% on a DMG Tetris case** and
**+12.64% on a CGB Tetris DX case**. Those values are retained as a
superseded historical measurement; the corrected rebaseline is **+24.28% DMG /
+13.99% CGB** in the harness-correction section above. The frame checksums
stayed `86b18c43` and `f8c0db5f`, respectively. In practical terms,
audio-heavy scenes, scrolling, and busy browser tabs have more headroom before
a visible stutter; emulation speed itself remains fixed at the Game Boy
hardware cadence. The measurements are host-throughput indicators, not
faster-than-hardware gameplay, and are reported as reproducible runs rather
than a promise for every CPU.

### Latest isolated rebaseline (working tree)

A fresh five-trial isolated run of the same 120-warm-up/600-frame pair produced
**605.91 FPS vs 418.92 FPS on DMG (+44.64%)** and **508.22 FPS vs 398.55 FPS
on CGB (+27.52%)**, with unchanged frame checksums (`86b18c43` and
`f8c0db5f`). The host was temporarily noisy (the p10 floor was 322.99/356.71
FPS), so the earlier +23.83%/+14.07% figures remain the conservative release
headline; this run is recorded as an observed upper-side rebaseline rather
than a guaranteed multiplier. Heap deltas were 290.2 KiB (DMG) and 1,380.6
KiB (CGB), compared with 1,852.5 KiB and 557.3 KiB on the v2.5.7 process pair.

A second, hardware-timing correction now hands a DMG SCY write to the live
fetcher at the measured source-tile boundary. The CGB path also keeps the
vertical source row latched at its tile-fetch boundary, including when a GBC
is running a monochrome cartridge, and delays compatibility-mode BGP writes
through the measured in-flight handoff. These are active mode-3 paths only;
the clock cadence and save-state format are unchanged. The DMG-blob average
moved from **95.9639% to
96.0343%** (**+0.0704 percentage points / +0.0734% relative**); the focused
`m3_scy_change` picture moved from **82.9991% to 84.6875%** (**+1.6884 pp /
2.03% relative**). The latest change is limited to the DMG fetch-stage lead
and leaves the other 23 reference pictures unchanged. This is a small but
independently measured edge-case fix from earlier in this working-tree pass,
not a claim that every revision now
matches.

The project suite is **75/75**. SameSuite is **55/78 with 0 timeouts** for the
unchanged production profile, while the revision-aware diagnostic matrix is
**60/76 with 0 timeouts**, and the
DMG-blob run is **1/24 pixel-exact** with the structural average above. The
remaining differences are documented revision-sensitive PPU/APU cases; the
user-facing v3.0 notes describe the production-model result and practical game
effects without implying that a browser core can match every DMG0/MGB/CGB
revision simultaneously. This section is the maintainer-facing record.

The reference runner now also measures high-color CGB screenshots with an exact
assignment fallback instead of refusing them at twelve colors. The current
candidate reaches **91.4527%** structural similarity for CPU CGB-C (31
pictures) and **88.6856%** for CPU CGB-D (24 pictures), up from **89.7014%**
and **86.2961%** in the v2.5.7 baseline. These are revision-specific
diagnostics, not a claim that the default GBC mode emulates every CGB silicon
revision equally.

## v2.5.7 delta

### DMG WX=6 window-fetch row phase

On the DMG FIFO path, a window activation with the line's latched WX value of
6 enters the fetcher at a two-row phase offset from the visible FIFO. The core
now applies a two-row correction only for that DMG edge before seeding the
window tile fetch. WX 0–5 and 7+, the static renderer, and native CGB mode are
unchanged. The existing `ppuWindowRow`/line-cursor state remains serialized for
deterministic mid-line save states.

In games, this fixes patterned windows, score panels, and split-screen overlays
that use WX=6 and previously displayed the right shape with the wrong vertical
tile rows. It does not change ordinary frames or the fixed CPU/PPU clock.

| Test group | v2.5.6 | v2.5.7 | Change |
| --- | ---: | ---: | ---: |
| Project tests | 63/63 | 64/64 | +1 WX=6 FIFO regression |
| Mealybug DMG picture match | 94.9946% | 95.9639% | **+0.9693 pp / +1.02% relative** |
| `m3_wx_6_change` | 74.8698% | 98.1337% | **+23.2639 pp / +31.07% relative** |
| SameSuite full set | 55/78, 0 timeouts | 55/78, 0 timeouts | held |

The other 23 DMG-blob pictures and both DMG CPU-B fixtures hold their prior
scores. Representative DMG/CGB frame and CPU checksums remain stable, and the
paired benchmark shows no throughput regression. This remains a narrow
hardware-edge patch; broader revision-aware PPU/APU work is still gated for
v3.0.

## v2.5.6 delta

### DMG LCDC background-enable pipeline

The DMG LCDC background-enable bit now has an explicit 16-pixel in-flight
pipeline latch when written during mode 3. The write still updates the
register immediately for CPU-visible reads, but the pixel renderer keeps the
previous background state for the measured fetch interval before applying the
new state. This is DMG-only; native CGB rendering continues to use its existing
fetch path. The three latch values are serialized so a mid-line save state
resumes at the same visible phase.

In games, this affects raster wipes, HUD/status panels, split-screen effects,
and other scenes that toggle the background layer while the LCD is drawing. It
does not change the fixed CPU/PPU clock or the ordinary write-free fast path.

| Test group | v2.5.5 | v2.5.6 | Change |
| --- | ---: | ---: | ---: |
| Project tests | 62/62 | 63/63 | +1 LCDC pipeline regression |
| Mealybug DMG picture match | 94.9047% | 94.9946% | **+0.0899 pp / +0.09% relative** |
| `m3_lcdc_bg_en_change` | 88.3420% | 90.4991% | **+2.1571 pp / +2.44% relative** |
| SameSuite full set | 55/78, 0 timeouts | 55/78, 0 timeouts | held |

The remaining 23 Mealybug pictures are unchanged. Representative DMG and CGB
frame/CPU checksums remain stable, and the paired short benchmark showed no
throughput regression. This is intentionally a narrow accuracy patch; the
revision-aware PPU/APU work remains gated for v3.0.

## v2.5.5 delta

### Eight-bit window line counter

The PPU window line counter is now kept in its hardware-sized 8-bit range at
line setup, each window activation, and the final line commit. The active
fetcher and the static renderer use the wrapped value, and the wrapped phase
is already included in save-state transfer data. This prevents a long-running
window sequence from indexing beyond the 32-row tile map after repeated
mid-line enable/disable events.

In games, this fixes long HUD overlays, patterned windows, and repeated
split-screen scenes that otherwise begin to drift after enough window rows.
The DMG/CGB CPU clocks, ordinary write-free renderer, and native CGB path are
otherwise unchanged.

| Test group | v2.5.4 | v2.5.5 | Change |
| --- | ---: | ---: | ---: |
| Project tests | 61/61 | 62/62 | +1 window-wrap regression |
| Mealybug DMG picture match | 94.7014% | 94.9047% | **+0.2033 pp / +0.21% relative** |
| `m3_lcdc_win_en_change_multiple` | 85.2778% | 90.1563% | **+4.8785 pp / +5.72% relative** |
| SameSuite full set | 55/78, 0 timeouts | 55/78, 0 timeouts | held |

The remaining 23 Mealybug pictures are unchanged, and representative game
frame/CPU checksums remain identical. No host-throughput headline is claimed
because this is a correctness fix, not a hot-loop rewrite. Revision-specific
PPU/APU work remains gated for v3.0.

## v2.5.4 delta

### DMG mid-line vertical-scroll handoff

The DMG live transfer path now keeps a two-pixel fetch handoff when SCY is
written during mode 3. The visible row selection changes after that measured
handoff instead of switching at the JavaScript write boundary. The delay is
DMG-only, does not change the fixed line clock, and is serialized with the
existing transfer state so a mid-line save resumes deterministically.

In games, this is visible in split-screen scrolling, raster wipes, and status
panels that change vertical position while the LCD is already drawing. The
usual write-free renderer and native CGB path are untouched.

| Test group | v2.5.3 | v2.5.4 | Change |
| --- | ---: | ---: | ---: |
| Project tests | 60/60 | 61/61 | +1 focused SCY handoff regression |
| Mealybug DMG picture match | 94.6823% | 94.7014% | **+0.0191 pp / +0.02% relative** |
| `m3_scy_change` | 82.5391% | 82.9991% | **+0.4600 pp / +0.56% relative** |
| SameSuite full set | 55/78, 0 timeouts | 55/78, 0 timeouts | held |

The remaining 23 Mealybug pictures are unchanged, and the six-game frame/CPU
checksums remain identical. No host-throughput headline is claimed for this
patch because ordinary write-free lines stay on the same optimized path. The
revision-specific PPU/APU work remains gated for v3.0.

This audit starts with the v2.5.3 DMG raster-timing patch. The user-facing
notes in `release/v2.5.3.md` describe the practical result without internal emulator
terminology; this document keeps the measurement detail and release gates for
maintainers.

## v2.5.3 delta

### DMG palette handoff interval

The DMG live-transfer path now keeps the old palette mapping visible for the
measured six-dot in-flight interval after a mode-3 BGP write. This is limited to
the DMG palette register and does not change line length, CPU timing, or the
native CGB renderer. In games, the practical effect is cleaner raster wipes,
status panels, split-screen bars, and scene transitions that change colours
while a scanline is already being drawn.

| Test group | v2.5.2 | v2.5.3 | Change |
| --- | ---: | ---: | ---: |
| Project tests | 59/59 | 60/60 | +1 focused handoff regression |
| Mealybug DMG picture match | 94.1665% | 94.6823% | **+0.5158 pp / +0.55% relative** |
| SameSuite full set | 55/78, 0 timeouts | 55/78, 0 timeouts | held |

The two palette-change cases rose by 6.1719 and 6.2066 percentage points
(6.83% and 7.05% relative); every other reference case held its v2.5.2 score.
Six representative game checksums remained identical. No host-performance
headline is claimed for this patch because ordinary write-free lines stay on
the same fast path; the measured change is visual accuracy only.

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
node scripts/core-conformance.mjs --suite mooneye --embedded-boot <acceptance-roms> --quiet
node scripts/samesuite-matrix.mjs --boot-dir <boot-rom-dir> <apu-roms> --quiet
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
- The production host high-pass stage uses a deliberately gentle curve and
  converts its per-T-cycle coefficient to the actual host sample rate. This
  removes offset and transition clicks without truncating quiet note tails;
  revision-specific CGB envelope experiments remain scoped to diagnostic
  profiles rather than changing normal app playback.

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
- A DMG window-resume phase offset was tested against the repeated WIN_EN
  fixture and rejected: it lowered that case from 90.1563% to 82.5000% and
  lowered the complete DMG-blob average from 95.9639% to 95.6449%.

## Reproduction

The repository includes:

- `scripts/core-conformance.mjs` for Mooneye and Blargg protocols, and
  `scripts/samesuite-matrix.mjs` for revision-aware SameSuite protocols.
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

v2.5.7 is materially more accurate than v2.1.0 and the current performance
candidate is exceptionally fast for a from-scratch JavaScript core, but the
evidence does **not** establish “the most accurate browser emulator in the
world.” The largest measured gap is still revision-sensitive PPU behavior:
95.9639% Mealybug structural similarity and 1/24 pixel-exact cases. SameSuite
is 55/78 with no timeouts; the remaining failures are largely revision-specific
CGB APU/SGB fixtures rather than a single universal CGB behavior.

High-value remaining work includes a true fetcher/FIFO PPU verified per model,
APU revision profiles, broader OAM-corruption and DMA-bus validation, additional
cartridge hardware (MBC6, MBC7 sensors, Camera, HuC-1/HuC-3), deterministic
link-cable transport, and browser/device input-to-photon and audio-latency
measurement. Efficiency work should then be profiled around those exact models,
potentially including a Worker/SharedArrayBuffer path where cross-origin
isolation is available and a transferable-buffer fallback where it is not.
