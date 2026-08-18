# E2E Integration Testing Documentation

This document describes how to execute, extend, and maintain End-to-End (E2E) integration tests covering the Backend, Smart Contracts, Coordinator, and Stellar Network layers.

---

## Overview

The `ai-net` E2E test framework tests cross-cutting workflows end-to-end:
1. **Frontend / API layer**: Route handlers, parameter validation, request authentication.
2. **Backend Engine**: Database queries (SQLite), DAG task decomposition, event streaming.
3. **Coordinator**: Agent discovery and capability-based assignment.
4. **Smart Contracts**: Soroban `AgentRegistryContract` and `error-resolver` contracts.

---

## Running the E2E Suite

### Command Line
```bash
npm run test:e2e
```

### Coverage Generation
```bash
npm run test:e2e:coverage
```

Output is generated under `coverage-e2e/`.

---

## Docker Compose Infrastructure

`tests/e2e/docker-compose.test.yml` provisions:
- `stellar-standalone`: Local Stellar quickstart image with Soroban RPC enabled.
- `ai-net-backend`: Backend container running in test mode connected to the local Soroban node.

To launch standalone services manually:
```bash
docker-compose -f tests/e2e/docker-compose.test.yml up -d
```

---

## CI/CD Pipeline

E2E integration tests are automatically executed in GitHub Actions on push to `main` branch or on Pull Requests via `.github/workflows/ci.yml`. Coverage reports are uploaded as build artifacts.
