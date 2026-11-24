# Release Engineering Guide

This document covers the release process for ai-net across backend, frontend,
and smart-contract tracks.

---

## Semantic Versioning

ai-net follows [SemVer 2.0.0](https://semver.org/):

- **MAJOR** — Breaking changes to APIs, contract interfaces, or storage layouts.
- **MINOR** — New features, backward-compatible.
- **PATCH** — Bug fixes, backward-compatible.

Smart contracts use SemVer on the `stellar-cli` deploy metadata. The on-chain
contract name stays the same; the version is recorded in deployment JSON.

---

## Tagging Convention

Tags follow the pattern `v<MAJOR>.<MINOR>.<PATCH>`:

```bash
git tag -a v1.2.3 -m "Release v1.2.3"
git push origin v1.2.3
```

Use annotated tags (`-a`) so the tag message is stored. Tags are immutable
once pushed.

---

## Automated Release Pipeline

Tagging a release triggers the fully automated release workflow defined in
`.github/workflows/release.yml`. The workflow:

1. **Builds** all Soroban WASM artefacts (`cargo build --target wasm32-unknown-unknown --release`).
2. **Signs** each WASM file by generating a SHA-256 sidecar (`.wasm.sha256`).
3. **Generates** a changelog from Conventional Commits using [git-cliff](https://git-cliff.org/) and the `cliff.toml` configuration at the repo root.
4. **Creates** a GitHub Release with the generated changelog as the description and all WASM / SHA-256 files attached.

### To cut a release

```bash
# 1. Complete the pre-release checklist below
# 2. Create an annotated tag
git tag -a v1.2.3 -m "Release v1.2.3"
# 3. Push the tag — the release workflow fires automatically
git push origin v1.2.3
```

That's it. No manual changelog editing, no manual file uploads.

### Customising cliff.toml

`cliff.toml` in the repo root controls changelog grouping and formatting:

| Setting | Purpose |
|---|---|
| `commit_parsers` | Maps commit prefix to changelog section (e.g. `feat` → Features) |
| `filter_commits = true` | Drops commits that match no parser (e.g. `chore`, `ci`) |
| `tag_pattern` | Only tags matching `v*.*.*` trigger a changelog entry |
| `[remote.github]` | Links PR numbers in the changelog to GitHub pull requests |

Edit `cliff.toml` and push — the next tag picks up the change automatically.

## Changelog Generation (manual fallback)

If the automated pipeline is unavailable, generate the changelog manually:

```bash
LAST_TAG=$(git describe --tags --abbrev=0)
git log ${LAST_TAG}..HEAD --pretty=format:"- %s (%h)" --no-merges
```

Add the output under the appropriate section in `CHANGELOG.md`.

---

## Release Checklist

### 1. Pre-release

- [ ] All CI checks passing on `main`
- [ ] No open critical/blocking issues tagged for this release
- [ ] Run the unified quality gate: `npm run gate` — must pass with zero errors
- [ ] Verify gas baselines have not regressed: `cd smart-contracts && cargo test -- --nocapture 2>&1 | grep gas`
- [ ] Version bumped in relevant files (`package.json`, `Cargo.toml`)
- [ ] `CHANGELOG.md` heading updated if a manual entry is needed (automated pipeline handles this on tag push)

### 2. Backend

- [ ] `cd backend && npm run lint && npm test`
- [ ] Build production bundle: `npm run build`
- [ ] Verify no secrets in build output

### 3. Frontend

- [ ] `cd frontend && npm run lint && npm run build`
- [ ] Verify no secrets in build output

### 4. Smart Contracts

- [ ] `cd smart-contracts && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- [ ] Build Wasm artifacts: `cargo build --target wasm32-unknown-unknown --release`
- [ ] Generate SHA256 checksums for all `.wasm` files

### 5. Tag & Release (automated)

- [ ] Create annotated tag: `git tag -a v<VERSION> -m "Release v<VERSION>"`
- [ ] Push tag: `git push origin v<VERSION>`
- [ ] Confirm the `Release` GitHub Actions workflow starts (Actions tab)
- [ ] Verify the GitHub Release is created with WASM artefacts and SHA-256 sidecars attached

### 6. Post-release

- [ ] Deploy contracts to testnet (verify)
- [ ] Deploy contracts to mainnet (if applicable)
- [ ] Update deployment JSON with new contract addresses
- [ ] Monitor for 24h after mainnet deploy

---

## Artifact Signing & Verification

### SHA256SUMS

Every release includes a `SHA256SUMS` file for integrity verification:

```bash
# Generate checksums for all Wasm artifacts
cd smart-contracts/contracts
find . -name "*.wasm" -exec sha256sum {} \; > SHA256SUMS

# Verify a downloaded artifact
sha256sum -c SHA256SUMS
```

### Wasm Artifact Verification

After downloading a release artifact:

```bash
# 1. Verify checksum
sha256sum -c SHA256SUMS

# 2. Verify the Wasm module has correct imports
stellar contract inspect <artifact.wasm>

# 3. Deploy and verify on testnet before mainnet
./scripts/deploy.sh --network testnet
./scripts/verify.sh --network testnet
```

---

## Contract Upgrade Coordination

When upgrading deployed contracts:

1. **Testnet first** — always deploy to testnet and run full E2E tests.
2. **Announce** — notify stakeholders at least 48h before mainnet upgrade.
3. **Upgrade via upgrade-manager** — use the `upgrade.sh` script with the
   upgrade-manager contract for safe upgrades with rollback window.
4. **Verify** — run `verify.sh` post-upgrade to confirm storage and state.
5. **Monitor** — watch metrics for 24h post-upgrade.

```bash
# Dry run
./scripts/upgrade.sh --network mainnet --dry-run

# Upgrade
./scripts/upgrade.sh --network mainnet --use-upgrade-manager agent-registry

# Verify (required after every mainnet deploy or upgrade)
./scripts/verify.sh --network mainnet --strict --json
```

---

## Release Tracks

| Track | Cadence | Artifacts |
|-------|---------|-----------|
| Smart Contracts | On-demand (after audit or feature milestone) | `.wasm` files, SHA256SUMS |
| Backend | Bi-weekly or on critical fix | Docker image, npm package |
| Frontend | Bi-weekly or on critical fix | Static build, Docker image |

All tracks share the same SemVer and tagging convention. A single git tag
covers all tracks for a given version.
