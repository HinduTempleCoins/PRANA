// akasha/lib/storage-fs.mjs
//
// Node-filesystem implementation of the storage interface the keystore depends on.
//
// Storage interface (intentionally tiny so a browser localStorage impl can satisfy
// it later without touching the keystore):
//   saveBlob(blob: string): Promise<void>
//   loadBlob(): Promise<string | null>   // null when nothing has been saved yet
//
// The "blob" is an opaque, already-encrypted JSON string. This layer adds NO
// cryptography — it only reads/writes bytes. Writes are atomic (write-to-temp +
// rename) so a crash mid-write can't corrupt an existing store.

import { writeFile, readFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function createFsStorage(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("createFsStorage requires a file path");
  }
  const dir = dirname(filePath);
  const tmpPath = `${filePath}.tmp`;

  return {
    async saveBlob(blob) {
      if (typeof blob !== "string") throw new Error("blob must be a string");
      await mkdir(dir, { recursive: true });
      // Atomic: write temp, then rename over the target.
      await writeFile(tmpPath, blob, { encoding: "utf8", mode: 0o600 });
      await rename(tmpPath, filePath);
    },

    async loadBlob() {
      try {
        return await readFile(filePath, "utf8");
      } catch (err) {
        if (err && err.code === "ENOENT") return null;
        throw err;
      }
    },
  };
}

// In-memory storage — handy for tests and ephemeral sessions. Implements the same
// interface as the fs impl.
export function createMemoryStorage(initial = null) {
  let blob = initial;
  return {
    async saveBlob(b) {
      if (typeof b !== "string") throw new Error("blob must be a string");
      blob = b;
    },
    async loadBlob() {
      return blob;
    },
  };
}
