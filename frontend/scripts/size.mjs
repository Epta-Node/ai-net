import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const dist = join(root, 'dist');
const budgets = JSON.parse(readFileSync(join(root, 'size-budget.json'), 'utf8'));
if (!existsSync(dist)) {
  console.error('frontend/dist is missing; run npm run build first');
  process.exit(1);
}
const assets = readdirSync(join(dist, 'assets'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => {
    const file = join(dist, 'assets', name);
    return {
      name,
      gzipBytes: gzipSync(readFileSync(file), { level: 9 }).length,
      rawBytes: statSync(file).size,
    };
  });
let failed = false;
const budgetFor = (name) => {
  if (budgets[name]) return budgets[name]
  for (const [pattern, budget] of Object.entries(budgets)) {
    if (pattern.includes('*') && new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(name)) {
      return budget
    }
  }
  return budgets.default
}
console.log('Gzipped JavaScript bundle sizes:')
for (const asset of assets.sort((a, b) => b.gzipBytes - a.gzipBytes)) {
  const budget = budgetFor(asset.name)
  const over = asset.gzipBytes > budget.gzipBytes;
  console.log(
    `  ${over ? 'FAIL' : 'PASS'} ${asset.name}: ${(asset.gzipBytes / 1024).toFixed(1)} KiB gzip`
  );
  if (over) {
    console.error(
      `    budget ${budget.gzipBytes} bytes exceeded by ${asset.gzipBytes - budget.gzipBytes} bytes`
    );
    failed = true;
  }
}
if (failed) process.exit(1);
