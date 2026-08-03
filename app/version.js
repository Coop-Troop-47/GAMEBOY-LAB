export const APP_VERSION = "3.0.4";
export const UPDATE_REPOSITORY = "Coop-Troop-47/GAMEBOY-LAB";
export const UPDATE_ASSET_NAME = "gbc-lab.html";
export const UPDATE_MANIFEST_URL = (
  "https://gist.githubusercontent.com/Coop-Troop-47/"
  + "64fa2980b0470b40effecf6ae77787fb/raw/update-manifest.json"
);

function numericVersion(version) {
  return String(version)
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(left, right) {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export async function findAvailableUpdate(fetchImplementation = globalThis.fetch) {
  const response = await fetchImplementation(
    UPDATE_MANIFEST_URL,
    {
      cache: "no-store",
    },
  );
  if (!response.ok) return null;
  const manifest = await response.json();
  const version = String(manifest.version || "").replace(/^v/i, "");
  if (!version || compareVersions(version, APP_VERSION) <= 0) return null;
  if (!manifest.downloadUrl) return null;
  return {
    version,
    downloadUrl: manifest.downloadUrl,
    notesUrl: manifest.notesUrl || manifest.downloadUrl,
    changes: Array.isArray(manifest.changes)
      ? manifest.changes
          .filter((change) => typeof change === "string" && change.trim())
          .slice(0, 6)
      : [],
  };
}
