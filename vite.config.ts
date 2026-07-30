import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const standaloneRoot = fileURLToPath(new URL("./standalone/", import.meta.url));
const outputRoot = fileURLToPath(new URL("./public/", import.meta.url));
const embeddedRomRoot = fileURLToPath(new URL("./SELECT_ROMS/", import.meta.url));
const embeddedArtworkRoot = join(embeddedRomRoot, "artwork");
const embeddedRomModule = "virtual:gameboy-lab-library";
const resolvedEmbeddedRomModule = `\0${embeddedRomModule}`;

function embeddedHash(bytes: Buffer) {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 257) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function embeddedTitle(bytes: Buffer) {
  const colorHeader = (bytes[0x143] & 0x80) !== 0;
  const end = colorHeader ? 0x13f : 0x144;
  return Array.from(bytes.subarray(0x134, end))
    .filter((value) => value > 31 && value < 127)
    .map((value) => String.fromCharCode(value))
    .join("")
    .trim() || "UNTITLED";
}

function embeddedDisplayTitle(fileName: string) {
  let title = basename(fileName, extname(fileName));
  while (/\s+\([^()]*\)$/.test(title)) {
    title = title.replace(/\s+\([^()]*\)$/, "");
  }
  const invertedArticle = title.match(/^(.*), The - (.*)$/);
  if (invertedArticle) {
    return `The ${invertedArticle[1]}: ${invertedArticle[2]}`;
  }
  title = title.replace(/^Pokemon\b/, "Pokémon");
  return title.replace(" - ", title.startsWith("Pokémon - ") ? " " : ": ");
}

function embeddedMapper(type: number) {
  const names: Record<number, string> = {
    0x00: "ROM",
    0x01: "MBC1",
    0x02: "MBC1 + RAM",
    0x03: "MBC1 + RAM + BATTERY",
    0x05: "MBC2",
    0x06: "MBC2 + BATTERY",
    0x08: "ROM + RAM",
    0x09: "ROM + RAM + BATTERY",
    0x0f: "MBC3 + TIMER + BATTERY",
    0x10: "MBC3 + TIMER + RAM + BATTERY",
    0x11: "MBC3",
    0x12: "MBC3 + RAM",
    0x13: "MBC3 + RAM + BATTERY",
    0x19: "MBC5",
    0x1a: "MBC5 + RAM",
    0x1b: "MBC5 + RAM + BATTERY",
    0x1c: "MBC5 + RUMBLE",
    0x1d: "MBC5 + RUMBLE + RAM",
    0x1e: "MBC5 + RUMBLE + RAM + BATTERY",
  };
  return names[type] || `Unsupported (0x${type.toString(16).padStart(2, "0")})`;
}

function embeddedLibraryRoms() {
  return {
    name: "gameboy-lab-private-library",
    resolveId(id: string) {
      return id === embeddedRomModule ? resolvedEmbeddedRomModule : null;
    },
    load(id: string) {
      if (id !== resolvedEmbeddedRomModule) return null;
      const entries = readdirSync(embeddedRomRoot)
        .filter((fileName) => /\.(gb|gbc)$/i.test(fileName))
        .sort((left, right) => left.localeCompare(right))
        .map((fileName) => {
          const romPath = join(embeddedRomRoot, fileName);
          const stem = basename(fileName, extname(fileName));
          const artworkPath = join(embeddedArtworkRoot, `${stem}.png`);
          const bytes = readFileSync(romPath);
          const artwork = readFileSync(artworkPath);
          this.addWatchFile(romPath);
          this.addWatchFile(artworkPath);
          const hash = embeddedHash(bytes);
          const cgb = (bytes[0x143] & 0x80) !== 0;
          return {
            id: `${bytes.length}:${hash}`,
            fileName,
            title: embeddedDisplayTitle(fileName),
            headerTitle: embeddedTitle(bytes),
            system: cgb ? "gbc" : "gb",
            cgbOnly: bytes[0x143] === 0xc0,
            cartridgeKind: cgb ? "gbc" : "gb",
            mapper: embeddedMapper(bytes[0x147]),
            battery: [0x03, 0x06, 0x09, 0x0f, 0x10, 0x13, 0x1b, 0x1e]
              .includes(bytes[0x147]),
            romSize: bytes.length,
            romBase64: bytes.toString("base64"),
            artwork: `data:image/png;base64,${artwork.toString("base64")}`,
            artworkSource: "libretro",
          };
        });
      if (!entries.length) {
        throw new Error(`No .gb or .gbc cartridges found in ${embeddedRomRoot}`);
      }
      return `export const EMBEDDED_LIBRARY_ROMS = ${JSON.stringify(entries)};`;
    },
  };
}

export default defineConfig({
  root: standaloneRoot,
  plugins: [embeddedLibraryRoms(), react(), viteSingleFile()],
  server: {
    open: "/gbc-lab.html",
  },
  preview: {
    open: "/gbc-lab.html",
  },
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: `${standaloneRoot}gbc-lab.html`,
    },
  },
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
});
