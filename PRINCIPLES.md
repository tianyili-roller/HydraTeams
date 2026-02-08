# HydraTeams Principles

These are the beliefs that guide every technical decision in HydraTeams. When in doubt, refer here.

---

### 1. Don't rebuild what works.

Claude Code Agent Teams is a battle-tested multi-agent system with 15+ tools, agentic loops, file-based coordination, task dependency graphs, plan approval workflows, and graceful shutdown. Building a custom agent framework to compete with it is architectural hubris.

**Implication:** We build a translation proxy, not an agent framework. We extend Agent Teams' reach to non-Claude models. Every line of code we write is about API translation — not agent management, tool execution, or coordination.

---

### 2. The model is a runtime detail.

Large language models are rapidly improving and becoming interchangeable commodities. GPT Codex, Claude Sonnet, and Gemini Pro can all write decent code. The unique value — the thing that compounds over time — is how these models are intelligently combined, routed, and coordinated. Not the models themselves.

**Implication:** The proxy is model-agnostic by design. Adding a new target model means adding a new API translator, not changing architecture. The system works with any model that supports tool calling.

---

### 3. Right model for the right task.

Different tasks within a coding workflow have vastly different complexity and cost profiles. Using a $15/M token frontier model to search files for TODO comments is economically irrational. Using a $0.07/M token model for architectural decisions is technically reckless.

**Implication:** The proxy enables routing different teammates to different models. Research tasks go through a Gemini Flash proxy, code generation through a Codex proxy, reviews through a different model entirely. Cost optimization happens at the teammate level.

---

### 4. ~580 lines is the right amount of code.

The proxy translates between two API formats. That's the entire scope. It doesn't manage agents (Agent Teams does that). It doesn't execute tools (Claude Code does that). It doesn't coordinate tasks (the file-based protocol does that). It doesn't handle messaging (JSONL inboxes do that). Every line beyond API translation is scope creep.

**Implication:** We resist the temptation to add features that belong in Claude Code or Agent Teams. If we find ourselves building an agentic loop, tool executor, or coordination layer — we've gone wrong. The proxy is a pipe, not a brain.

---

### 5. Heterogeneous teams outperform homogeneous ones.

Research demonstrates this (Puppeteer paper, 2025). A team of diverse models — each with different strengths, biases, and failure modes — produces more robust solutions than a team of identical models. Different models catch different bugs. Different reasoning approaches find different solutions.

**Implication:** The proxy exists to make heterogeneous teams possible within Agent Teams. Every design decision should make it easier to mix models, not harder.

---

### 6. Own the translation, depend on the ecosystem.

We own the translation layer (proxy code, stream handling, format conversion). We depend on Claude Code for agent capabilities, Agent Teams for coordination, and provider SDKs for API communication. Each dependency is a deliberate choice — they do things we shouldn't rebuild.

**Implication:** Core proxy logic is first-party code with zero external dependencies beyond Node.js builtins and provider SDKs. We don't add middleware frameworks, SSE libraries, or HTTP abstractions. The proxy is simple enough to not need them.

---

### 7. Layers compose.

HydraTeams (proxy) enables multi-model Agent Teams. HydraMCP provides multi-model query orchestration. A teammate running through HydraProxy can also use HydraMCP tools for cross-model consensus during its work. The layers don't compete — they complement.

**Implication:** We never duplicate HydraMCP functionality. If an agent needs multi-model synthesis, it uses HydraMCP's `synthesize` tool. HydraTeams provides the multi-model agent runtime. HydraMCP provides multi-model intelligence within a single agent's turn.

---

### 8. Open source by default.

The infrastructure that makes AI models interchangeable should be community-owned, not proprietary. Vendor lock-in at the orchestration level is worse than lock-in at the model level.

**Implication:** HydraTeams ships under a permissive open-source license. The API translation maps are documented publicly. The architecture is explained. Anyone can fork, extend, or contribute.
