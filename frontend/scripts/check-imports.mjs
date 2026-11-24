#!/usr/bin/env node
// Fails when a relative asset import under src/ (stylesheets, images, fonts…)
// points at a file that does not exist.
//
// `tsc --noEmit` cannot catch these: vite/client declares ambient modules for
// `*.module.css`, `*.svg`, etc., so any path with a matching extension
// type-checks whether or not the file is there. The missing file only
// surfaces once Vite tries to bundle it, and Rollup stops at the first one.
// Script imports (.ts/.tsx/.js/.json or extensionless) are left to tsc, which
// already reports those as TS2307.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const TYPECHECKED_EXTENSIONS = [...SOURCE_EXTENSIONS, '.mjs', '.cjs', '.json'];

// Static imports/re-exports (`import x from`, `export * from`, bare
// `import './x.css'`) and dynamic `import('./x')`.
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]*)\1/g;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [path] : [];
  });
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const failures = [];

for (const file of walk(srcDir)) {
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    // Drop Vite query suffixes such as `?url` or `?raw`.
    const specifier = match[2].split(/[?#]/)[0];
    const ext = extname(specifier);
    if (!ext || TYPECHECKED_EXTENSIONS.includes(ext)) continue;

    const target = resolve(dirname(file), specifier);
    if (!existsSync(target) || !statSync(target).isFile()) {
      failures.push(`${relative(root, file)}: cannot resolve '${match[2]}'`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} unresolved relative asset import(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log('All relative asset imports under src/ resolve.');
