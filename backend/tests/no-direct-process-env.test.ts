import fs from "fs";
import path from "path";

describe("process.env direct access enforcement", () => {
  const allowedRelativePaths = new Set([
    "config/index.ts",
    "utils/logger.ts",
    "index.ts",
    "checkSpec.ts",
    "db/cli.ts",
    "db/seed.ts",
    "db/migrations/cli.ts",
    "db/migrations/runner.ts",
    "queue/worker.ts",
  ]);

  function getFiles(dir: string): string[] {
    const subdirs = fs.readdirSync(dir);
    const files: string[] = [];
    for (const subdir of subdirs) {
      const res = path.resolve(dir, subdir);
      if (fs.statSync(res).isDirectory()) {
        files.push(...getFiles(res));
      } else if (res.endsWith(".ts") && !res.endsWith(".test.ts")) {
        files.push(res);
      }
    }
    return files;
  }

  it("asserts feature code has no direct process.env reads outside allowed config/entry files", () => {
    const srcDir = path.resolve(__dirname, "../src");
    const allTsFiles = getFiles(srcDir);

    const violations: string[] = [];

    for (const file of allTsFiles) {
      const relPath = path.relative(srcDir, file).replace(/\\/g, "/");
      if (allowedRelativePaths.has(relPath)) {
        continue;
      }

      const content = fs.readFileSync(file, "utf8");
      // Remove comments to avoid false positives in docstrings
      const codeOnly = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

      if (codeOnly.includes("process.env")) {
        violations.push(relPath);
      }
    }

    expect(violations).toEqual([]);
  });
});
