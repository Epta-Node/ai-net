//! Gas-snapshot assertions for contract entrypoints.
//!
//! Every measurement is the native Soroban host's metered CPU-instruction and
//! memory consumption for one top-level contract call. Inputs are fixed by the
//! test, and `Env::default()` uses a fixed base PRNG seed, so the numbers are
//! deterministic across runs and machines for a pinned `soroban-sdk`.
//!
//! Baselines live in `smart-contracts/gas-baselines.json` (one entry per
//! `contract::entrypoint`). A test fails when a measurement exceeds its
//! baseline by more than the configured tolerance. Intentional changes are
//! recorded by re-running the suite with `UPDATE_GAS_BASELINES=1`.

use serde::{Deserialize, Serialize};
use soroban_sdk::Env;
use std::{collections::BTreeMap, path::PathBuf, sync::Mutex};

const DEFAULT_TOLERANCE_PERCENT: u64 = 5;
const BASELINE_VERSION: u32 = 1;

/// CPU instructions and memory bytes consumed by one entrypoint call.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct GasMeasurement {
    pub instructions: u64,
    pub memory_bytes: u64,
}

impl GasMeasurement {
    fn growth_percent(self, baseline: GasMeasurement) -> (f64, f64) {
        let instructions = percent_growth(baseline.instructions, self.instructions);
        let memory = percent_growth(baseline.memory_bytes, self.memory_bytes);
        (instructions, memory)
    }
}

fn percent_growth(baseline: u64, current: u64) -> f64 {
    if baseline == 0 {
        return if current == 0 { 0.0 } else { f64::INFINITY };
    }
    (current as f64 - baseline as f64) / baseline as f64 * 100.0
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct BaselineFile {
    version: u32,
    tolerance_percent: u64,
    entrypoints: BTreeMap<String, GasMeasurement>,
}

impl Default for BaselineFile {
    fn default() -> Self {
        Self {
            version: BASELINE_VERSION,
            tolerance_percent: DEFAULT_TOLERANCE_PERCENT,
            entrypoints: BTreeMap::new(),
        }
    }
}

/// Serialises read-modify-write cycles inside one test binary. Cargo runs test
/// binaries sequentially, and updating baselines is a local, explicit action,
/// so a process-local lock is sufficient.
static BASELINE_LOCK: Mutex<()> = Mutex::new(());

fn baseline_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../gas-baselines.json")
}

fn load_baselines() -> BaselineFile {
    let path = baseline_path();
    let contents = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return BaselineFile::default();
        }
        Err(err) => panic!("failed to read {}: {err}", path.display()),
    };
    let file: BaselineFile = serde_json::from_str(&contents)
        .unwrap_or_else(|err| panic!("invalid gas baseline {}: {err}", path.display()));
    assert_eq!(
        file.version,
        BASELINE_VERSION,
        "unsupported gas baseline version {} in {} (expected {})",
        file.version,
        path.display(),
        BASELINE_VERSION
    );
    file
}

fn save_baselines(file: &BaselineFile) {
    let path = baseline_path();
    let mut serialized = serde_json::to_string_pretty(file)
        .unwrap_or_else(|err| panic!("failed to serialise gas baselines: {err}"));
    serialized.push('\n');
    std::fs::write(&path, serialized)
        .unwrap_or_else(|err| panic!("failed to write {}: {err}", path.display()));
}

fn update_requested() -> bool {
    matches!(
        std::env::var("UPDATE_GAS_BASELINES").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

fn tolerance_percent(file: &BaselineFile) -> u64 {
    std::env::var("GAS_SNAPSHOT_TOLERANCE_PCT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(file.tolerance_percent)
}

/// Reset the budget tracker so the next contract call is measured in
/// isolation.
pub fn reset(env: &Env) {
    env.cost_estimate().budget().reset_tracker();
}

/// Read the resources consumed since the last [`reset`].
pub fn measure(env: &Env) -> GasMeasurement {
    let budget = env.cost_estimate().budget();
    GasMeasurement {
        instructions: budget.cpu_instruction_cost(),
        memory_bytes: budget.memory_bytes_cost(),
    }
}

/// Assert that the last call measured against `contract::entrypoint` is within
/// the committed baseline.
///
/// Call [`reset`] immediately before the entrypoint invocation.
pub fn assert_snapshot(env: &Env, contract: &str, entrypoint: &str) {
    let key = format!("{contract}::{entrypoint}");
    let current = measure(env);
    let _guard = BASELINE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut file = load_baselines();

    if update_requested() {
        let previous = file.entrypoints.insert(key.clone(), current);
        save_baselines(&file);
        match previous {
            Some(previous) => std::println!(
                "[gas] updated {key}: instructions {} -> {}, memory {} -> {} bytes",
                previous.instructions,
                current.instructions,
                previous.memory_bytes,
                current.memory_bytes
            ),
            None => std::println!(
                "[gas] recorded {key}: instructions={}, memory={} bytes",
                current.instructions,
                current.memory_bytes
            ),
        }
        return;
    }

    let baseline = file.entrypoints.get(&key).copied().unwrap_or_else(|| {
        panic!(
            "no gas baseline for `{key}`.\n\
             Record it with:\n\
             \n    UPDATE_GAS_BASELINES=1 cargo test -p <contract> --test <suite>\n"
        )
    });

    let tolerance = tolerance_percent(&file) as f64;
    let (instructions_growth, memory_growth) = current.growth_percent(baseline);
    std::println!(
        "[gas] {key}: instructions {} (baseline {}, {:+.1}%) | memory {} B (baseline {}, {:+.1}%) | tolerance {tolerance}%",
        current.instructions,
        baseline.instructions,
        instructions_growth,
        current.memory_bytes,
        baseline.memory_bytes,
        memory_growth
    );

    let instructions_regressed = instructions_growth > tolerance;
    let memory_regressed = memory_growth > tolerance;
    if instructions_regressed || memory_regressed {
        panic!(
            "gas regression in `{key}` (tolerance {tolerance}%):\n\
             \n  instructions: {} -> {} ({:+.1}%)\n\
             \n  memory:       {} -> {} bytes ({:+.1}%)\n\
             \nIf the cost change is intentional, update the baseline with:\n\
             \n    UPDATE_GAS_BASELINES=1 cargo test -p <contract> --test <suite>\n\
             \nand explain the increase in the PR (see smart-contracts/docs/gas_costs.md).",
            baseline.instructions,
            current.instructions,
            instructions_growth,
            baseline.memory_bytes,
            current.memory_bytes,
            memory_growth,
        );
    }
}
