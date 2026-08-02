# Reference test adapters

These small programs let the local test harness ask a pinned reference core a
specific question. They never ship in the browser build and they do not alter
GAMEBOY LAB's emulator.

## SameBoy SameSuite adapter

Build `sameboy-conformance-runner.c` against a clean SameBoy v1.0.3 checkout:

```sh
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

The matrix records the selected CGB revision for every ROM. CGB-0 uses
`cgb0_boot.bin`; CGB-A through CGB-D use `cgb_boot.bin`; CGB-E uses an exact
`cgbE_boot.bin` when present or records the documented standard-boot fallback.
Missing or unknown revisions are reported as unsupported or errors, never
silently changed to CGB-E.

SameSuite completion requires both the `P`/`F` result byte and the Fibonacci
register marker at opcode `$40`. A timeout, crash, unknown marker, or
unsupported boot profile cannot become a pass by accident.

## SameBoy Mooneye adapter

`sameboy-mooneye-runner.c` uses the separate Mooneye marker (opcode `$40` plus
the six Fibonacci registers). Build it with the same pinned objects:

```sh
clang -O2 -DGB_INTERNAL -I/path/to/SameBoy/Core \
  scripts/reference/sameboy-mooneye-runner.c \
  /path/to/SameBoy/build/obj/Core/*.o -lm \
  -o /tmp/sameboy-mooneye-runner

node scripts/sameboy-mooneye.mjs \
  --runner /tmp/sameboy-mooneye-runner \
  --suite /path/to/mooneye/acceptance \
  --bios-dir /path/to/Bios \
  --cycles 80000000 --report /tmp/sameboy-mooneye.json
```

The BIOS directory can contain `gb_bios.bin`, `dmg0_rom.bin`, `mgb_boot.bin`,
and `gbc_bios.bin`. The runner records which one was used for each filename
profile, along with its hash.

## Gambatte diagnostic adapter

`gambatte-conformance-runner.cpp` runs the same SameSuite ROM list through a
generic Gambatte CGB. Gambatte-libretro does not expose the individual CGB
silicon revisions or the CPU registers needed by SameSuite's completion
protocol, so the result is intentionally diagnostic. The harness reports
byte-level `P`/`F` observations separately and refuses to call them a strict
accuracy score.

That distinction matters: a reference run is useful only when the ROM bytes,
hardware model, boot image, cycle budget, timeout, and pass detector are all
the same. The release summary keeps those identities beside the score so a
future run can be compared without guessing what changed.
