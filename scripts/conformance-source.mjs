/* global Buffer */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function gitCommit(root) {
  return git(root, ["rev-parse", "HEAD"]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function repositorySnapshot(root) {
  const repository = git(root, ["rev-parse", "--show-toplevel"]);
  const commit = gitCommit(root);
  if (!repository || !commit) {
    return {
      repository: null,
      commit: null,
      dirtyPaths: [],
      verified: false,
      reason: "Source is not inside a git work tree.",
    };
  }
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) || "";
  const dirtyPaths = status.split(/\r?\n/).filter(Boolean);
  return {
    repository,
    commit,
    dirtyPaths,
    verified: dirtyPaths.length === 0,
    reason: dirtyPaths.length ? "Source work tree contains uncommitted files." : "Source work tree is clean.",
  };
}

/**
 * Pin the exact core files used by a browser-side conformance run.  A git
 * commit alone is insufficient here because the working tree may contain
 * deliberate local emulator changes.  The content hashes make that state
 * reproducible while the clean flag makes it visible rather than silently
 * pretending it came from HEAD.
 */
export function coreSourceSnapshot(root, paths = ["app/lib/gameboy.js", "app/lib/embeddedBios.js"]) {
  const repository = git(root, ["rev-parse", "--show-toplevel"]);
  const commit = gitCommit(root);
  const files = paths.map((path) => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) {
      return { path, exists: false, bytes: null, sha256: null, tracked: false, status: null };
    }
    const bytes = readFileSync(absolute);
    const tracked = git(root, ["ls-files", "--error-unmatch", "--", path]) !== null;
    const status = git(root, ["status", "--porcelain=v1", "--", path]) || "";
    return {
      path,
      exists: true,
      bytes: bytes.length,
      sha256: sha256(bytes),
      tracked,
      status: status || "clean",
    };
  });
  const manifest = files
    .map((file) => `${file.path}\t${file.bytes ?? "missing"}\t${file.sha256 ?? "missing"}`)
    .sort()
    .join("\n");
  const dirtyPaths = files.filter((file) => file.status && file.status !== "clean").map((file) => file.path);
  const verified = Boolean(repository && commit && files.length && files.every((file) => file.exists && file.sha256));
  return {
    repository,
    commit,
    files,
    manifestSha256: sha256(Buffer.from(manifest)),
    verified,
    clean: verified && dirtyPaths.length === 0,
    dirtyPaths,
    reason: !verified
      ? "One or more core source files could not be content-addressed."
      : dirtyPaths.length
        ? "Core source is content-addressed from a dirty working tree; the exact file hashes are recorded."
        : "Core source commit and working tree are clean.",
  };
}

/**
 * Capture the source-control state alongside the content-addressed ROM
 * manifest. SameSuite intentionally ignores generated .gb files, so a git
 * commit alone cannot prove which binaries were tested. The manifest pins
 * every byte; this snapshot makes the provenance limitation explicit and
 * rejects a report only when tracked ROMs are dirty or the source repository
 * cannot be identified.
 */
export function romSourceSnapshot(root, absolutePaths) {
  const repository = git(root, ["rev-parse", "--show-toplevel"]);
  const commit = gitCommit(root);
  const paths = absolutePaths.map((path) => relative(root, path).replaceAll("\\", "/"));
  if (!repository || !commit) {
    return {
      repository: null,
      commit: null,
      totalRomFiles: paths.length,
      trackedRomCount: 0,
      untrackedRomCount: paths.length,
      ignoredRomCount: 0,
      modifiedTrackedPaths: [],
      untrackedPaths: paths,
      ignoredPaths: [],
      manifestPinsAllBytes: true,
      verified: false,
      reason: "ROM source is not inside a git work tree; only the content manifest is available.",
    };
  }

  const trackedRomPaths = [];
  const untrackedPaths = [];
  const ignoredPaths = [];
  const modifiedTrackedPaths = [];
  for (const path of paths) {
    const tracked = git(root, ["ls-files", "--error-unmatch", "--", path]) !== null;
    const status = git(root, [
      "status", "--porcelain=v1", "--untracked-files=all", "--ignored", "--", path,
    ]) || "";
    if (tracked) {
      trackedRomPaths.push(path);
      if (status && !status.startsWith("  ")) modifiedTrackedPaths.push(path);
    } else if (status.startsWith("!!")) {
      ignoredPaths.push(path);
    } else {
      untrackedPaths.push(path);
    }
  }

  return {
    repository,
    commit,
    totalRomFiles: paths.length,
    trackedRomCount: trackedRomPaths.length,
    untrackedRomCount: untrackedPaths.length,
    ignoredRomCount: ignoredPaths.length,
    modifiedTrackedPaths,
    untrackedPaths,
    ignoredPaths,
    manifestPinsAllBytes: true,
    verified: modifiedTrackedPaths.length === 0,
    reason: modifiedTrackedPaths.length
      ? "One or more tracked ROMs are modified in the work tree."
      : ignoredPaths.length
        ? "Generated ROMs are ignored by the suite repository; the report pins their exact bytes with the manifest hash."
        : "ROM source commit and work-tree state verified.",
  };
}
