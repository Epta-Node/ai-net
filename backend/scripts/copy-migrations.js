/**
 * `tsc` only emits compiled JS — it does not copy the `.sql` migration
 * files under src/db/migrations into dist/. Run this after `tsc` so a
 * built (non-ts-node) backend can still find its migrations at runtime.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src", "db", "migrations");
const DEST = path.join(__dirname, "..", "dist", "db", "migrations");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDir(SRC, DEST);
