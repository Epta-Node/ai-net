import fs from "fs";
import path from "path";

/**
 * Test to assert no production TypeScript module in backend/src has zero importers.
 * This prevents new orphaned modules from accumulating in the codebase.
 */
describe("Orphaned modules guard", () => {
  const srcDir = path.resolve(__dirname, "../src");

  function getAllTsFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(getAllTsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it("ensures every production module is imported by at least one other file or entry point", () => {
    const allFiles = getAllTsFiles(srcDir);

    // Entry points that are naturally not imported by other modules:
    // - src/index.ts (server entrypoint)
    // - src/api/index.ts (api module entrypoint)
    // - src/db/cli.ts (CLI entrypoint)
    const entryPoints = new Set([
      path.join(srcDir, "index.ts"),
      path.join(srcDir, "api", "index.ts"),
      path.join(srcDir, "db", "cli.ts"),
    ]);

    // Read contents of all files
    const fileContentsMap = new Map<string, string>();
    for (const file of allFiles) {
      fileContentsMap.set(file, fs.readFileSync(file, "utf8"));
    }

    const orphanedFiles: string[] = [];

    for (const file of allFiles) {
      if (entryPoints.has(file) || file.includes(".test.ts")) {
        continue;
      }

      const relativePath = path.relative(srcDir, file).replace(/\\/g, "/");
      const baseNameWithoutExt = path.basename(file, ".ts");

      let isImported = false;

      for (const [otherFile, content] of fileContentsMap.entries()) {
        if (otherFile === file) continue;

        // Check if otherFile imports file
        if (
          content.includes(baseNameWithoutExt) ||
          content.includes(relativePath.replace(/\.ts$/, ""))
        ) {
          isImported = true;
          break;
        }
      }

      if (!isImported) {
        orphanedFiles.push(relativePath);
      }
    }

    expect(orphanedFiles).toEqual([]);
  });
});
