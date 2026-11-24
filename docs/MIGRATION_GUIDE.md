# Migration & Backward-Compatibility Guide

This guide helps API consumers and event subscribers upgrade safely when ai-net introduces breaking changes. It covers versioning policy, deprecation timelines, event-schema evolution, and a worked end-to-end migration example.

---

## 1. API Versioning Policy

### URL-Based Versioning

All REST endpoints are prefixed with a version path segment:

```
https://api.testnet.ai-net.epta-node.io/v1/agents
```

- **Current stable version:** `v1`
- New versions are introduced only for **breaking changes** (field removals, type changes, endpoint removals).
- **Non-breaking additions** (new optional fields, new endpoints) are added to the current version without a new prefix.

### Stability Guarantees

| Change Type | Version Impact | Consumer Action |
|---|---|---|
| New optional response field | None (backward-compatible) | No change required |
| New endpoint | None | Adopt at your discretion |
| Renamed field | New version | Update client code |
| Removed field | New version | Update client code |
| Changed field type | New version | Update client code |
| Changed authentication scheme | New version | Update auth flow |

### Version Lifecycle

1. **Announcement:** New version announced in release notes and this guide at least **30 days** before launch.
2. **Deprecation window:** Previous version remains operational for **90 days** after the new version launches.
3. **Sunset:** Deprecated version returns `410 Gone` with a `Sunset` header pointing to the migration guide.

---

## 2. Deprecation Calendar

When a breaking change is planned, a deprecation notice is published:

```json
{
  "deprecated": true,
  "sunset_date": "2026-12-01",
  "migration_guide": "https://github.com/Epta-Node/ai-net/blob/main/docs/MIGRATION_GUIDE.md",
  "replacement": "/v2/agents"
}
```

Consumers should monitor the `Deprecation` and `Sunset` HTTP headers on all API responses.

---

## 3. Event Schema Migration

On-chain Soroban events and backend event-store entries may evolve. The following rules ensure backward compatibility:

### Additive Changes (No Migration Required)

- New fields added to event data structs
- New event topic values
- New event types alongside existing ones

### Breaking Changes (Migration Required)

- Removing fields from event data structs
- Renaming event topic symbols
- Changing field types in event data

### Consumer Best Practices

1. **Ignore unknown fields** — always deserialize event data with `#[serde(default)]` or equivalent.
2. **Filter by topic** — subscribe to specific event topics rather than consuming all events.
3. **Version check** — include the contract version in your event-processing pipeline.

### Event Schema Reference

See [`smart-contracts/docs/events.md`](../smart-contracts/docs/events.md) for the current event schema catalog.

---

## 4. Worked Example: Upgrading an SDK Integration

### Scenario

You have a TypeScript client that calls `POST /v1/agents` to register agents. The v2 API changes the `capability` field from a string to an enum array.

**Before (v1):**
```json
{
  "name": "ResearchBot",
  "capability": "research",
  "owner": "G...",
  "price": 100
}
```

**After (v2):**
```json
{
  "name": "ResearchBot",
  "capabilities": ["research"],
  "owner": "G...",
  "price": 100
}
```

### Step 1: Check the Deprecation Header

```bash
curl -s -D- http://localhost:3000/v1/agents \
  -H "Authorization: Bearer $TOKEN" | head -20
```

Look for:
```
Deprecation: true
Sunset: 2026-12-01
Link: <../docs/MIGRATION_GUIDE.md>; rel="sunset"
```

### Step 2: Update Your Client Code

```typescript
// Before (v1)
const registerAgent = (name: string, capability: string) =>
  fetch('/v1/agents', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ name, capability, owner, price }),
  });

// After (v2)
const registerAgent = (name: string, capabilities: string[]) =>
  fetch('/v2/agents', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ name, capabilities, owner, price }),
  });
```

### Step 3: Update Event Subscribers

```typescript
// Before: single string
event.data.capability // "research"

// After: array
event.data.capabilities // ["research"]
```

### Step 4: Test Against the New Version

```bash
# Run your test suite against v2 endpoints
npm test -- --base-url=http://localhost:3000/v2
```

### Step 5: Deploy and Monitor

- Deploy updated client.
- Monitor for `410 Gone` responses (indicates you're still hitting a sunset endpoint).
- Remove v1 client code after the deprecation window closes.

---

## 5. Smart Contract Storage Migration

For on-chain contract upgrades, see [`smart-contracts/docs/STORAGE_MIGRATION.md`](../smart-contracts/docs/STORAGE_MIGRATION.md) for storage layout compatibility rules, migration strategies, and rollback procedures.

---

## 6. References

- [REST API Reference](./API_REFERENCE.md) — current endpoint schemas and error codes
- [On-Chain Events](../smart-contracts/docs/events.md) — Soroban event catalog
- [Storage Migration](../smart-contracts/docs/STORAGE_MIGRATION.md) — contract storage upgrade procedures
- [Upgrade Guide](../smart-contracts/docs/UPGRADE_GUIDE.md) — contract upgrade mechanics
