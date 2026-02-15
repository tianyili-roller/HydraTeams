# Iteration 1 Review Notes — 补充与勘误

> 基于 2026-02 对 Anthropic / OpenAI 最新官方文档的交叉验证。
> 用于未来优化代码和翻译方案时参考。

---

## 1. Repo 实际架构：两条翻译路径

README 只描述了 Chat Completions 路径，但 repo 实际有两套翻译器：

| 翻译器 | 目标 API | 端点 |
|--------|---------|------|
| `request.ts` + `response.ts` | Chat Completions | `POST /v1/chat/completions` |
| `request-responses.ts` + `response-responses.ts` | Responses API | `POST chatgpt.com/backend-api/codex/responses` |

Responses API 的请求/响应结构与 Chat Completions 完全不同（用 `instructions` 代替 system message，用 `input` 代替 `messages`，工具调用是 `function_call` / `function_call_output` 而非 `tool_calls` / `role: "tool"`）。

---

## 2. `max_tokens` → `max_completion_tokens`

OpenAI 推荐新代码使用 `max_completion_tokens` 代替 `max_tokens`：

- **非 reasoning 模型**（gpt-4o 等）：`max_tokens` 仍然兼容，暂无问题
- **Reasoning 模型**（o3-mini, o4-mini 等）：`max_tokens` 已 deprecated，应使用 `max_completion_tokens`
- **Responses API**：不使用此字段，不受影响

当前 `request.ts:33` 使用 `max_tokens`，如果未来重点支持 reasoning models 需要更新。

---

## 3. OpenAI 新增 `developer` Role

OpenAI 2025 年为 o-series reasoning models 引入了 `developer` 角色：

```json
{ "role": "developer", "content": "You are a helpful assistant." }
```

- `developer`：提供系统规则和业务逻辑，推荐用于 reasoning models
- `system`：传统 system instructions，仍然支持
- **不要混用** `developer` 和 `system`

当前翻译器将 Anthropic `system` 统一翻译为 OpenAI `role: "system"`。如果目标模型是 o3/o4，可能需要改为 `role: "developer"`。

---

## 4. Stop Reason 映射不完整

### Anthropic 缺少的 stop_reason

| stop_reason | 含义 | 优先级 |
|-------------|------|--------|
| `stop_sequence` | 命中自定义 stop sequence | 低（proxy 场景少用） |
| `pause_turn` | Server-side tool 执行达到迭代上限 | 低（GPT 不产生此值） |
| `refusal` | 安全拒绝（Claude 4.5+ 新增） | 中（需要映射 OpenAI 的 content_filter） |
| `model_context_window_exceeded` | 上下文窗口超限 | 低 |

### OpenAI 缺少的 finish_reason

| finish_reason | 含义 | 优先级 |
|---------------|------|--------|
| `content_filter` | 内容审核过滤 | **高**（GPT 实际会返回） |

### 建议补充的映射

```typescript
// response.ts 中当前只处理了 3 种：
// "stop" → "end_turn", "tool_calls" → "tool_use", "length" → "max_tokens"

// 应补充：
// "content_filter" → "end_turn"  (或自定义处理，通知上游内容被过滤)
```

### 已知 Bug

OpenAI 有时在 tool call 场景下返回 `finish_reason: "stop"` 而非 `"tool_calls"`。当前代码应额外检查 `tool_calls` 字段是否存在来兜底。

---

## 5. Anthropic 流式新增 Delta 类型

README 只提到了 `text_delta` 和 `input_json_delta`，最新 API 还有：

| Delta 类型 | 用途 |
|-----------|------|
| `thinking_delta` | Extended thinking（思维链） |
| `signature_delta` | 响应签名验证 |

对 proxy 的影响：GPT 不产生这些 delta，所以**不需要在 response 翻译中生成**。但如果未来需要模拟 thinking blocks，需要了解格式。

---

## 6. OpenAI `stream_options` 新增字段

除了 `include_usage: true`，还有：

```json
{
  "stream_options": {
    "include_usage": true,
    "include_obfuscation": true  // 随机填充 chunk 大小，防侧信道攻击（默认开启）
  }
}
```

当前代码只设置了 `include_usage`，这是正确的。`include_obfuscation` 默认开启，无需显式设置。

---

## 7. Anthropic `tool_choice: { type: "none" }` 格式歧义

官方文档对 `none` 是否为 `{ type: "none" }` 对象格式还是字符串格式不够明确。当前代码（`request.ts:87`）处理为 `switch case "none" → return "none"`，翻译逻辑本身没问题。

---

## 8. 流式 Edge Cases

### Anthropic `message_start` 中 usage 可能为 0

```json
// message_start 中有时：
{"usage": {"input_tokens": 0, "output_tokens": 0}}
// 正确值在后续 message_delta 中到达
```

当前 response 翻译器在 `message_start` 中填入了初始 usage，如果上游 proxy 依赖这个值做计费，需要注意用 `message_delta` 中的值覆盖。

### OpenAI Parallel Tool Calls 并非真正并行流式

即使设置了 `parallel_tool_calls=true`，实际上 text content 结束后 tool call 事件会**一次性 burst 到达**，而非真正交错流式。对翻译逻辑无影响，但影响用户感知的延迟。

### OpenAI Tool Call 的 Usage 最终 Chunk

当 `stream_options.include_usage` 开启时，usage 在 `data: [DONE]` 前的最后一个 chunk 中，该 chunk 的 `choices` 为空数组：

```json
data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":25,"total_tokens":35}}
data: [DONE]
```

如果流中断，可能收不到这个 chunk，导致 usage 信息丢失。

---

## 9. OpenAI Responses API 的 SSE 格式完全不同

Responses API 使用 `event:` + `data:` 行（不同于 Chat Completions 的 data-only），且有 **53+ 事件类型**。当前 `response-responses.ts` 已单独处理，与 Chat Completions 翻译器隔离，架构是正确的。

---

## 优化优先级建议

| 优先级 | 项目 | 文件 |
|--------|------|------|
| **P0** | 处理 `content_filter` finish_reason | `response.ts` |
| **P0** | 兜底检查 `tool_calls` 字段（应对 finish_reason bug） | `response.ts` |
| **P1** | `max_tokens` → `max_completion_tokens`（支持 reasoning models） | `request.ts` |
| **P1** | `developer` role 支持（按目标模型选择） | `messages.ts` |
| **P2** | `message_start` usage 为 0 的兜底处理 | `response.ts` |
| **P2** | 流中断时 usage 丢失的处理 | `proxy.ts` |
| **P3** | 文档补充 Responses API 路径说明 | `README.md` |
