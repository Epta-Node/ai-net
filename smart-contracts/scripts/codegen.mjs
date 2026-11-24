import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url).pathname;
const dirs = ['wasm32v1-none', 'wasm32-unknown-unknown'].map((target) =>
  join(root, 'target', target, 'release')
);
const wasmFiles = dirs.flatMap((dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith('.wasm'))
        .map((file) => join(dir, file))
    : []
);
if (!wasmFiles.length) {
  console.error('No contract Wasm files found. Build contracts before running npm run codegen.');
  process.exit(1);
}
const output = join(root, 'src', 'generated');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const wasm of wasmFiles.sort()) {
  const destination = join(output, basename(wasm, '.wasm'));
  mkdirSync(destination, { recursive: true });
  execFileSync(
    'stellar',
    ['contract', 'bindings', 'typescript', '--wasm', wasm, '--output-dir', destination],
    {
      cwd: root,
      stdio: 'inherit',
    }
  );
}
writeFileSync(
  join(output, 'index.ts'),
  `// GENERATED FILE - DO NOT EDIT.\n${wasmFiles
    .map((wasm) => `export * from './${basename(wasm, '.wasm')}'`)
    .join('\n')}\n`,
)
function markGenerated(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) markGenerated(path);
    else if (entry.name.endsWith('.ts')) {
      const source = readFileSync(path, 'utf8');
      if (!source.startsWith('// GENERATED FILE - DO NOT EDIT.')) {
        writeFileSync(path, `// GENERATED FILE - DO NOT EDIT.\n${source}`);
      }
    }
  }
}
markGenerated(output);
console.log(`Generated TypeScript bindings for ${wasmFiles.length} contract(s).`);
