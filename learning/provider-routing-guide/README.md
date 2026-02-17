# Provider Routing Guide — ChatGPT vs OpenAI API

> **Date**: 2026-02-17
> **Scope**: How the proxy routes requests to different OpenAI backends, known gotchas with frontier models, and proposed fixes

---

## 1. Two Providers, Two APIs

The proxy supports two distinct OpenAI backends, selected at **startup time** via the `--provider` flag:

| Flag | Backend | API | Endpoint |
|------|---------|-----|----------|
| `--provider chatgpt` | ChatGPT Backend | Responses API | `chatgpt.com/backend-api/codex/responses` |
| `--provider openai` | OpenAI API | Chat Completions API | `api.openai.com/v1/chat/completions` |

### ChatGPT Backend (`--provider chatgpt`)

Uses your **ChatGPT Plus/Pro subscription** via the backend Responses API. Auth is auto-read from `~/.codex/auth.json` (run `codex --login` first).

Available models: `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.2-codex`, `gpt-5.3-codex`, `gpt-5-codex-mini`, `gpt-5.1-codex-mini`

### OpenAI API (`--provider openai`)

Standard OpenAI **Chat Completions API**. Requires `OPENAI_API_KEY` env var or codex auth fallback.

Available models: `gpt-4o`, `gpt-4o-mini`, `o3-mini`, etc.

---

## 2. The Routing Decision — It's a Startup-Time Switch

There is **no per-request or per-model routing**. The provider is decided once at startup:

```typescript
// config.ts — provider comes from CLI flag or env var
const targetProvider = getArg("--provider")
  || process.env.HYDRA_TARGET_PROVIDER
  || "openai";  // default
```

Then in the request handler, a single `if` branch decides the entire code path:

```typescript
// proxy.ts:191 — the routing decision
if (config.targetProvider === "chatgpt") {
  // ─── ChatGPT Backend (Responses API) ───
  const responsesReq = translateRequestToResponses(anthropicReq, config.targetModel);
  // ...fetch to chatgpt.com/backend-api/codex/responses
} else {
  // ─── OpenAI Chat Completions ───
  const openaiReq = translateRequest(anthropicReq, config.targetModel);
  // ...fetch to api.openai.com/v1/chat/completions
}
```

**Every** request goes through the same path. You cannot mix providers within a single proxy instance.

---

## 3. Gotcha #1 — `max_tokens` vs `max_completion_tokens`

### The Problem

OpenAI's newer frontier models (GPT-5.x, o-series) **reject the legacy `max_tokens` parameter** and require `max_completion_tokens` instead. When using `--provider openai` with these models, the proxy sends `max_tokens` and you get:

```json
{
  "error": {
    "message": "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    "type": "invalid_request_error",
    "param": "max_tokens",
    "code": "unsupported_parameter"
  }
}
```

### Where It Happens

In `src/translators/request.ts`, the Chat Completions translator always sends `max_tokens`:

```typescript
// request.ts:18-33
const MAX_OUTPUT_TOKENS: Record<string, number> = {
  "gpt-4o": 16384,
  "gpt-4o-mini": 16384,
  "gpt-4-turbo": 4096,
  "o3-mini": 16384,
};
const maxTokens = Math.min(
  req.max_tokens || 4096,
  MAX_OUTPUT_TOKENS[targetModel] || 16384
);

const result: OpenAIRequest = {
  model: targetModel,
  max_tokens: maxTokens,  // ← always uses legacy field name
  // ...
};
```

### Why the Responses API Avoids This

The Responses API translator (`request-responses.ts`) **never sends `max_tokens` at all** — the Responses API handles output limits differently, so this error simply cannot occur on the `--provider chatgpt` path.

---

## 4. Note on Model Names — Short Aliases Work Fine

Short model names like `gpt-5.2` or `gpt-5-mini` work correctly — no need to specify the full versioned name (e.g. `gpt-5.2-2025-12-11`). OpenAI resolves these aliases on their end.

The proxy passes `config.targetModel` straight through to the API with no name resolution:

```typescript
// Both paths pass model name as-is:
// request.ts:31
model: targetModel,

// request-responses.ts:71
model: targetModel,
```

Either short or full names work on both providers.

---

## 5. Summary — Which Provider Has Which Issues?

| Issue | `--provider openai` (Chat Completions) | `--provider chatgpt` (Responses API) |
|-------|---------------------------------------|--------------------------------------|
| `max_tokens` rejected by frontier models | **Affected** | Not affected (param not sent) |
| Model name aliases (e.g. `gpt-5-mini`) | Work fine | Work fine |

---

## 6. Proposed Fix — Make Frontier Models Work on Chat Completions

The fix is straightforward: use `max_completion_tokens` instead of `max_tokens` for models that require it. A model allowlist approach:

```typescript
// request.ts — proposed change

// Models that require the new parameter name
const USES_MAX_COMPLETION_TOKENS = new Set([
  "o3-mini",
  // Add frontier models and any model with a version suffix from 2025+
]);

function needsNewTokenParam(model: string): boolean {
  if (USES_MAX_COMPLETION_TOKENS.has(model)) return true;
  // Heuristic: any model name containing a date suffix (YYYY-MM-DD)
  // from GPT-5 family likely needs it
  if (/^(gpt-5|o[1-9])/.test(model)) return true;
  return false;
}

// Then in translateRequest():
if (needsNewTokenParam(targetModel)) {
  result.max_completion_tokens = maxTokens;
} else {
  result.max_tokens = maxTokens;
}
```

This is a minimal change — a single branching point in the request translator. The `OpenAIRequest` type would need `max_completion_tokens` added as an optional field.

Alternatively, a simpler brute-force approach: **always send `max_completion_tokens`** and drop `max_tokens` entirely. Newer OpenAI models all support `max_completion_tokens`, and older ones that only understand `max_tokens` are being deprecated. This is the lower-maintenance option if you don't need to support legacy models.
