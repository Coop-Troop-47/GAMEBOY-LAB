# Reference conformance adapter

`sameboy-conformance-runner.c` is a small audit adapter, not a second emulator.
It is compiled against a pinned SameBoy source tree and emits one JSON record per
ROM for `scripts/sameboy-matrix.mjs`.

Example (SameBoy v1.0.3):

```sh
# Build the tester and the standard boot image. CGB-0 is built explicitly
# because some SameBoy make targets do not include it in the aggregate target.
make -C /path/to/SameBoy bootroms tester
make -C /path/to/SameBoy build/bin/BootROMs/cgb0_boot.bin
clang -O2 -DGB_INTERNAL -I/path/to/SameBoy/Core \
  scripts/reference/sameboy-conformance-runner.c \
  /path/to/SameBoy/build/obj/Core/*.o -lm \
  -o /tmp/sameboy-conformance-runner

node scripts/sameboy-matrix.mjs \
  --runner /tmp/sameboy-conformance-runner \
  --source-root /path/to/SameBoy \
  --boot-dir /path/to/SameBoy/build/bin/BootROMs \
  --cycles 80000000 --report /tmp/sameboy-samesuite.json \
  /path/to/SameSuite
```

The matrix has an explicit, fail-closed classification for every ROM.
Unsuffixed SameSuite directories use the documented CPU-CGB-E baseline;
revision-family suffixes select a canonical member of that family
(`cgb0B` → CGB-B, `cgb0BC` → CGB-C, `cgbDE` → CGB-E) because the ROM's
expected result table covers that family. Each report also records every
revision in the family, so the canonical run cannot be mistaken for coverage
of a different chip. CGB-0 uses
`cgb0_boot.bin`; CGB-A through CGB-D use the standard `cgb_boot.bin`; CGB-E may
use that same file only when an exact CGB-E boot ROM is unavailable, and the
fallback is recorded in every case. Missing CGB-0 material is reported as
`unsupported`, never silently substituted.

For a fair LAB/reference comparison, run both matrices with the same
`--boot-dir`, not LAB's default embedded production BIOS. The reports must
have identical `romManifestSha256` and per-case boot hashes before their scores
are compared. `--wall-clock-ms` is an external safety limit; the emulated
cycle budget remains the primary timeout policy.

Completion is accepted only when the ROM has written SameSuite's `P` or `F`
result byte and has reached the documented Fibonacci-register marker. Unknown
markers, runner crashes, timeouts, and unsupported boot profiles remain separate
statuses. The version-8 report stores suite and reference source commits,
source version, runner hash, ROM hashes, boot hashes, requested/selected
revisions, a normalized DMG base-clock cycle budget, wall-clock safety limit,
excluded ROM records, and the per-case evidence needed to reproduce the run.
It also records the source-control state of the ROM snapshot. SameSuite's
generated `.gb` files are ignored by git, so the manifest is the byte-level
pin and the comparator refuses dirty tracked ROMs or incomplete coverage.
The reference report also records a clean SameBoy source-tree snapshot so the
runner cannot be attributed to a commit while using uncommitted core files.

The marker callback reads the `$CFFE` byte directly from bank-0 WRAM. Do not
replace this with `GB_read_memory()`: that public accessor intentionally updates
SameBoy's data-bus/open-bus decay state and would make the observation mutate
the machine under test. The v1.0.3 adapter source hash is recorded in the audit
and should change whenever this measurement boundary changes.

The SameSuite APU README is a historical 2018 note for the then-current 60-ROM
set. It must not be converted into a 74/76 expectation for the current 76-ROM
checkout; the matrix records the current observed result and documents any
disagreement instead of changing the denominator.
