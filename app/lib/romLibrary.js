const DATABASE_NAME = "gbc-lab-library";
const DATABASE_VERSION = 1;
const ROM_STORE = "roms";
const ARTWORK_TIMEOUT_MS = 4500;
const MAX_ARTWORK_BYTES = 3_000_000;

function openLibraryDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("This browser does not provide IndexedDB."));
      return;
    }
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error || new Error("Unable to open the ROM library."));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ROM_STORE)) {
        const store = database.createObjectStore(ROM_STORE, { keyPath: "id" });
        store.createIndex("lastPlayedAt", "lastPlayedAt");
        store.createIndex("addedAt", "addedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function runStore(mode, operation) {
  const database = await openLibraryDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(ROM_STORE, mode);
      const store = transaction.objectStore(ROM_STORE);
      let request;
      let result;
      try {
        request = operation(store);
      } catch (error) {
        reject(error);
        return;
      }
      request.onerror = () => reject(request.error || new Error("ROM library operation failed."));
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error("ROM library transaction failed."));
      transaction.onabort = () => reject(transaction.error || new Error("ROM library transaction aborted."));
    });
  } finally {
    database.close();
  }
}

function normalizeStoredRom(record) {
  if (!record) return null;
  const rom = record.rom instanceof ArrayBuffer
    ? record.rom
    : record.rom?.buffer?.slice(
      record.rom.byteOffset,
      record.rom.byteOffset + record.rom.byteLength,
    );
  return { ...record, rom };
}

export async function listLibraryRoms() {
  const records = await runStore("readonly", (store) => store.getAll());
  return records
    .map(normalizeStoredRom)
    .filter((record) => record?.rom)
    .sort((left, right) => (
      (right.lastPlayedAt || right.addedAt || 0)
      - (left.lastPlayedAt || left.addedAt || 0)
    ));
}

export async function getLibraryRom(id) {
  return normalizeStoredRom(await runStore("readonly", (store) => store.get(id)));
}

export async function putLibraryRom(record) {
  const stored = {
    ...record,
    rom: record.rom instanceof ArrayBuffer
      ? record.rom.slice(0)
      : record.rom.buffer.slice(
        record.rom.byteOffset,
        record.rom.byteOffset + record.rom.byteLength,
      ),
  };
  await runStore("readwrite", (store) => store.put(stored));
  return normalizeStoredRom(stored);
}

export async function removeLibraryRom(id) {
  await runStore("readwrite", (store) => store.delete(id));
}

export function readRomTitle(bytes) {
  const colorHeader = (bytes[0x143] & 0x80) !== 0;
  const end = colorHeader ? 0x13f : 0x144;
  return Array.from(bytes.slice(0x134, end))
    .filter((value) => value > 31 && value < 127)
    .map((value) => String.fromCharCode(value))
    .join("")
    .trim() || "UNTITLED";
}

function sourceStem(fileName) {
  return (fileName || "Untitled").replace(/\.(gbc?|zip)$/i, "").trim();
}

function artworkCandidates(fileName, title) {
  const stem = sourceStem(fileName);
  const candidates = [
    stem,
    stem.replace(/\s+\(Rev(?:ision)?\s+\d+\)$/i, ""),
    stem.replace(/\s+\(Rev(?:ision)?\s+\d+\)(?=\s+\()/i, ""),
    `${title} (World)`,
    `${title} (USA, Europe)`,
    `${title} (USA)`,
    title,
  ];
  return [...new Set(candidates.map((value) => value.trim()).filter(Boolean))];
}

function rawArtworkUrl(system, name) {
  const repository = system === "gbc"
    ? "Nintendo_-_Game_Boy_Color"
    : "Nintendo_-_Game_Boy";
  return `https://raw.githubusercontent.com/libretro-thumbnails/${repository}/master/Named_Boxarts/${encodeURIComponent(`${name}.png`)}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new globalThis.FileReader();
    reader.onerror = () => reject(reader.error || new Error("Unable to cache cartridge artwork."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function readArtworkResponse(response, system, signal, aliasDepth = 0) {
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("image/")) {
    const blob = await response.blob();
    if (!blob.size || blob.size > MAX_ARTWORK_BYTES) return null;
    return {
      artwork: await blobToDataUrl(blob),
      artworkSource: "libretro",
    };
  }
  // Libretro uses tiny text aliases for duplicate regional/revision covers.
  if (contentType.startsWith("text/") && aliasDepth < 2) {
    const alias = (await response.text()).trim();
    if (!/^[^/\\]+\.png$/i.test(alias)) return null;
    const aliasResponse = await globalThis.fetch(
      rawArtworkUrl(system, alias.replace(/\.png$/i, "")),
      { signal, cache: "force-cache" },
    );
    return readArtworkResponse(aliasResponse, system, signal, aliasDepth + 1);
  }
  return null;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function splitTitle(value) {
  const words = String(value).replace(/[_-]+/g, " ").trim().split(/\s+/);
  const lines = ["", ""];
  for (const word of words) {
    const target = !lines[0] || (lines[0].length + word.length < 16 && !lines[1]) ? 0 : 1;
    lines[target] = `${lines[target]} ${word}`.trim();
  }
  if (!lines[1] && lines[0].length > 15) {
    lines[1] = lines[0].slice(15);
    lines[0] = lines[0].slice(0, 15);
  }
  return lines.map((line) => xmlEscape(line.slice(0, 22)));
}

export function createFallbackArtwork(title, system, seed = "0") {
  const [lineOne, lineTwo] = splitTitle(title);
  const value = Number.parseInt(String(seed).slice(-6), 16) || 0;
  const accent = ["#42d6d0", "#f05a88", "#c6f050"][value % 3];
  const secondary = ["#f05a88", "#c6f050", "#42d6d0"][(value >> 2) % 3];
  const base = system === "gbc" ? "#24252a" : "#e7e4d9";
  const ink = system === "gbc" ? "#f1f0e9" : "#24272e";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
      <rect width="420" height="420" fill="${base}"/>
      <path d="M0 0H420V76L0 170Z" fill="${accent}"/>
      <path d="M0 108L420 18V124L0 214Z" fill="${secondary}" opacity=".88"/>
      <rect x="28" y="228" width="364" height="136" fill="${ink}"/>
      <text x="210" y="276" text-anchor="middle" fill="${base}" font-family="Arial Black,Arial,sans-serif" font-size="31" font-style="italic" font-weight="900">${lineOne}</text>
      <text x="210" y="316" text-anchor="middle" fill="${base}" font-family="Arial Black,Arial,sans-serif" font-size="31" font-style="italic" font-weight="900">${lineTwo}</text>
      <text x="210" y="347" text-anchor="middle" fill="${accent}" font-family="monospace" font-size="12" font-weight="700" letter-spacing="4">GAMEBOY LAB ARCHIVE</text>
      <g fill="${ink}" opacity=".22">
        <rect x="28" y="28" width="12" height="12"/><rect x="48" y="28" width="12" height="12"/>
        <rect x="68" y="28" width="12" height="12"/><rect x="88" y="28" width="12" height="12"/>
      </g>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function resolveRomArtwork({ fileName, title, system, seed }) {
  const fallback = {
    artwork: createFallbackArtwork(title || sourceStem(fileName), system, seed),
    artworkSource: "generated",
  };
  if (!globalThis.fetch || !globalThis.FileReader) return fallback;

  const controller = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), ARTWORK_TIMEOUT_MS);
  try {
    for (const candidate of artworkCandidates(fileName, title)) {
      try {
        const response = await globalThis.fetch(rawArtworkUrl(system, candidate), {
          signal: controller.signal,
          cache: "force-cache",
        });
        const artwork = await readArtworkResponse(response, system, controller.signal);
        if (artwork) return artwork;
      } catch (error) {
        if (error?.name === "AbortError") break;
      }
    }
    return fallback;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
