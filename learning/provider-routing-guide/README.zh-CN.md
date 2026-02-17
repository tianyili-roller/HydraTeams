> 翻译基于英文版 | [English Version](./README.md)

# Provider 路由指南 — ChatGPT 与 OpenAI API 的区别

> **日期**：2026-02-17
> **范围**：Proxy 如何将请求路由到不同的 OpenAI 后端、前沿模型的已知坑点，以及修复方案

---

## 1. 两种 Provider，两套 API

Proxy 支持两种不同的 OpenAI 后端，通过 `--provider` 参数在**启动时**选择：

| 参数 | 后端 | API | Endpoint |
|------|------|-----|----------|
| `--provider chatgpt` | ChatGPT Backend | Responses API | `chatgpt.com/backend-api/codex/responses` |
| `--provider openai` | OpenAI API | Chat Completions API | `api.openai.com/v1/chat/completions` |

### ChatGPT Backend（`--provider chatgpt`）

使用你的 **ChatGPT Plus/Pro 订阅**，通过后端 Responses API 访问。认证信息自动从 `~/.codex/auth.json` 读取（需先运行 `codex --login`）。

可用模型：`gpt-5-codex`、`gpt-5.1-codex`、`gpt-5.2-codex`、`gpt-5.3-codex`、`gpt-5-codex-mini`、`gpt-5.1-codex-mini`

### OpenAI API（`--provider openai`）

标准 OpenAI **Chat Completions API**。需要 `OPENAI_API_KEY` 环境变量，或者 codex auth 作为 fallback。

可用模型：`gpt-4o`、`gpt-4o-mini`、`o3-mini` 等

---

## 2. 路由决策——启动时一锤定音

没有按请求或按模型的动态路由。Provider 在启动时决定一次，之后不会改变：

```typescript
// config.ts — provider 来自 CLI 参数或环境变量
const targetProvider = getArg("--provider")
  || process.env.HYDRA_TARGET_PROVIDER
  || "openai";  // default
```

请求处理器中，一个 `if` 分支决定整条代码路径：

```typescript
// proxy.ts:191 — 路由决策
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

**所有**请求走同一条路径，单个 proxy 实例无法混用两种 provider。

---

## 3. 坑点 #1 — `max_tokens` 与 `max_completion_tokens`

### 问题

OpenAI 的前沿模型（GPT-5.x、o 系列）**拒绝旧版 `max_tokens` 参数**，要求改用 `max_completion_tokens`。使用 `--provider openai` 配合这些模型时，proxy 发送的 `max_tokens` 会导致报错：

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

### 出错位置

在 `src/translators/request.ts` 中，Chat Completions 翻译器始终发送 `max_tokens`：

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
  max_tokens: maxTokens,  // ← 始终使用旧版字段名
  // ...
};
```

### 为什么 Responses API 不受影响

Responses API 翻译器（`request-responses.ts`）**根本不发送 `max_tokens`**——Responses API 用不同方式处理输出长度限制，因此 `--provider chatgpt` 路径上不可能出现这个错误。

---

## 4. 关于模型名称——短名称可以正常使用

短模型名称（如 `gpt-5.2` 或 `gpt-5-mini`）可以正常使用，无需指定完整版本号（如 `gpt-5.2-2025-12-11`）。OpenAI 会在其侧自动解析别名。

Proxy 将 `config.targetModel` 原样传递给 API，不做任何名称解析：

```typescript
// 两条路径都原样传递模型名：
// request.ts:31
model: targetModel,

// request-responses.ts:71
model: targetModel,
```

短名称和完整名称在两种 provider 上都能正常工作。

---

## 5. 汇总——两种 Provider 各受哪些问题影响？

| 问题 | `--provider openai`（Chat Completions） | `--provider chatgpt`（Responses API） |
|------|---------------------------------------|--------------------------------------|
| `max_tokens` 被前沿模型拒绝 | **受影响** | 不受影响（未发送该参数） |
| 模型名别名（如 `gpt-5-mini`） | 正常工作 | 正常工作 |

---

## 6. 修复方案——让前沿模型在 Chat Completions 上可用

修复方式很直接：对需要新参数的模型使用 `max_completion_tokens` 替代 `max_tokens`。基于允许列表的方案：

```typescript
// request.ts — 建议改动

// 需要新参数名的模型
const USES_MAX_COMPLETION_TOKENS = new Set([
  "o3-mini",
  // 添加前沿模型，以及 2025+ 带版本后缀的模型
]);

function needsNewTokenParam(model: string): boolean {
  if (USES_MAX_COMPLETION_TOKENS.has(model)) return true;
  // 启发式规则：GPT-5 系列的模型大概率需要新参数
  if (/^(gpt-5|o[1-9])/.test(model)) return true;
  return false;
}

// 在 translateRequest() 中：
if (needsNewTokenParam(targetModel)) {
  result.max_completion_tokens = maxTokens;
} else {
  result.max_tokens = maxTokens;
}
```

改动很小——只在请求翻译器中增加一个分支。`OpenAIRequest` 类型需要加一个可选的 `max_completion_tokens` 字段。

另一种更简单粗暴的方案：**一律使用 `max_completion_tokens`**，彻底弃用 `max_tokens`。新版 OpenAI 模型都支持 `max_completion_tokens`，而只认 `max_tokens` 的旧模型正在被淘汰。如果不需要兼容旧模型，这种方案维护成本更低。
