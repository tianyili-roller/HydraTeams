# Iteration 4: Tool Use — 让 GPT 使用 Claude Code 的工具

## 本节目标

这是整个项目**最关键的一步**。

Claude Code 的 15+ 内置工具（Read, Write, Edit, Bash, Glob, Grep, WebFetch...）全部通过 tool_use 机制工作。没有 tool 翻译，GPT 只能聊天，不能执行任何操作。

本节加入：
1. **Request 方向：** tool definitions + tool_choice 翻译
2. **Response 方向：** 流式 tool_calls → Anthropic content_block 事件

---

## 1. Tool Use 的完整生命周期

在 Claude Code 的 agent loop 中，一次工具调用经历这些步骤：

```
Claude Code                     Proxy                          GPT
────────                        ─────                          ───
1. 发送请求
   (含 tools 定义 +             → 翻译 tool defs              → 收到 functions
    上一轮 tool_result)            翻译 tool_result messages

2. 等待回复                     ← 翻译 SSE 流                 ← 生成 tool_call
   收到 tool_use block             OpenAI tool_calls              function call
                                   → Anthropic content_block

3. 执行工具
   (Read file, run bash, etc.)

4. 发送新请求
   (含 tool_result)             → 翻译 tool_result            → 收到 function output
                                   ...循环继续...
```

本 iteration 处理步骤 1 和 2。步骤 3 是 Claude Code 自己做的。步骤 4（tool_result 翻译）在 Iteration 5。

---

## 2. Request 翻译：Tool Definitions

### Anthropic → OpenAI

```
Anthropic:                              OpenAI:
{                                       {
  name: "Read",                           type: "function",
  description: "Reads a file...",         function: {
  input_schema: {                           name: "Read",
    type: "object",                         description: "Reads a file...",
    properties: { ... }                     parameters: {
  }                                           type: "object",
}                                             properties: { ... }
                                            }
                                          }
                                        }
```

翻译函数极其简单——加一层 `function` 包装，`input_schema` 改名 `parameters`：

```typescript
function translateToolDef(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema,
    },
  };
}
```

### tool_choice 翻译

```typescript
function translateToolChoice(choice) {
  switch (choice.type) {
    case "auto": return "auto";
    case "any":  return "required";
    case "tool": return { type: "function", function: { name: choice.name } };
    case "none": return "none";
  }
}
```

---

## 3. Response 翻译：流式 Tool Calls（核心难点）

OpenAI 的流式 tool call 是**分片到达**的，proxy 需要：

1. **检测新 tool call 开始**：`delta.tool_calls[i].id` 出现 → 发 `content_block_start`
2. **累积参数片段**：`delta.tool_calls[i].function.arguments` → 发 `content_block_delta`
3. **检测结束**：`finish_reason: "tool_calls"` → 关闭所有 block

### OpenAI 流式 tool call 的结构

```json
// chunk 1: 新 tool call 开始（有 id 和 name）
{"choices":[{"delta":{"tool_calls":[{
  "index": 0,
  "id": "call_abc123",
  "type": "function",
  "function": { "name": "Read", "arguments": "" }
}]}}]}

// chunk 2-N: 参数片段（只有 arguments）
{"choices":[{"delta":{"tool_calls":[{
  "index": 0,
  "function": { "arguments": "{\"file" }
}]}}]}

{"choices":[{"delta":{"tool_calls":[{
  "index": 0,
  "function": { "arguments": "_path\":" }
}]}}]}

{"choices":[{"delta":{"tool_calls":[{
  "index": 0,
  "function": { "arguments": "\"/tmp/x\"}" }
}]}}]}

// 最后: finish_reason 到达
{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
```

注意 `index` 字段——如果 GPT 在一个回复中调用多个工具，它们通过不同的 `index` 区分。

### 状态跟踪

Iteration 3 只需要一个 boolean（textBlockStarted）。现在需要一个 Map 来跟踪每个活跃的 tool call：

```typescript
interface StreamState {
  blockIndex: number;                              // Anthropic content block 索引
  textBlockStarted: boolean;                       // text block 是否已开始
  activeToolCalls: Map<number, TrackedToolCall>;   // OpenAI index → 跟踪信息
}

interface TrackedToolCall {
  id: string;              // tool call ID (如 "call_abc123")
  name: string;            // 工具名 (如 "Read")
  anthropicIndex: number;  // 在 Anthropic 格式中的 block index
}
```

**为什么需要 `anthropicIndex`？**

OpenAI 的 tool_calls 用自己的 `index`（0, 1, 2...）。但在 Anthropic 格式中，
tool_use block 和 text block 共享一个全局的 content block index。如果回复是：

```
text "Let me read those files." → block index 0
tool_use Read(file_a)           → block index 1
tool_use Read(file_b)           → block index 2
```

所以我们需要为每个 tool call 记住它在 Anthropic 中的 block index，才能在发送 delta 时用对 index。

### 为什么 tool call 不需要类似 `textBlockStarted` 的 flag？

`textBlockStarted` 存在的唯一原因是 **OpenAI 的 text 流没有"首次"信号**——每个 chunk 都只是 `delta.content: "一段文字"`，第一个和第 N 个在结构上完全一样。我们必须自己用 boolean 记住"text block 是否已经 start 过了"。

Tool call 则完全不同：OpenAI **协议本身就自带了结构化信号**：

- **第一个 chunk**：携带 `tc.id`（如 `"call_abc123"`）和 `tc.function.name`
- **后续 chunk**：只有 `tc.function.arguments` 片段，**没有 `tc.id`**

所以代码中 `if (tc.id)` 这个判断天然就区分了"新 tool call 开始"和"已有 tool call 的后续参数"——不需要额外的 flag。

| | 首次 chunk 的特征 | 需要自制 flag？ |
|---|---|---|
| **Text** | `delta.content: "hi"` — 跟后续完全一样 | 需要 `textBlockStarted` |
| **Tool call** | `tc.id: "call_xxx"` — 后续没有 id | 不需要，`tc.id` 存在即首次 |

---

## 4. 翻译流程图

完整的流式 tool call 翻译序列：

```
OpenAI chunk                          Proxy 动作                          发送的 Anthropic 事件
──────────                            ─────────                          ─────────────────────
[流开始]                               初始化 state                       message_start

delta.content="Let me"                 textBlockStarted=false → true     content_block_start(idx=0, text)
                                                                         content_block_delta(idx=0, "Let me")
delta.content=" read it"                                                 content_block_delta(idx=0, " read it")

delta.tool_calls[0].id="call_abc"      检测到新 tool call                content_block_stop(idx=0)  ← 先关 text block
                                       关闭 text block                   content_block_start(idx=1, tool_use, id, name)
                                       blockIndex=1
                                       记录到 activeToolCalls

delta.tool_calls[0].arguments='{"fi'   查 activeToolCalls → idx=1       content_block_delta(idx=1, input_json_delta)

delta.tool_calls[0].arguments='le"}'                                     content_block_delta(idx=1, input_json_delta)

finish_reason="tool_calls"             关闭所有 tool blocks              content_block_stop(idx=1)
                                                                         message_delta(stop_reason: "tool_use")

[DONE]                                                                   message_stop
```

### 关键逻辑：text block → tool call 的切换

当第一个 tool call 开始时，如果 text block 还开着，必须**先关闭 text block**，
再开启 tool_use block。这是因为 Anthropic 的 content blocks 是顺序的，
不能交叉嵌套。

```typescript
if (tc.id) {
  // 新 tool call 开始！

  // 先关闭已打开的 text block
  if (state.textBlockStarted) {
    sendSSE(res, "content_block_stop", { index: state.blockIndex });
    state.blockIndex++;
    state.textBlockStarted = false;
  }

  // 开启 tool_use block
  sendSSE(res, "content_block_start", {
    index: state.blockIndex,
    content_block: { type: "tool_use", id: tc.id, name: tc.function.name },
  });

  // 记录这个 tool call
  state.activeToolCalls.set(toolIndex, {
    id: tc.id,
    name: tc.function.name,
    anthropicIndex: state.blockIndex,
  });

  state.blockIndex++;
}
```

### 完整 SSE 报文对照（text + tool call 混合场景）

上面的流程图是抽象的，下面展示你在 wire 上**实际看到的**完整 SSE 报文。

场景：GPT 先说 "Let me read it."，然后调用 `Read({ file_path: "/tmp/x" })`。

**OpenAI 发来的 SSE 流（proxy 的输入）：**

```
data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":"Let me"},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":" read it."},"finish_reason":null}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"fi"}}]},"finish_reason":null}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"le_pa"}}]},"finish_reason":null}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"/tmp/x\"}"}}]},"finish_reason":null}]}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":42,"completion_tokens":18}}

data: [DONE]
```

注意几点：
- 第一个 chunk 有 `role: "assistant"` 和空 `content: ""`，但这**不能**用来开启 text block（因为不确定后面是 text 还是 tool call，且 `""` 是 falsy）
- tool call 首个 chunk 有 `id` 和 `name`，后续 chunk 只有 `arguments` 片段
- `finish_reason: "tool_calls"`（注意是复数）表示本轮回复包含工具调用

**Proxy 翻译后发给 Claude Code 的 SSE 流（proxy 的输出）：**

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start                                          ← "Let me" 到达，懒初始化 text block
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" read it."}}

event: content_block_stop                                           ← tool call 来了，先关 text block
data: {"type":"content_block_stop","index":0}

event: content_block_start                                          ← 开启 tool_use block
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_abc","name":"Read"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"fi"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"le_pa"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"th\":\"/tmp/x\"}"}}

event: content_block_stop                                           ← finish_reason 到达，关闭 tool block
data: {"type":"content_block_stop","index":1}

event: message_delta                                                ← "tool_calls" → "tool_use"
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":0,"output_tokens":18}}

event: message_stop
data: {"type":"message_stop"}
```

对照要点：
1. **OpenAI 的第一个 `role` chunk** → proxy 不产生任何输出（等真正有内容再说）
2. **首个有内容的 text chunk** → `content_block_start(text)` + `content_block_delta`
3. **tool call 的 `id` chunk** → 先 `content_block_stop`(text)，再 `content_block_start`(tool_use)
4. **tool call 的 `arguments` chunks** → `content_block_delta`(input_json_delta)
5. **`finish_reason: "tool_calls"`** → `content_block_stop` + `message_delta(stop_reason: "tool_use")`
6. **`[DONE]`** → `message_stop`

---

## 5. 对照生产代码

本 iteration 实现的逻辑对应生产版本的三个文件：

| 我们的代码 | 生产版本 | 对应行 |
|-----------|---------|--------|
| `translateToolDef()` | `src/translators/request.ts` | lines 57-66 |
| `translateToolChoice()` | `src/translators/request.ts` | lines 76-92 |
| tool_calls 流翻译 | `src/translators/response.ts` | lines 137-188 |

---

## 6. 这个版本还不支持什么？

| 不支持 | 原因 | 解决 |
|--------|------|------|
| tool_result 消息翻译 | user 消息里的 tool_result blocks 还没翻译 | Iteration 5 |
| assistant 历史中的 tool_use | 多轮对话中 assistant 的 tool_use blocks 还没翻译 | Iteration 5 |
| 多个 tool call 同时关闭 | finish_reason 时需要关闭所有 tracked tool calls | 本 iteration 已实现 |

换句话说：**GPT 可以发出 tool call 了，但还不能收到工具的执行结果。**
完整的 agent loop 需要 Iteration 5 的消息历史翻译才能跑起来。

---

准备好了就说 **"开始 Iteration 5"**！
