// Windows without Developer Mode (or an elevated shell) refuses to create
// symbolic links with EPERM. CI runs on Linux and macOS, where these tests
// exercise real links; on such a Windows host a test skips only the step that
// needs a link, or stands a directory junction in for a directory link.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached;

/** Whether this process can create both file and directory symbolic links. */
export function canSymlink() {
  if (cached !== undefined) return cached;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(root, "target"), "");
    fs.mkdirSync(path.join(root, "directory"));
    fs.symlinkSync("target", path.join(root, "file-link"), "file");
    fs.symlinkSync(path.join(root, "directory"), path.join(root, "directory-link"), "dir");
    cached = true;
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    cached = false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return cached;
}

export const SYMLINK_SKIP_REASON = "this host cannot create symbolic links without privilege (Windows without Developer Mode)";

/**
 * An fs whose directory symlinks become junctions when real ones cannot be
 * created. Junctions need no privilege, take absolute targets, and lstat and
 * readlink report them as links, so link-repointing code runs unchanged.
 * Windows refuses to rename onto an existing junction, so renaming one link
 * onto another drops the old link first: the POSIX result, without its
 * atomicity (which no test here measures).
 */
export function directoryLinkFs() {
  if (canSymlink()) return fs;
  const isLink = (file) => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true;
  return {
    ...fs,
    symlinkSync(target, file, type) {
      return fs.symlinkSync(type === "dir" ? path.resolve(path.dirname(file), target) : target, file, type === "dir" ? "junction" : type);
    },
    renameSync(from, to) {
      if (isLink(from) && isLink(to)) fs.unlinkSync(to);
      return fs.renameSync(from, to);
    },
  };
}
