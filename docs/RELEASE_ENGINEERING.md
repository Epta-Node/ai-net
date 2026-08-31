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

## Changelog Generation

The project uses [Conventional Commits](https://www.conventionalcommits.org/)
for automatic changelog entries. Each release includes a `CHANGELOG.md` update
with sections:

- **Features** — new functionality (`feat:`)
- **Bug Fixes** — resolved issues (`fix:`)
- **Breaking Changes** — backward-incompatible changes (`feat!:` or `BREAKING CHANGE:`)
- **Other Changes** — docs, chores, refactors, tests

### Generate changelog since last tag

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
- [ ] `CHANGELOG.md` updated with release notes
- [ ] Version bumped in relevant files (package.json, Cargo.toml, etc.)

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

### 5. Tag & Release

- [ ] Create annotated tag: `git tag -a v<VERSION> -m "Release v<VERSION>"`
- [ ] Push tag: `git push origin v<VERSION>`
- [ ] Create GitHub Release with changelog notes
- [ ] Attach Wasm artifacts and SHA256SUMS to release

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

# Verify
./scripts/verify.sh --network mainnet
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
