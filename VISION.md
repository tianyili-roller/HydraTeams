# HydraTeams Vision

**Make Claude Code Agent Teams model-agnostic. One proxy, any brain.**

## The Insight

Claude Code Agent Teams is the best multi-agent coding framework that exists today. Full agentic loops. 15+ tools. File-based coordination. Task dependency graphs. Plan approval workflows. Graceful shutdown. It's battle-tested by Anthropic and used by thousands of developers.

It has one constraint: every teammate must be Claude.

That's not a technical limitation. It's an API endpoint. Each teammate process calls `POST /v1/messages` on the Anthropic API. If something else answers that call — in the same format, with the same SSE streaming protocol — the teammate doesn't know the difference. And it doesn't need to.

## The Product

HydraTeams is a translation proxy. It sits between a Claude Code teammate process and a non-Claude AI provider (OpenAI, Google, Ollama). It translates:

- **Inbound:** Anthropic Messages API requests → OpenAI Chat Completions requests
- **Outbound:** OpenAI SSE stream → Anthropic SSE stream

The teammate remains a **full Claude Code instance**. Every tool works — Read, Write, Edit, Bash, Glob, Grep, Git, WebSearch, Task management, SendMessage. The proxy only swaps the brain. The body stays identical.

One environment variable (`ANTHROPIC_BASE_URL=http://localhost:3456`) redirects the teammate through the proxy. That's it.

## Why Translation Beats Building

We originally designed a full custom agent framework — Agent Runtime, Universal Tool System, Provider Adapters, Coordination Layer, Spawner. ~2000+ lines of new code. Weeks of work. And the result would have been a worse version of what Claude Code already does.

The translation proxy: ~580 lines. Days of work. And the teammates are **better** than what we could have built — because they ARE Claude Code, with every tool and capability Anthropic has engineered.

| Approach | Tools | Agentic Loop | Coordination | Lines | Time |
|---|---|---|---|---|---|
| Custom framework | Build 9 tools | Build from scratch | Build from scratch | ~2000+ | Weeks |
| Translation proxy | 15+ tools (free) | Battle-tested (free) | Proven protocol (free) | ~580 | Days |

The proxy doesn't compete with Claude Code. It extends it. It turns Agent Teams from a Claude-only feature into a universal multi-model orchestration system.

## The Principles

### 1. Don't rebuild what works.
Claude Code Agent Teams works. We don't build another agent framework. We make the existing one model-agnostic.

### 2. The model is a runtime detail.
Models are commoditizing. GPT-5.3 Codex, Claude Sonnet, Gemini Pro — they can all write decent code. The value is in orchestration: which model gets which task, how they coordinate, how failures are handled. HydraTeams is pure orchestration.

### 3. Right model, right task.
Not every task needs a $15/M token frontier model. Research? Gemini Flash at $0.01. Code generation? Codex at $0.12. Architecture? Opus at $0.15. Same team, smart routing, real savings.

### 4. ~580 lines is the right amount of code.
The proxy translates API formats. That's it. It doesn't manage agents, execute tools, coordinate tasks, or handle messaging. Claude Code does all of that. The proxy is a translation layer, and it should be exactly as complex as API translation requires — no more.

### 5. Heterogeneous teams outperform homogeneous ones.
Different models have different strengths, biases, and failure modes. A team of diverse models catches more bugs, finds more solutions, and produces more robust results than a team of identical models. This is supported by research (Puppeteer paper, 2025).

## The Roadmap

### Phase 1: OpenAI Proxy (MVP)
Build the translation proxy for OpenAI Chat Completions. Prove that a Claude Code teammate powered by GPT Codex can read files, write code, run tests, and coordinate with the lead. ~580 lines of TypeScript.

### Phase 2: Multi-Provider
Add translators for Google Gemini and Ollama. Run multiple proxies simultaneously — one per provider/model. The lead agent spawns teammates with different `ANTHROPIC_BASE_URL` values, each pointing to a different proxy.

### Phase 3: Smart Routing Layer
Build a routing layer on top that auto-selects models based on task type, cost, and availability. The lead doesn't need to know which proxy to use — HydraTeams picks the optimal model for each task.

### Phase 4: Ecosystem
Package as `npx hydra-proxy`. Integration with HydraMCP for model discovery. Config files for team templates. Cost dashboards. The infrastructure that makes multi-model teams as easy as single-model teams.

## The North Star

Any model as a Claude Code teammate. Zero compromise on agent quality.

**The model doesn't matter. The orchestration does.**
