import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const valid = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const failures = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.rs')) {
      const source = readFileSync(path, 'utf8');
      const regex =
        /publish\s*\(\s*\(\s*symbol_short!\("([^"]+)"\)\s*,\s*symbol_short!\("([^"]+)"\)/g;
      for (const match of source.matchAll(regex)) {
        if (!valid.test(match[1]) || !valid.test(match[2]))
          failures.push(`${path}: ${match[1]}.${match[2]}`);
      }
    }
  }
}
walk(join(root, 'contracts'));
if (failures.length) {
  console.error('Non-conforming event topics (use lowercase snake_case):\n' + failures.join('\n'));
  process.exit(1);
}
console.log('All statically declared contract event topics use lowercase snake_case.');
