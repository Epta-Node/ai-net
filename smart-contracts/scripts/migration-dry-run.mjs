import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const currentPath = value('--current', 'storage-layout.json');
const targetPath = value('--target', 'migration-plan.json');
const outputPath = value('--output', 'migration-summary.json');
const apply = args.includes('--apply');
if (!existsSync(currentPath) || !existsSync(targetPath)) {
  console.error(
    `Expected ${currentPath} and ${targetPath}; use --current and --target to select inputs.`
  );
  process.exit(1);
}
const current = JSON.parse(readFileSync(currentPath, 'utf8'));
const target = JSON.parse(readFileSync(targetPath, 'utf8'));
const before = current.keys ?? current;
const after = target.keys ?? target;
const currentKeys = new Set(Object.keys(before));
const targetKeys = new Set(Object.keys(after));
const added = [...targetKeys].filter((key) => !currentKeys.has(key)).sort();
const removed = [...currentKeys].filter((key) => !targetKeys.has(key)).sort();
const rewritten = [...targetKeys]
  .filter(
    (key) => currentKeys.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])
  )
  .sort();
const summary = {
  mode: apply ? 'apply' : 'dry-run',
  added,
  removed,
  rewritten,
  estimatedLedgerEntryDelta: added.length - removed.length,
  irreversibleSteps: target.irreversibleSteps ?? target.irreversible ?? [],
};
writeFileSync(resolve(outputPath), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (apply) writeFileSync(resolve(currentPath), `${JSON.stringify(target, null, 2)}\n`);
else console.log('Dry-run: no storage layout was changed.');
