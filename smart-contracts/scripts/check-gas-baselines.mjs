#!/usr/bin/env node
/**
 * check-gas-baselines.mjs
 *
 * Parses a gas-report.txt produced by the gas-check test harness and
 * compares each entrypoint's measured instruction count against the
 * value stored in gas-baselines.json.
 *
 * Exit codes:
 *   0  – all entrypoints within tolerance
 *   1  – one or more entrypoints exceed the baseline by > tolerance_percent
 *
 * Usage:
 *   node scripts/check-gas-baselines.mjs gas-report.txt [--update]
 *
 * --update  Rewrites gas-baselines.json with the measured values and exits 0.
 *           Use this in the auto-update workflow to commit fresh baselines.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const reportPath = args.find((a) => !a.startsWith("--"));
const doUpdate = args.includes("--update");

if (!reportPath) {
  console.error("Usage: check-gas-baselines.mjs <gas-report.txt> [--update]");
  process.exit(1);
}

// ── Parse baselines ────────────────────────────────────────────────────────

const baselinesPath = resolve(ROOT, "gas-baselines.json");
const baselines = JSON.parse(readFileSync(baselinesPath, "utf8"));
const tolerancePct = baselines.tolerance_percent ?? 5;

// ── Parse report ───────────────────────────────────────────────────────────
// Expected line format from gas harness:
//   GAS_MEASURE contract::entrypoint instructions=305046 memory=52717

const reportText = readFileSync(reportPath, "utf8");
const measured = {};

for (const line of reportText.split("\n")) {
  const m = line.match(
    /GAS_MEASURE\s+(\S+)\s+instructions=(\d+)\s+memory=(\d+)/,
  );
  if (m) {
    measured[m[1]] = {
      instructions: parseInt(m[2], 10),
      memory_bytes: parseInt(m[3], 10),
    };
  }
}

if (Object.keys(measured).length === 0) {
  console.warn(
    "⚠️  No GAS_MEASURE lines found in report — check harness output format.",
  );
  process.exit(0);
}

// ── Update mode ────────────────────────────────────────────────────────────

if (doUpdate) {
  const updated = { ...baselines, entrypoints: {} };
  for (const [ep, vals] of Object.entries(measured)) {
    updated.entrypoints[ep] = vals;
  }
  writeFileSync(baselinesPath, JSON.stringify(updated, null, 2) + "\n");
  console.log(
    `✅ gas-baselines.json updated with ${Object.keys(measured).length} entrypoints.`,
  );
  process.exit(0);
}

// ── Enforcement mode ───────────────────────────────────────────────────────

let failures = 0;
const rows = [];

for (const [ep, vals] of Object.entries(measured)) {
  const baseline = baselines.entrypoints?.[ep];
  if (!baseline) {
    rows.push({ ep, status: "NEW", measured: vals.instructions, baseline: "—" });
    continue;
  }

  const pctOver =
    ((vals.instructions - baseline.instructions) / baseline.instructions) *
    100;
  if (pctOver > tolerancePct) {
    failures++;
    rows.push({
      ep,
      status: "OVER",
      measured: vals.instructions,
      baseline: baseline.instructions,
      pctOver: pctOver.toFixed(1),
    });
  } else {
    rows.push({
      ep,
      status: "OK",
      measured: vals.instructions,
      baseline: baseline.instructions,
      pctOver: pctOver.toFixed(1),
    });
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\nGas baseline check (tolerance: ${tolerancePct}%)\n`);
console.log(
  `${"Entrypoint".padEnd(50)} ${"Status".padEnd(6)} ${"Measured".padStart(10)} ${"Baseline".padStart(10)} ${"Δ%".padStart(7)}`,
);
console.log("─".repeat(90));

for (const r of rows) {
  const icon = r.status === "OVER" ? "❌" : r.status === "NEW" ? "🆕" : "✅";
  console.log(
    `${icon} ${r.ep.padEnd(48)} ${r.status.padEnd(6)} ${String(r.measured).padStart(10)} ${String(r.baseline).padStart(10)} ${r.pctOver != null ? `${r.pctOver}%`.padStart(6) : "     —"}`,
  );
}

console.log("");

if (failures > 0) {
  console.error(
    `❌ ${failures} entrypoint(s) exceeded the gas baseline by more than ${tolerancePct}%.`,
  );
  console.error(
    `   Run: node scripts/check-gas-baselines.mjs gas-report.txt --update`,
  );
  console.error(`   to accept the new measurements and commit updated baselines.`);
  process.exit(1);
}

console.log(
  `✅ All ${Object.keys(measured).length} measured entrypoints within gas budget.`,
);
