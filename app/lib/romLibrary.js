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

function recordTitle(record) {
  return String(record?.title || record?.fileName || "");
}

function recordSize(record) {
  return Number(record?.romSize || record?.rom?.byteLength || 0);
}

function recordRecency(record) {
  return Number(record?.lastPlayedAt || record?.addedAt || 0);
}

export function sortLibraryRecords(records, mode = "recent", activeId = "") {
  const compareTitle = (left, right) => recordTitle(left).localeCompare(
    recordTitle(right),
    undefined,
    { numeric: true, sensitivity: "base" },
  );
  const compareMode = {
    alphabetic: compareTitle,
    size: (left, right) => (
      recordSize(right) - recordSize(left)
      || compareTitle(left, right)
    ),
    recent: (left, right) => (
      recordRecency(right) - recordRecency(left)
      || compareTitle(left, right)
    ),
  }[mode] || compareTitle;

  return [...records].sort((left, right) => {
    const leftActive = Boolean(activeId) && left.id === activeId;
    const rightActive = Boolean(activeId) && right.id === activeId;
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return compareMode(left, right) || String(left.id).localeCompare(String(right.id));
  });
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

function normalizeTitleLookup(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function cleanDumpTitle(value) {
  return sourceStem(value)
    .replace(/\[[^\]]*]/g, " ")
    .replace(
      /\([^)]*(?:usa|europe|world|japan|australia|france|germany|italy|spain|korea|china|taiwan|\ben\b|\bfr\b|\bde\b|\bes\b|\bit\b|rev(?:ision)?|beta|proto(?:type)?|demo|virtual console|sgb enhanced|gb compatible|game boy compatible|switch online)[^)]*\)/gi,
      " ",
    )
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readableTitle(value) {
  const title = String(value || "").trim();
  if (!title) return "Untitled";
  if (title === title.toUpperCase() || title === title.toLowerCase()) {
    return title
      .toLowerCase()
      .replace(/(^|[\s:–—-])([a-z])/g, (_, lead, letter) => `${lead}${letter.toUpperCase()}`)
      .replace(/\bIi\b/g, "II")
      .replace(/\bIii\b/g, "III")
      .replace(/\bIv\b/g, "IV")
      .replace(/\bDx\b/g, "DX")
      .replace(/\bGbc\b/g, "GBC");
  }
  return title;
}

function titleDistance(left, right) {
  const a = normalizeTitleLookup(left);
  const b = normalizeTitleLookup(right);
  if (!a || !b) return 1;
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    let diagonal = row[0];
    row[0] = aIndex;
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      const previous = row[bIndex];
      row[bIndex] = Math.min(
        row[bIndex] + 1,
        row[bIndex - 1] + 1,
        diagonal + (a[aIndex - 1] === b[bIndex - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[b.length] / Math.max(a.length, b.length);
}

export function identifyRomTitle({ bytes, fileName, knownTitles = [] }) {
  const headerTitle = readRomTitle(bytes);
  const fileTitle = cleanDumpTitle(fileName);
  const fileKey = normalizeTitleLookup(fileTitle);
  const headerKey = normalizeTitleLookup(headerTitle);
  const fileWords = fileTitle.split(/\s+/).filter(Boolean);
  const genericFileName = (
    /^(?:game|rom|untitled|gameboy|gb|gbc)(?:\s+(?:copy|\d+))*$/i.test(fileTitle)
    || /^[a-f0-9]{12,}$/i.test(fileTitle)
  );
  const descriptiveFileName = (
    !genericFileName
    && fileKey.length >= 3
    && (fileWords.length >= 2 || fileKey.length >= 7)
  );
  const candidates = [fileTitle, headerTitle]
    .map((value) => value.trim())
    .filter((value) => value && normalizeTitleLookup(value) !== "untitled");
  const catalogueCandidates = descriptiveFileName ? [fileTitle] : candidates;
  let bestKnown = null;
  let bestDistance = 1;
  for (const knownTitle of knownTitles) {
    for (const candidate of catalogueCandidates) {
      const distance = titleDistance(candidate, knownTitle);
      const candidateKey = normalizeTitleLookup(candidate);
      const knownKey = normalizeTitleLookup(knownTitle);
      const prefixMatch = (
        Math.min(candidateKey.length, knownKey.length) >= 7
        && (candidateKey.startsWith(knownKey) || knownKey.startsWith(candidateKey))
      );
      const adjusted = prefixMatch ? Math.min(distance, 0.12) : distance;
      if (adjusted < bestDistance) {
        bestDistance = adjusted;
        bestKnown = knownTitle;
      }
    }
  }
  if (bestKnown && bestDistance <= 0.2) return bestKnown;

  if (
    descriptiveFileName
    && (
      !headerKey
      || fileWords.length >= 2
      || fileKey.includes(headerKey)
      || headerKey.includes(fileKey)
      || titleDistance(fileTitle, headerTitle) <= 0.45
    )
  ) {
    return readableTitle(fileTitle);
  }
  return readableTitle(headerTitle);
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
  const maxCharacters = 18;
  const words = String(value)
    .replace(/[_–—-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      if (word.length <= maxCharacters) return [word];
      const chunks = [];
      for (let index = 0; index < word.length; index += maxCharacters) {
        chunks.push(word.slice(index, index + maxCharacters));
      }
      return chunks;
    });
  const lines = [];
  while (words.length && lines.length < 3) {
    let line = "";
    while (words.length) {
      const candidate = `${line} ${words[0]}`.trim();
      if (line && candidate.length > maxCharacters) break;
      line = candidate;
      words.shift();
    }
    lines.push(line);
  }
  if (words.length) {
    const tail = `${lines[2]} ${words.join(" ")}`.trim();
    lines[2] = `${tail.slice(0, maxCharacters - 1).trimEnd()}…`;
  }
  return lines.length ? lines : ["UNTITLED"];
}

export function createFallbackArtwork(title, system, seed = "0") {
  const titleLines = splitTitle(title);
  const value = Number.parseInt(String(seed).slice(-6), 16) || 0;
  const stripeThemes = [
    ["#42d6d0", "#f05a88", "#c6f050"],
    ["#ff8b3d", "#4267d6", "#ffd84a"],
    ["#7d5ce7", "#65dfbd", "#ff6f7d"],
    ["#e9484d", "#42d6d0", "#fff1a8"],
    ["#3557b7", "#e3ad3d", "#4bd8bd"],
    ["#4eaa5b", "#8b55c9", "#ff884d"],
    ["#e74691", "#264d8d", "#b9ef47"],
    ["#3978d5", "#f17467", "#f1cf45"],
  ];
  const [accent, secondary, tertiary] = stripeThemes[value % stripeThemes.length];
  const base = system === "gbc" ? "#24252a" : "#e7e4d9";
  const ink = system === "gbc" ? "#f1f0e9" : "#24272e";
  const longestLine = Math.max(...titleLines.map((line) => line.length));
  const titleSize = longestLine <= 12 ? 36 : longestLine <= 16 ? 31 : 27;
  const lineHeight = titleSize + 5;
  const titleStart = 291 - ((titleLines.length - 1) * lineHeight) / 2;
  const titleMarkup = titleLines
    .map((line, index) => (
      `<tspan x="210" y="${Math.round(titleStart + index * lineHeight)}">${xmlEscape(line)}</tspan>`
    ))
    .join("");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
      <rect width="420" height="420" fill="${base}"/>
      <path d="M0 0H420V70L0 162Z" fill="${accent}"/>
      <path d="M0 92L420 8V105L0 198Z" fill="${secondary}"/>
      <path d="M0 174L420 80V126L0 220Z" fill="${tertiary}"/>
      <rect x="28" y="224" width="364" height="146" fill="${ink}"/>
      <text text-anchor="middle" fill="${base}" font-family="Arial Black,Arial,sans-serif" font-size="${titleSize}" font-style="italic" font-weight="900">${titleMarkup}</text>
      <text x="210" y="354" text-anchor="middle" fill="${accent}" font-family="monospace" font-size="11" font-weight="700" letter-spacing="3.4">GAMEBOY LAB ARCHIVE</text>
      <g fill="${tertiary}" opacity=".42">
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
        if (artwork) return { ...artwork, matchedName: candidate };
      } catch (error) {
        if (error?.name === "AbortError") break;
      }
    }
    return fallback;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
