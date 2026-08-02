import { basename, extname, relative } from "node:path";

const SUITE_DIRECTORIES = new Set(["apu", "dma", "interrupt", "ppu"]);

export const SAME_SUITE_APU_DOCUMENTATION = {
  url: "https://github.com/LIJI32/SameSuite/blob/master/apu/README.md",
  statement: "SameBoy CGB-E is documented as passing every APU case except channel_4_freq_change and channel_1_sweep_restart_2.",
};

// Return the exact hardware profile and the evidence used to select it.  A
// caller must not replace the final error with a generic CGB profile.
export function classifySameSuiteRom(path, root) {
  const relativePath = relative(root, path).replaceAll("\\", "/");
  const name = basename(path, extname(path)).toLowerCase();
  if (relativePath.toLowerCase().startsWith("sgb/")) {
    return { excluded: true, reason: "SGB tests require an SGB host." };
  }
  // These family suffixes describe the revisions covered by the ROM's own
  // expected-result table.  Pick one representative revision so a matrix has
  // one deterministic case per ROM, and record the family in the rationale.
  if (name.endsWith("-cgb0bc")) {
    return {
      revision: "cgbC",
      revisions: ["cgb0", "cgbB", "cgbC"],
      source: "filename:cgb0BC",
      rationale: "CGB-C and older PCM-glitch family; CGB-C is the canonical representative",
    };
  }
  if (name.endsWith("-cgbde")) {
    return {
      revision: "cgbE",
      revisions: ["cgbD", "cgbE"],
      source: "filename:cgbDE",
      rationale: "CGB-D/E family; CGB-E is the canonical representative",
    };
  }
  if (name.endsWith("-cgb0b")) {
    return {
      revision: "cgbB",
      revisions: ["cgb0", "cgbB"],
      source: "filename:cgb0B",
      rationale: "CGB-B and older revision family; CGB-B is the canonical representative",
    };
  }
  const exactSuffix = ["cgb0", "cgba", "cgbb", "cgbc", "cgbd", "cgbe"]
    .find((suffix) => name.endsWith(`-${suffix}`));
  if (exactSuffix) {
    const revision = exactSuffix === "cgb0" ? "cgb0" : `cgb${exactSuffix.slice(-1).toUpperCase()}`;
    return {
      revision,
      revisions: [revision],
      source: `filename:${exactSuffix}`,
      rationale: "explicit revision suffix",
    };
  }
  if (name.endsWith("-a")) {
    return {
      revision: "cgbA",
      revisions: ["cgbA"],
      source: "filename:A",
      rationale: "explicit CGB-A revision suffix",
    };
  }
  if (/-cgb[0-9a-z]+(?:-|$)/i.test(name) || /-[a-z]$/i.test(name)) {
    throw new Error(`No SameSuite revision policy for ${relativePath}; add an explicit mapping before running.`);
  }
  const rootName = relativePath.split("/")[0].toLowerCase();
  if (SUITE_DIRECTORIES.has(rootName)) {
    return {
      revision: "cgbE",
      revisions: ["cgbE"],
      source: `documented-default:${rootName}`,
      rationale: "SameSuite unsuffixed baseline (CPU-CGB-E)",
    };
  }
  throw new Error(`No SameSuite revision policy for ${relativePath}; add an explicit mapping before running.`);
}

// This is deliberately only an expectation annotation.  It never changes a
// measured result.  A report can therefore distinguish a documented
// exception from a SameBoy failure that needs investigation.
export function documentedSameBoyExpectation(path, root, revision) {
  const relativePath = relative(root, path).replaceAll("\\", "/");
  if (!relativePath.toLowerCase().startsWith("apu/")) return { status: "not-specified", source: null };
  if (revision !== "cgbE") return { status: "not-specified", source: SAME_SUITE_APU_DOCUMENTATION.url };
  const name = basename(path, extname(path)).toLowerCase();
  if (name === "channel_4_freq_change" || name === "channel_1_sweep_restart_2") {
    return { status: "documented-exception", source: SAME_SUITE_APU_DOCUMENTATION.url };
  }
  return { status: "pass", source: SAME_SUITE_APU_DOCUMENTATION.url };
}
