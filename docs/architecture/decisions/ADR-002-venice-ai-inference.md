# ADR-002: Use Venice AI for LLM Inference

**Status:** Accepted
**Date:** 2026-06-11
**Deciders:** @Epta-Node/core

## Context

ai-net's coordinator and specialized agents require access to a large language
model (LLM) to plan tasks, generate outputs, and score quality. The primary
candidates evaluated were OpenAI (GPT-4o), Anthropic (Claude), and Venice AI.

Key constraints:
- **Privacy**: task content may include proprietary user data that must not be
  retained by a third-party provider.
- **Self-hosting option**: contributors should be able to run the full stack
  locally without cloud credentials.
- **Cost**: the system issues many small inference calls per task; token costs
  must remain predictable.
- **API compatibility**: the inference client should be swappable with minimal
  code changes.

## Decision

Use **Venice AI** as the default LLM inference provider, accessed via the
Venice AI REST API (OpenAI-compatible endpoint). The Venice AI client
configuration lives in `backend/src/config/venice.ts`.

Reasons:
1. **No data retention by default**: Venice AI does not log or retain user
   prompts, which is important for task privacy.
2. **OpenAI-compatible API**: the `openai` npm SDK can target Venice AI by
   overriding `baseURL`, enabling a one-line swap to GPT-4o or other providers
   for contributors who prefer them.
3. **Self-hosting path**: Venice AI supports self-hosted deployments, allowing
   a fully air-gapped ai-net instance.
4. **Cost**: Venice AI pricing is competitive for high-frequency short-context
   calls typical in coordinator decomposition.

OpenAI/Anthropic were not chosen as defaults because both providers retain
prompts for safety monitoring by default, which conflicts with the privacy
requirement.

## Consequences

**Positive:**
- Prompt/task data is not retained by the inference provider.
- The OpenAI-compatible adapter means switching providers requires changing
  only `VENICE_API_KEY` → provider key and `baseURL` in config.
- Contributors can use the official Venice AI free tier for development.

**Negative / trade-offs:**
- Venice AI is less widely known than OpenAI; contributors may need to create
  an account specifically for ai-net development.
- Model capability and availability may lag behind frontier OpenAI/Anthropic
  releases.
- No function-calling support parity guarantee; tool-use schemas may need
  validation on Venice AI model updates.
