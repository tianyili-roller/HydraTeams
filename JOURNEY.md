# Building HydraTeams: Making Claude Code Agent Teams Model-Agnostic

> How a translation proxy turned Claude Code's multi-agent system into a model-agnostic powerhouse — in ~700 lines of TypeScript.

## The Problem

Claude Code Agent Teams shipped on February 5, 2026 with Opus 4.6. It's the most capable multi-agent coding system available: a lead agent spawns teammates, each teammate is a full Claude Code instance with 15+ tools (Read, Write, Edit, Bash, Glob, Grep, Git, etc.), file-based coordination, task dependency graphs, messaging, plan approval, and graceful shutdown.

There's just one problem: **every agent must be Claude.**

Your lead runs Claude Opus at $15/M tokens. Your researcher runs Claude Sonnet. Your code reviewer runs Claude Sonnet. Your test writer runs Claude Sonnet. A 4-agent team working on a refactor can easily burn $5-10 in a single session.

But not every task needs a frontier model. A test writer doesn't need Opus-level reasoning. A file searcher doesn't need Sonnet's nuance. GPT-4o-mini at $0.15/M tokens could handle half these tasks just fine.

**What if we could keep the lead on Claude Opus and swap the teammates' brains to cheaper models — without losing any of Claude Code's tooling?**

## The Insight: Don't Build — Redirect

The first instinct was wrong. I designed a full custom agent framework: Agent Runtime, Universal Tool System, Provider Adapters, Coordination Layer, Spawner. ~2000+ lines of code, reinventing everything Claude Code already does.

Then the lightbulb: **Claude Code is already the perfect agent runtime. We don't need to rebuild it. We just need to change where it sends its API calls.**

Every Claude Code teammate process communicates with its LLM through one endpoint: `POST /v1/messages` (the Anthropic Messages API). It sends tool definitions, message history, and system prompts. It expects back SSE-streamed responses with text and tool_use blocks.

The teammate never validates *who* is on the other end. It doesn't check if the responses actually come from Claude. It just sends Anthropic-format requests and executes whatever tool calls come back.

The hook: `ANTHROPIC_BASE_URL`. One environment variable. Set it to `http://localhost:3456`, and every API call goes to your proxy instead of Anthropic.

Confirmed with a manual test — when pointed at `localhost:9999` (nothing listening), Claude Code hung waiting for connection. It respects the override completely.

**Architecture pivot: from ~2000 lines of custom framework to ~700 lines of translation proxy.**

```
┌─────────────────────┐
│   Lead Agent        │    Real Claude Opus (passthrough)
│   (Claude Opus)     │
└──────────┬──────────┘
           │
           │  ANTHROPIC_BASE_URL=http://localhost:3456
           │
┌──────────▼──────────┐
│  Teammate Process   │    Full Claude Code instance
│  (Claude Code CLI)  │    15+ tools, file access, bash
│  All tools work     │    Thinks it's calling Anthropic...
└──────────┬──────────┘
           │
           │  POST /v1/messages (Anthropic format)
           │
┌──────────▼──────────┐
│    HydraProxy       │    Translates API formats
│    localhost:3456    │    Anthropic ↔ OpenAI/ChatGPT
└──────────┬──────────┘
           │
           │  POST /v1/chat/completions (OpenAI)
           │  — or —
           │  POST chatgpt.com/backend-api/codex/responses
           │
┌──────────▼──────────┐
│   GPT-5.3 Codex     │    Any model, any provider
│   (or Gemini, etc.) │    Zero cost via subscription
└─────────────────────┘
```

## The Translation Layer

Two APIs that do the same thing, formatted differently. The proxy sits in the middle and translates in real-time.

### Request Translation (Anthropic → OpenAI)

| Anthropic Messages API | OpenAI Chat Completions |
|---|---|
| `system: "You are..."` (top-level field) | `messages[0]: { role: "system", content: "..." }` |
| `tools: [{ name, input_schema }]` | `tools: [{ type: "function", function: { name, parameters } }]` |
| `tool_use` content block | `tool_calls` array on assistant message |
| `tool_result` in user message | Separate `{ role: "tool" }` message |
| `tool_choice: { type: "auto" }` | `tool_choice: "auto"` |

### SSE Stream Translation (the hard part)

Both APIs stream via Server-Sent Events, but the event structure is completely different.

**OpenAI streams like this:**
```
data: {"choices":[{"delta":{"content":"Hello "}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"Read"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"file"}}]}}]}
data: [DONE]
```

**Claude Code expects this:**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","role":"assistant","model":"claude-sonnet-4-5-20250929"}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_123","name":"Read"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}

event: message_stop
data: {"type":"message_stop"}
```

The proxy maintains a state machine that tracks block indexes, active tool calls, and whether a text block has been started. It translates each OpenAI chunk into the corresponding Anthropic event(s) and writes them to the response stream.

### Model Name Spoofing

Claude Code validates model names internally. If the response says `model: "gpt-4o"`, it might reject it. So the proxy reports a valid Claude model name: `claude-sonnet-4-5-20250929`. The teammate thinks it's talking to Claude. It's not.

## The Debugging Gauntlet

The architecture was clean. Reality was messier.

### Bug 1: Query Parameters

Claude Code sends `POST /v1/messages?beta=true`. The proxy matched on exact URL path `"/v1/messages"`. No match. Zero requests got through.

**Fix:** Strip query params before route matching.

### Bug 2: Token Counting

Claude Code sends 10+ `POST /v1/messages/count_tokens` requests on startup. The proxy returned 404 for all of them.

**Fix:** Add handler returning estimated token counts (message length / 4).

### Bug 3: max_tokens Overflow

Claude Code requests `max_tokens: 32000`. GPT-4o caps at 16384. OpenAI returned 400.

**Fix:** Model-specific max_tokens lookup table with clamping.

### Bug 4: Non-Streaming Warmup

Claude Code sends a haiku warmup request with `stream: undefined` (not `false`, not `true`). The proxy always set `stream: true`. The non-streaming response format is completely different from SSE.

**Fix:** Detect `stream !== false` as streaming, handle non-streaming responses with direct JSON translation.

### Bug 5: Rate Limits

Two teammates running GPT-4o-mini simultaneously blew through the 200K TPM limit in seconds. Every request after that got 429'd.

**Fix:** Retry logic with exponential backoff — 5 retries, 1s/2s/4s/8s/10s delays.

### The First Success

After fixing all five bugs:

```bash
$ ANTHROPIC_BASE_URL=http://localhost:3456 claude --print "what model are you?"
```

Response: *"I am Claude, an AI model developed by Anthropic..."*

GPT-4o, pretending to be Claude, running through the full Claude Code pipeline. It even maintained the persona from Claude Code's system prompt. But ask it about DALL-E and the mask slips — the GPT personality leaks through.

Then the real test: **full agentic tool loops.** A teammate spawned through the proxy successfully used Glob and Read tools across 4 round trips with 31 tool definitions. It searched files, read code, and reported back to the lead. GPT-4o-mini doing Claude Code's job.

## Mixed Teams: The Lead/Teammate Routing Problem

The next challenge: keep the lead on real Claude Opus (subscription auth, no API key needed) while routing only teammates through the proxy.

**Problem:** All Claude Code processes — lead and teammates — have `ANTHROPIC_BASE_URL` set. They ALL hit the proxy. How does the proxy know which is the lead (passthrough to real Anthropic) and which is a teammate (translate to GPT)?

### Approach 1: Model Name (Failed)

Route based on `model` field. Lead requests `claude-opus-4-6`, teammates request `claude-sonnet-4-5`. Problem: teammates ALSO request `claude-opus-4-6` sometimes. Unreliable.

### Approach 2: Tool Count Heuristic (Fragile)

The lead has 31 tools (Claude Code's 15+ plus MCP tools). Teammates have 23. Route on count >= 28.

This actually worked — until the realization that MCP server configuration changes the tool count. One extra MCP tool and the heuristic breaks.

### Approach 3: System Prompt Marker (Winner)

Add a hidden marker to `CLAUDE.md`: `<!-- hydra:lead -->`. Claude Code injects CLAUDE.md into the system prompt. The proxy checks the system prompt for the marker. Found → passthrough to real Anthropic. Not found → translate to GPT.

```markdown
# CLAUDE.md
<!-- hydra:lead -->

This file provides guidance to Claude Code...
```

The proxy checks both the `system` field and the first 3 messages (CLAUDE.md content can appear in either). Teammates don't get the CLAUDE.md from the main project — they get their own system prompt without the marker.

**Result:** Lead sessions passthrough with full subscription auth header relay (no API key needed). Teammate sessions get translated. Clean routing with zero false positives.

## The Subscription Hack: Zero-Cost Teammates

The proxy worked with OpenAI API keys. But API keys cost money. The user already pays for ChatGPT Plus ($20/month) and Claude Pro. Can we use those subscriptions instead?

### Discovery: The ChatGPT Backend API

OpenAI's Codex CLI authenticates via `~/.codex/auth.json` — an OAuth token that works with ChatGPT's backend API, not the standard OpenAI API. The endpoint:

```
POST https://chatgpt.com/backend-api/codex/responses
```

This uses the **Responses API** format — different from both Chat Completions and the standard OpenAI API. Auth is a Bearer token plus a `Chatgpt-Account-Id` header extracted from the JWT's custom claims.

### Available Subscription Models

Tested every model name. Found 9+ working models on ChatGPT Plus at zero additional cost:

| Model | Type |
|---|---|
| `gpt-5-codex` | Full |
| `gpt-5.1-codex` | Full |
| `gpt-5.2-codex` | Full |
| `gpt-5.3-codex` | Full (latest) |
| `gpt-5-codex-mini` | Mini |
| `gpt-5.1-codex-mini` | Mini |
| `gpt-5` | Base |
| `gpt-5.1` | Base |
| `gpt-5.2` | Base |

### Building the Second Translator

The Responses API has its own format — different from Chat Completions. A second translation layer was needed:

**Request:** Anthropic → Responses API
- `system` → `instructions`
- `messages` → `input` array (with `function_call` and `function_call_output` items instead of `tool_calls`/`tool` messages)
- `tools` → same wrapping but slightly different structure
- Must include `store: false` and `stream: true`
- Cannot include `max_output_tokens` or `temperature` (backend rejects them)

**Response:** Responses API SSE → Anthropic SSE
- `response.created` → `message_start`
- `response.content_part.added` → `content_block_start`
- `response.output_text.delta` → `content_block_delta` (text_delta)
- `response.function_call_arguments.delta` → `content_block_delta` (input_json_delta)
- `response.completed` → `message_delta` + `message_stop`

### Auto-Auth

The proxy reads `~/.codex/auth.json` automatically, decodes the JWT, and extracts the `chatgpt_account_id` from the custom claim at `https://api.openai.com/auth`. No manual configuration needed — just `codex --login` once and the proxy handles the rest.

```bash
# Start proxy with ChatGPT subscription
node dist/index.js --model gpt-5.3-codex --provider chatgpt --port 3456 --passthrough lead
```

**Result:** Claude Code teammates powered by GPT-5.3-codex through a ChatGPT Plus subscription. The lead runs on Claude Opus through the user's Claude subscription. Total additional API cost: **$0.**

## The Final Architecture

```
src/
├── index.ts                    39 lines   Entry point, ASCII banner
├── proxy.ts                   297 lines   HTTP server, routing, passthrough
├── config.ts                   93 lines   CLI args, env vars, codex auth
└── translators/
    ├── types.ts               192 lines   TypeScript interfaces (both APIs)
    ├── request.ts              93 lines   Anthropic → OpenAI Chat Completions
    ├── messages.ts            117 lines   Message history translation
    ├── response.ts            231 lines   OpenAI SSE → Anthropic SSE
    ├── request-responses.ts   209 lines   Anthropic → Responses API
    └── response-responses.ts  345 lines   Responses API SSE → Anthropic SSE
                               ─────────
                               ~1,616 lines total
```

Three routing paths:
1. **Passthrough** — Lead requests (detected by `hydra:lead` marker) → forwarded to real Anthropic API with original subscription auth headers
2. **OpenAI Chat Completions** — Teammate requests → translated to `/v1/chat/completions` (API key auth)
3. **ChatGPT Backend** — Teammate requests → translated to `chatgpt.com/backend-api/codex/responses` (subscription auth)

Features:
- System prompt marker routing (`<!-- hydra:lead -->` in CLAUDE.md)
- Subscription auth relay (no API keys needed for lead passthrough)
- Auto codex auth loading from `~/.codex/auth.json` with JWT decoding
- Model name spoofing (reports `claude-sonnet-4-5-20250929` to Claude Code)
- Token count estimation for `/v1/messages/count_tokens`
- Non-streaming response handling (haiku warmup requests)
- Retry with exponential backoff on 429 rate limits
- Query parameter stripping for route matching

## What This Proves

1. **Existing agent frameworks are undervalued infrastructure.** Claude Code Agent Teams is a complete multi-agent system. Building another one from scratch is a waste. Extending it through protocol translation is 10x more efficient.

2. **API translation is a powerful pattern.** The difference between "Claude-only" and "any model" was ~1,600 lines of TypeScript. Not a framework rewrite — a format conversion.

3. **Subscriptions are underutilized.** ChatGPT Plus users have access to GPT-5.3-codex through the backend API. Most people don't know this. The proxy turns a $20/month subscription into unlimited multi-agent compute.

4. **The best abstraction is no abstraction.** The proxy doesn't abstract away Claude Code. It doesn't wrap it, extend it, or replace any part of it. It just translates the wire protocol. Every tool, every capability, every coordination feature works unchanged.

## Tech Stack

- **TypeScript** — strict mode, zero external dependencies
- **Node.js** — native `http` server, `fetch` API, `ReadableStream`
- **SSE** — hand-rolled parser and emitter (no libraries)
- Zero runtime dependencies. Only `typescript` and `@types/node` as dev dependencies.

## Status

- OpenAI Chat Completions translation: **Working** (tested with GPT-4o, GPT-4o-mini)
- ChatGPT Backend (Responses API) translation: **Working** (tested with GPT-5.3-codex)
- Mixed team routing (lead passthrough + teammate translation): **Working**
- Subscription-based auth (zero API cost): **Working**
- Full agentic tool loops (Read, Write, Glob, Bash): **Verified**

---

*Built in one day. From architecture pivot to working proxy — designed, debugged, extended with subscription support, and tested end-to-end.*

*HydraTeams is part of the [Hydra ecosystem](https://github.com/Pickle-Pixel/HydraMCP) — tools for multi-model AI orchestration.*
