const BATTERY_PREFIX = "gbc-lab-save:";
const STATE_PREFIX = "gbc-lab-state:";
export const SAVE_ARCHIVE_FORMAT = "gameboy-lab-save-archive";
export const SAVE_ARCHIVE_VERSION = 1;

function assertRomKey(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 512
    || /[\u0000-\u001f]/.test(value)
  ) {
    throw new Error("The backup contains an invalid cartridge identifier.");
  }
  return value;
}

function storageKeyForEntry(entry) {
  const romKey = assertRomKey(entry.romKey);
  if (entry.type === "battery") return `${BATTERY_PREFIX}${romKey}`;
  if (
    entry.type === "state"
    && Number.isInteger(entry.slot)
    && entry.slot >= 0
    && entry.slot <= 2
  ) {
    return `${STATE_PREFIX}${romKey}:${entry.slot}`;
  }
  throw new Error("The backup contains an unknown save record.");
}

function validateEntry(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.value !== "string") {
    throw new Error("The backup contains a damaged save record.");
  }
  const storageKey = storageKeyForEntry(entry);
  if (entry.type === "battery") {
    if (!entry.value) throw new Error("The backup contains an empty cartridge save.");
    if (entry.value.startsWith("{")) {
      const parsed = JSON.parse(entry.value);
      if (!parsed || typeof parsed.ram !== "string") {
        throw new Error("The backup contains invalid cartridge RAM.");
      }
    }
  } else {
    const parsed = JSON.parse(entry.value);
    if (
      !parsed
      || parsed.romKey !== entry.romKey
      || !parsed.state
      || !Number.isFinite(parsed.savedAt)
    ) {
      throw new Error("The backup contains an incompatible save state.");
    }
  }
  return {
    type: entry.type,
    romKey: entry.romKey,
    ...(entry.type === "state" ? { slot: entry.slot } : {}),
    ...(typeof entry.title === "string" && entry.title ? { title: entry.title } : {}),
    value: entry.value,
    storageKey,
  };
}

export function collectSaveEntries(storage, titleByRomKey = new Map()) {
  const entries = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    const value = storage.getItem(key);
    if (typeof value !== "string") continue;
    if (key.startsWith(BATTERY_PREFIX)) {
      const romKey = key.slice(BATTERY_PREFIX.length);
      entries.push(validateEntry({
        type: "battery",
        romKey,
        title: titleByRomKey.get(romKey),
        value,
      }));
      continue;
    }
    if (!key.startsWith(STATE_PREFIX)) continue;
    const suffix = key.slice(STATE_PREFIX.length);
    const separator = suffix.lastIndexOf(":");
    const romKey = suffix.slice(0, separator);
    const slot = Number(suffix.slice(separator + 1));
    entries.push(validateEntry({
      type: "state",
      romKey,
      slot,
      title: titleByRomKey.get(romKey),
      value,
    }));
  }
  return entries
    .sort((left, right) => left.storageKey.localeCompare(right.storageKey))
    .map((entry) => {
      const portableEntry = { ...entry };
      delete portableEntry.storageKey;
      return portableEntry;
    });
}

export function summarizeSaveArchive(archive) {
  const batterySaves = archive.entries.filter((entry) => entry.type === "battery").length;
  const saveStates = archive.entries.filter((entry) => entry.type === "state").length;
  return {
    batterySaves,
    saveStates,
    games: new Set(archive.entries.map((entry) => entry.romKey)).size,
    records: archive.entries.length,
  };
}

export function createSaveArchive(storage, titleByRomKey = new Map()) {
  const archive = {
    format: SAVE_ARCHIVE_FORMAT,
    version: SAVE_ARCHIVE_VERSION,
    app: "GAMEBOY LAB",
    createdAt: new Date().toISOString(),
    entries: collectSaveEntries(storage, titleByRomKey),
  };
  return {
    archive,
    summary: summarizeSaveArchive(archive),
  };
}

export function parseSaveArchive(text) {
  if (typeof text !== "string" || text.length > 64 * 1024 * 1024) {
    throw new Error("That backup file is too large or unreadable.");
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("That is not a valid GAMEBOY LAB backup.");
  }
  if (
    input?.format !== SAVE_ARCHIVE_FORMAT
    || input.version !== SAVE_ARCHIVE_VERSION
    || !Array.isArray(input.entries)
  ) {
    throw new Error("That backup format or version is not supported.");
  }
  if (input.entries.length > 10000) {
    throw new Error("That backup contains too many save records.");
  }
  const seen = new Set();
  const entries = input.entries.map((entry) => {
    const validated = validateEntry(entry);
    if (seen.has(validated.storageKey)) {
      throw new Error("That backup contains duplicate save records.");
    }
    seen.add(validated.storageKey);
    const portableEntry = { ...validated };
    delete portableEntry.storageKey;
    return portableEntry;
  });
  const archive = {
    format: SAVE_ARCHIVE_FORMAT,
    version: SAVE_ARCHIVE_VERSION,
    app: typeof input.app === "string" ? input.app : "GAMEBOY LAB",
    createdAt: typeof input.createdAt === "string" ? input.createdAt : "",
    entries,
  };
  return {
    archive,
    summary: summarizeSaveArchive(archive),
  };
}

export function replaceSaveArchive(storage, archive) {
  const incoming = archive.entries.map(validateEntry);
  const previous = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(BATTERY_PREFIX) && !key?.startsWith(STATE_PREFIX)) continue;
    const value = storage.getItem(key);
    if (typeof value === "string") previous.push({ key, value });
  }
  const clearSaveRecords = () => {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(BATTERY_PREFIX) || key?.startsWith(STATE_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
  };
  clearSaveRecords();
  try {
    incoming.forEach((entry) => storage.setItem(entry.storageKey, entry.value));
  } catch (error) {
    clearSaveRecords();
    try {
      previous.forEach((entry) => storage.setItem(entry.key, entry.value));
    } catch {
      throw new Error("Restore failed and browser storage could not be rolled back.");
    }
    throw error;
  }
  return summarizeSaveArchive({ entries: incoming });
}
