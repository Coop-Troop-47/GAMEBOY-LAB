import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const romRoot = resolve("SELECT_ROMS");
const artworkRoot = join(romRoot, "artwork");
const manualNames = new Map(Object.entries({
  "Legend of Zelda, The - Link's Awakening DX (USA, Europe) (Rev B) (SGB Enhanced) (GB Compatible)":
    "Legend of Zelda, The - Link's Awakening DX (USA, Europe) (Rev 1) (SGB Enhanced) (GB Compatible)",
  "Legend of Zelda, The - Oracle of Ages (USA)":
    "Legend of Zelda, The - Oracle of Ages (USA, Australia)",
  "Legend of Zelda, The - Oracle of Seasons (USA)":
    "Legend of Zelda, The - Oracle of Seasons (USA, Australia)",
  "Pokemon - Crystal Version (USA, Europe) (Rev A)":
    "Pokemon - Crystal Version (USA, Europe) (Rev 1)",
  "Pokemon Pinball (USA) (Rumble Version) (SGB Enhanced) (GB Compatible)":
    "Pokemon Pinball (USA, Australia) (Rumble Version) (SGB Enhanced) (GB Compatible)",
  "Pokemon Trading Card Game (USA) (SGB Enhanced) (GB Compatible)":
    "Pokemon Trading Card Game (USA, Australia) (SGB Enhanced) (GB Compatible)",
  "Rayman 2 - The Great Escape (USA) (En,Fr,De,Es,It)":
    "Rayman 2 (USA) (En,Fr,De,Es,It)",
  "Super Mario Bros. Deluxe (USA, Europe) (Rev B)":
    "Super Mario Bros. Deluxe (USA, Europe) (Rev 1)",
}));

function sourceUrl(system, name) {
  const repository = system === "gbc"
    ? "Nintendo_-_Game_Boy_Color"
    : "Nintendo_-_Game_Boy";
  return `https://raw.githubusercontent.com/libretro-thumbnails/${repository}/master/Named_Boxarts/${encodeURIComponent(`${name}.png`)}`;
}

async function downloadArtwork(system, name, aliasDepth = 0) {
  const response = await globalThis.fetch(sourceUrl(system, name), {
    headers: { "user-agent": "GAMEBOY-LAB-local-artwork-sync" },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const type = response.headers.get("content-type") || "";
  if (type.startsWith("text/") && aliasDepth < 3) {
    const alias = (await response.text()).trim();
    if (!/^[^/\\]+\.png$/i.test(alias)) {
      throw new Error(`Invalid Libretro alias: ${JSON.stringify(alias)}`);
    }
    return downloadArtwork(system, alias.replace(/\.png$/i, ""), aliasDepth + 1);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < pngSignature.length
    || pngSignature.some((value, index) => bytes[index] !== value)
  ) {
    throw new Error(`Expected PNG artwork, received ${type || "unknown content"}`);
  }
  return bytes;
}

const romFiles = (await readdir(romRoot))
  .filter((fileName) => /\.(gb|gbc)$/i.test(fileName))
  .sort((left, right) => left.localeCompare(right));

if (!romFiles.length) {
  throw new Error(`No .gb or .gbc cartridges found in ${romRoot}`);
}

await mkdir(artworkRoot, { recursive: true });
const manifest = [];
for (const fileName of romFiles) {
  const extension = extname(fileName).slice(1).toLowerCase();
  const stem = basename(fileName, extname(fileName));
  const libretroName = manualNames.get(stem) || stem;
  const bytes = await downloadArtwork(extension, libretroName);
  const outputName = `${stem}.png`;
  await writeFile(join(artworkRoot, outputName), bytes);
  manifest.push({
    fileName,
    artwork: `artwork/${outputName}`,
    libretroName,
    repository: extension === "gbc"
      ? "libretro-thumbnails/Nintendo_-_Game_Boy_Color"
      : "libretro-thumbnails/Nintendo_-_Game_Boy",
    bytes: bytes.byteLength,
  });
  globalThis.console.log(`${fileName} -> ${outputName} (${bytes.byteLength} bytes)`);
}

await writeFile(
  join(artworkRoot, "manifest.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), entries: manifest }, null, 2)}\n`,
);
globalThis.console.log(`Stored ${manifest.length} Libretro covers in ${artworkRoot}`);
