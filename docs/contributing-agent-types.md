# Contributing a new agent type

New agent types should be small, capability-focused workers that can be
discovered and dispatched by the coordinator. This checklist keeps a new type
compatible with the registry, queue, API, and payment flows.

## 1. Define the capability contract

Choose a stable lowercase capability name (for example `research` or
`risk`). Document the input and output shape, expected latency, maximum prompt
size, and failure modes. Do not add a capability that is only understood by a
single private worker.

The worker must accept the shared `TaskAssignment` shape and return a
structured result. Include a version field when introducing a result schema so
consumers can evolve safely.

## 2. Implement the worker

1. Add the worker under `backend/src/agents/<capability>/`.
2. Implement the common agent interface and keep model/provider calls behind
   the existing Venice client and circuit breaker.
3. Validate input before invoking an external model.
4. Return typed success and error results; never expose provider keys or raw
   prompts in logs.
5. Make retries safe. A result submission must include the task/node
   `Idempotency-Key` so a retry cannot create a second payment or event.

## 3. Register and dispatch it

Add the capability to the registry schema and coordinator capability map. Keep
the name in sync across the contract metadata, backend validation, and API
documentation. Add a fixture agent with a testnet-safe endpoint for tests;
never commit a private key.

## 4. Test the full contract

Add tests for:

- input validation and malformed model output;
- coordinator selection when the capability is available or unavailable;
- timeout, retry, and circuit-breaker behavior;
- duplicate result delivery with the same idempotency key;
- authorization and ownership of the resulting task and payment;
- the happy path from assignment through escrow release.

Run `npm run gate` before opening a pull request. If the worker changes a
Soroban interface, also run the smart-contract formatting, lint, and test
commands from [CONTRIBUTING.md](../CONTRIBUTING.md).

## Pull request checklist

- [ ] Capability name, schema, and operational limits are documented.
- [ ] Backend unit and integration tests cover success and failure paths.
- [ ] No credentials, production endpoints, or unbounded storage are added.
- [ ] API reference and glossary entries are updated when public behavior changes.
- [ ] The PR explains how the agent is monitored, retried, and paid.
