#!/usr/bin/env node
// Enforce committed Wasm size budgets for the deployable contracts (Issue #772).
//
// The release Wasm artifacts are built by CI before this script runs. Compare
// each contract's optimized binary against `wasm-sizes.json`; fail when growth
// exceeds the configured tolerance.
//
// Usage:
//   node scripts/check-wasm-size.mjs            # enforce (CI)
//   node scripts/check-wasm-size.mjs --report   # print sizes, always exit 0
//   node scripts/check-wasm-size.mjs --update   # rewrite the baseline
//   node scripts/check-wasm-size.mjs --dir <path> --target <triple>
//
// Environment:
//   WASM_SIZE_TOLERANCE_PCT   Override the baseline tolerance for this run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'wasm-sizes.json');
const REPORT_PATH = path.join(ROOT, 'wasm-size-report.md');
const DEFAULT_TARGET = 'wasm32v1-none';
const DEFAULT_TOLERANCE_PERCENT = 5;
const BASELINE_VERSION = 1;

/** Deployable contracts built by the CI wasm step, in display order. */
const CONTRACTS = [
  { name: 'agent_registry', artifact: 'agent_registry.wasm' },
  { name: 'error-registry', artifact: 'error_registry.wasm' },
  { name: 'agent-bidding', artifact: 'agent_bidding.wasm' },
  { name: 'agent-marketplace', artifact: 'agent_marketplace.wasm' },
  { name: 'task-store', artifact: 'task_store.wasm' },
  { name: 'dispute-resolution', artifact: 'dispute_resolution.wasm' },
  { name: 'upgrade-manager', artifact: 'upgrade_manager.wasm' },
];

function parseArgs(argv) {
  const options = {
    update: false,
    report: false,
    target: DEFAULT_TARGET,
    dir: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update') options.update = true;
    else if (arg === '--report') options.report = true;
    else if (arg === '--target') options.target = argv[++i];
    else if (arg === '--dir') options.dir = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/check-wasm-size.mjs [--update] [--report] [--target <triple>] [--dir <path>]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function defaultBaseline(target) {
  return {
    version: BASELINE_VERSION,
    target,
    tolerance_percent: DEFAULT_TOLERANCE_PERCENT,
    contracts: {},
  };
}

function loadBaseline(options) {
  if (!fs.existsSync(BASELINE_PATH)) {
    if (options.update) return defaultBaseline(options.target);
    console.error(
      `Missing baseline ${path.relative(ROOT, BASELINE_PATH)}.\n` +
        `Record it with:\n\n  node scripts/check-wasm-size.mjs --update\n`,
    );
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  if (baseline.version !== BASELINE_VERSION) {
    console.error(
      `Unsupported baseline version ${baseline.version} in ${path.relative(ROOT, BASELINE_PATH)} ` +
        `(expected ${BASELINE_VERSION}).`,
    );
    process.exit(1);
  }
  return baseline;
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} B (${(bytes / 1024).toFixed(1)} KiB)`;
}

function percentGrowth(baseline, current) {
  if (baseline === 0) return current === 0 ? 0 : Infinity;
  return ((current - baseline) / baseline) * 100;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseline = loadBaseline(options);
  const target = options.target;
  const dir =
    options.dir ?? path.join(ROOT, 'target', target, 'release');

  if (!options.update && baseline.target && baseline.target !== target) {
    console.error(
      `Baseline was recorded for target ${baseline.target}, but this run targets ${target}. ` +
        `Re-record with --update --target ${target}.`,
    );
    process.exit(1);
  }

  const tolerance =
    Number(process.env.WASM_SIZE_TOLERANCE_PCT) ||
    baseline.tolerance_percent ||
    DEFAULT_TOLERANCE_PERCENT;

  const rows = [];
  const failures = [];
  const updated = {};

  for (const contract of CONTRACTS) {
    const artifactPath = path.join(dir, contract.artifact);
    if (!fs.existsSync(artifactPath)) {
      console.error(
        `Missing Wasm artifact: ${path.relative(ROOT, artifactPath)}\n` +
          `Build it first, e.g.:\n\n  cargo build --locked -p ${contract.name} --target ${target} --release\n`,
      );
      process.exit(1);
    }

    const current = fs.statSync(artifactPath).size;
    const previous = baseline.contracts[contract.name];
    updated[contract.name] = current;

    if (!previous && !options.update) {
      console.error(
        `No size baseline for ${contract.name}.\n` +
          `Record it with:\n\n  node scripts/check-wasm-size.mjs --update\n`,
      );
      process.exit(1);
    }

    const growth = previous === undefined ? 0 : percentGrowth(previous, current);
    const regressed = previous !== undefined && growth > tolerance;
    const status = options.update
      ? 'updated'
      : regressed
        ? 'FAIL'
        : previous === undefined
          ? 'new'
          : 'ok';

    rows.push({
      contract: contract.name,
      previous,
      current,
      growth,
      regressed,
      status,
    });
    if (regressed) failures.push({ contract: contract.name, previous, current, growth });
  }

  if (options.update) {
    const next = {
      version: BASELINE_VERSION,
      target,
      tolerance_percent: baseline.tolerance_percent ?? DEFAULT_TOLERANCE_PERCENT,
      contracts: Object.fromEntries(
        [...CONTRACTS]
          .filter((contract) => updated[contract.name] !== undefined)
          .map((contract) => [contract.name, updated[contract.name]]),
      ),
    };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Recorded ${Object.keys(next.contracts).length} Wasm sizes in ${path.relative(ROOT, BASELINE_PATH)}.`);
  }

  const lines = [
    '| Contract | Baseline | Current | Δ bytes | Δ % | Status |',
    '|---|---:|---:|---:|---:|---|',
    ...rows.map((row) => {
      const delta = row.previous === undefined ? '—' : row.current - row.previous;
      const growth = row.previous === undefined ? '—' : `${row.growth >= 0 ? '+' : ''}${row.growth.toFixed(2)}%`;
      const deltaText =
        row.previous === undefined
          ? '—'
          : `${delta >= 0 ? '+' : ''}${delta.toLocaleString('en-US')}`;
      return `| ${row.contract} | ${row.previous === undefined ? '—' : row.previous.toLocaleString('en-US')} | ${row.current.toLocaleString('en-US')} | ${deltaText} | ${growth} | ${row.status} |`;
    }),
  ];

  const heading = options.report
    ? `Wasm sizes (${target}) — report only`
    : `Wasm sizes (${target}) — tolerance ${tolerance}%`;
  const table = `${heading}\n\n${lines.join('\n')}\n`;
  console.log(table);
  fs.writeFileSync(REPORT_PATH, `${table}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  }

  if (failures.length > 0 && !options.report && !options.update) {
    console.error('\nWasm size budget exceeded:');
    for (const failure of failures) {
      console.error(
        `  ✗ ${failure.contract}: ${formatBytes(failure.previous)} -> ${formatBytes(failure.current)} ` +
          `(${failure.growth >= 0 ? '+' : ''}${failure.growth.toFixed(2)}%, budget +${tolerance}%)`,
      );
    }
    console.error(
      '\nA dependency bump or code change made a contract bigger. If the growth is intentional,\n' +
        're-record the baseline and explain it in the PR:\n\n  node scripts/check-wasm-size.mjs --update\n',
    );
    process.exit(1);
  }

  console.log(
    `Wasm size check passed for ${rows.length} contract(s) (tolerance ${tolerance}%).`,
  );
}

main();
