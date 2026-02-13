# Security Audit & Hardening Guide

> **Last audited:** 2026-02-13
> **Auditors:** Claude Opus 4.6 (code integrity), Codex (operational security)
> **Scope:** Full repository — all source files, dependencies, git history, runtime behavior

This document is the source of truth for HydraTeams security. All contributors and operators should read this before running or modifying the proxy.

---

## 1. Code Integrity Assessment

### 1.1 Dependency Surface

| Category | Count | Details |
|---|---|---|
| Runtime dependencies | **0** | No external packages at runtime |
| Dev dependencies | **2** | `typescript@5.9.3`, `@types/node@25.2.2` |
| npm lifecycle hooks | **0** | No `preinstall`, `postinstall`, `prepare`, or `prepublish` scripts |

The `package.json` defines only `build` (`tsc`), `start` (`node dist/index.js`), and `dev` (`tsc --watch`). There is nothing that executes automatically on `npm install`.

### 1.2 Dangerous API Usage

| Pattern | Found? | Details |
|---|---|---|
| `eval()` / `Function()` | No | — |
| `child_process` / `exec` / `spawn` | No | — |
| `require()` (dynamic) | No | All imports are static ESM |
| `__proto__` / prototype pollution | No | — |
| `WebSocket` / `Worker` / `cluster` | No | — |
| Non-printable / hidden Unicode chars | No | Verified via byte-level scan of `src/` |

### 1.3 File System Access

| Operation | Location | Target | Purpose |
|---|---|---|---|
| `readFileSync` | `src/config.ts:14` | `~/.codex/auth.json` | Read ChatGPT/Codex OAuth token |
| `mkdirSync` | `src/logger.ts:50` | `./logs/` | Create log directory |
| `readdirSync` + `unlinkSync` | `src/logger.ts:54-56` | `./logs/*.log` | Delete old logs on startup |
| `createWriteStream` | `src/logger.ts:211` | `./logs/<agent>.log` | Per-agent request logging |

No access to `.env`, `.ssh`, `.aws`, `.npmrc`, `.config`, or any other sensitive local files beyond `~/.codex/auth.json`.

### 1.4 Outbound Network Destinations

All `fetch()` calls go to exactly these destinations:

| URL | Location | When |
|---|---|---|
| `https://api.openai.com/v1/chat/completions` | `src/proxy.ts:9` | OpenAI provider requests |
| `https://chatgpt.com/backend-api/codex/responses` | `src/proxy.ts:10` | ChatGPT subscription requests |
| `https://api.anthropic.com/v1/messages` | `src/proxy.ts:11` | Passthrough to real Anthropic |
| User-supplied `--target-url` | `src/proxy.ts:238` | Local server mode (Ollama, llama.cpp) |

No telemetry, no analytics, no phone-home behavior.

### 1.5 Git History

| Commits | Branches | Deleted files | Active git hooks |
|---|---|---|---|
| 4 | 1 (`main`) | 0 | 0 (all `.sample` defaults) |

All commits are clean and match their stated descriptions. No files have been added and removed to hide content.

### 1.6 Prompt Injection in Documentation

All markdown files (README, JOURNEY, VISION, PRINCIPLES, ARCHITECTURE) were read in full. No hidden instructions, "ignore previous" patterns, encoded payloads, or invisible content found.

---

## 2. Operational Security Findings

These are real attack vectors that matter when running the proxy, ordered by severity.

### 2.1 HIGH: Unauthenticated Proxy on All Network Interfaces

**Location:** `src/index.ts:9`

```typescript
server.listen(config.port, () => { ... });
```

**Problem:** `server.listen(port)` without a host parameter binds to `0.0.0.0` (all interfaces) by default. The proxy has **zero authentication** on incoming requests (`src/proxy.ts:100`). Anyone on the same network who can reach the port can:

- Send requests through the proxy, consuming your paid API credits (OpenAI, ChatGPT, Anthropic)
- Use the passthrough path to make Anthropic API calls with your relayed auth headers
- Read proxy responses containing LLM output

**Mitigation:**
- Bind to localhost only: `server.listen(config.port, "127.0.0.1", () => { ... })`
- Add a shared-secret header check (e.g., require `X-Hydra-Token` on all requests)
- Use firewall rules to restrict access to the proxy port

### 2.2 HIGH: Prompt-Injection Route Bypass via `hydra:lead` Marker

**Location:** `src/proxy.ts:13-14`, `src/proxy.ts:144-166`

```typescript
const LEAD_MARKER = "hydra:lead";
// ...
const fullText = systemText + " " + msgText;
const hasMarker = fullText.includes(LEAD_MARKER);
```

**Problem:** The proxy decides whether to passthrough (to real Anthropic) or translate (to GPT) based on whether the string `hydra:lead` appears in the system prompt or first 3 messages. This is a **content-based routing decision on untrusted input**.

If a file being processed by a teammate happens to contain the string `hydra:lead` (e.g., a README referencing the proxy itself, or a maliciously crafted file), it could appear in the message history and trigger passthrough routing for a request that should have been translated.

**Impact:** Unintended passthrough could cause teammate requests to go to Anthropic instead of the target model, consuming Anthropic API credits and bypassing the intended routing logic.

**Mitigation:**
- Use a more unique, harder-to-collide marker (e.g., a UUID or HMAC-based token)
- Only check the `system` field, not message content (teammates don't receive CLAUDE.md system prompts, so checking messages is the less reliable path anyway)
- Use a structured metadata field instead of string-matching inside content

### 2.3 HIGH: Credential Exfiltration via Arbitrary `--target-url`

**Location:** `src/config.ts:41`, `src/proxy.ts:238-255`

```typescript
const openaiUrl = config.targetUrl || DEFAULT_OPENAI_URL;
// ...
if (config.openaiApiKey) headers["Authorization"] = `Bearer ${config.openaiApiKey}`;
upstream = await fetch(openaiUrl, { method: "POST", headers, body: ... });
```

**Problem:** The `--target-url` flag (or `HYDRA_TARGET_URL` env var) accepts any URL. The proxy then sends an `Authorization: Bearer <key>` header to that URL. The key can be sourced from:

- `OPENAI_API_KEY` environment variable
- `~/.codex/auth.json` OAuth token (fallback at `src/config.ts:72-74`)

If a user is tricked into setting a malicious `--target-url` or `HYDRA_TARGET_URL`, their API key or Codex session token is sent directly to the attacker's endpoint.

**Mitigation:**
- Validate `--target-url` against an allowlist of known-safe domains/localhost
- Warn on startup if `--target-url` points to a non-localhost, non-known-provider URL
- Skip the `Authorization` header when using `--target-url` unless explicitly opted in (local servers like Ollama/llama.cpp typically don't need auth)

### 2.4 HIGH: Auth Header Relay in Passthrough Mode

**Location:** `src/proxy.ts:46-57`

```typescript
const relayKeys = [
  "x-api-key", "authorization", "anthropic-version", "anthropic-beta",
  "cookie", "x-request-id",
];
```

**Problem:** The passthrough handler relays sensitive headers (`x-api-key`, `authorization`, `cookie`) to `api.anthropic.com`. While the destination is hardcoded to the legitimate Anthropic API, the relay of `cookie` headers is noteworthy — cookies are typically session-scoped and relaying them to a third-party API (even a legitimate one) should be a deliberate decision.

Combined with finding 2.1 (no auth on the proxy), an attacker on the network could send a crafted request that triggers passthrough, and the proxy would relay whatever auth headers came with the request to Anthropic. This is less of a direct leak (the attacker's own headers go to Anthropic, not the user's), but in scenarios where the proxy is behind a reverse proxy that injects auth headers, this could be exploited.

**Mitigation:**
- Remove `cookie` from the relay list unless specifically needed
- Only relay auth headers from requests that originate from localhost
- Add authentication to the proxy itself (see 2.1)

### 2.5 MEDIUM: No Request Body Size Limits

**Location:** `src/proxy.ts:31-37`

```typescript
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
```

**Problem:** The request body is buffered entirely in memory with no size limit. A malicious or buggy client can send an arbitrarily large request body, exhausting the proxy's memory.

**Mitigation:**
- Add a maximum body size check (e.g., 10MB) and reject requests exceeding it with a 413 status
- Destroy the request socket if the limit is exceeded

### 2.6 MEDIUM: No Upstream Fetch Timeouts

**Location:** `src/proxy.ts:59`, `src/proxy.ts:198`, `src/proxy.ts:251`

**Problem:** All upstream `fetch()` calls have no timeout or `AbortController`. If an upstream API hangs indefinitely, the proxy connection also hangs, tying up resources. Under sustained slow responses, this could exhaust available connections.

**Mitigation:**
- Use `AbortController` with a timeout signal on all `fetch()` calls (e.g., 120 seconds)
- Example: `const controller = new AbortController(); setTimeout(() => controller.abort(), 120000);`

### 2.7 LOW: Logs Deleted on Startup

**Location:** `src/logger.ts:52-58`

```typescript
for (const file of fs.readdirSync(this.logDir)) {
  if (file.endsWith(".log")) {
    fs.unlinkSync(path.join(this.logDir, file));
  }
}
```

**Problem:** All `.log` files in the `./logs/` directory are deleted every time the proxy starts. This destroys forensic traceability — if something suspicious happened in a previous session, the evidence is gone on next startup.

**Mitigation:**
- Rotate logs instead of deleting (e.g., rename to `<name>.<timestamp>.log`)
- Or archive old logs to a separate directory before clearing

### 2.8 LOW: Minor Information Leak in Console Output

**Location:** `src/config.ts:24`

```typescript
console.log(`Using codex auth from ~/.codex/auth.json (plan: ${authClaim.chatgpt_plan_type || "unknown"})`);
```

**Problem:** The ChatGPT plan type (e.g., "plus", "team", "enterprise") is printed to the console on startup. This is a minor information leak — not the token itself, but metadata about the user's subscription.

**Mitigation:**
- Remove the plan type from console output, or gate it behind a `--verbose` flag

---

## 3. What Was Verified Clean

These categories were explicitly checked and found to have no issues:

- **No malicious npm lifecycle hooks** — `package.json` has no `preinstall`, `postinstall`, `prepare`, or `prepublish` scripts
- **No eval/exec/child_process** — no dynamic code execution of any kind
- **No hidden files or branches** — single branch, 4 clean commits, no deleted-and-re-added files
- **No obfuscated code** — no minification, no encoding tricks, no invisible Unicode characters in source
- **No WebSocket/Worker/background processes** — no hidden network listeners or background tasks
- **No prototype pollution vectors** — no `__proto__` access, no unsafe `Object.assign` patterns
- **No data exfiltration** — no unexpected outbound connections, no telemetry, no analytics
- **No prompt injection in documentation** — all markdown files contain only legitimate documentation
- **Zero runtime dependencies** — nothing to supply-chain attack
- **`\x1b[...]` escape codes in logger.ts** — verified as standard ANSI color codes only (reset, dim, bold, cyan, yellow, green, magenta, red, blue)
- **`Buffer.from(payload, "base64url")` in config.ts** — used solely to decode the JWT payload from `~/.codex/auth.json`, standard JWT parsing
- **`setTimeout` in proxy.ts** — used only for retry backoff delays on 429 rate limits, not for scheduling hidden tasks

---

## 4. Architecture Security Notes

### Model Spoofing (By Design)

The proxy reports `claude-sonnet-4-5-20250929` as the model name to Claude Code regardless of which model actually answered (`src/proxy.ts` and `src/translators/response.ts`). This is the core mechanism that makes the proxy work — Claude Code validates model names. This is clearly documented and intentional, not a hidden deception.

### Content-Based Routing (By Design, With Caveats)

The proxy uses string matching on message content to distinguish lead vs. teammate requests. This is the intended routing mechanism, but it makes routing decisions dependent on untrusted content. See finding 2.2 for the security implications.

### Credential Flow

```
User's machine
├── ANTHROPIC_API_KEY (env var) ──→ Passthrough path ──→ api.anthropic.com
├── OPENAI_API_KEY (env var) ────→ OpenAI path ───────→ api.openai.com
├── ~/.codex/auth.json ──────────→ ChatGPT path ──────→ chatgpt.com
│                                → OpenAI fallback ───→ api.openai.com
│                                                      → --target-url (⚠️ arbitrary)
└── Incoming request headers ────→ Passthrough relay ──→ api.anthropic.com
    (x-api-key, authorization,     (⚠️ includes cookie)
     cookie, anthropic-version,
     anthropic-beta, x-request-id)
```

The `⚠️` markers indicate the paths flagged in findings 2.3 and 2.4.

---

## 5. Hardening Checklist

Priority actions to take before running this proxy in any non-isolated environment:

- [ ] **Bind to localhost** — Change `server.listen(port)` to `server.listen(port, "127.0.0.1")`
- [ ] **Add proxy authentication** — Require a shared secret header on all incoming requests
- [ ] **Harden the `hydra:lead` marker** — Use a unique token or check only the `system` field
- [ ] **Validate `--target-url`** — Restrict to localhost/known providers, or skip auth headers for custom URLs
- [ ] **Add request body size limit** — Cap at a reasonable maximum (e.g., 10MB)
- [ ] **Add upstream fetch timeouts** — Use `AbortController` with 120s timeout on all `fetch()` calls
- [ ] **Remove `cookie` from relay list** — Unless explicitly needed for passthrough
- [ ] **Rotate logs instead of deleting** — Preserve forensic traceability across restarts
- [ ] **Remove plan type from console output** — Or gate behind `--verbose`

---

## 6. Revision History

| Date | Author | Changes |
|---|---|---|
| 2026-02-13 | Claude Opus 4.6 + Codex | Initial audit — full code integrity review + operational security analysis |
