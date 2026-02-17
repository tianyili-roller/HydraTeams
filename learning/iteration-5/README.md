# Iteration 5: 完整消息历史翻译 — 闭合 Agent Loop

## 本节目标

Iteration 4 让 GPT 能**发出** tool calls，但还不能**接收**工具执行结果。
本节补上最后一环——**消息历史中的 tool_use 和 tool_result 翻译**。

完成后，完整的 agent loop 就通了：

```
GPT 发出 tool_call (Read file)
    ↓
Claude Code 执行工具，拿到结果
    ↓
Claude Code 把结果放在 tool_result 中，连同历史消息一起发新请求
    ↓
Proxy 翻译历史消息（包括 tool_use + tool_result）→ 发给 GPT
    ↓
GPT 看到工具结果，继续推理或调用下一个工具
    ↓
...循环...
```

---

## 1. 问题：Iteration 4 的消息翻译为什么不够？

Iteration 4 的消息翻译是这样的：

```typescript
for (const msg of body.messages) {
  openaiMessages.push({
    role: msg.role,
    content: typeof msg.content === "string"
      ? msg.content
      : msg.content.map(b => b.text || "").join(""),
  });
}
```

它把所有 content blocks 都当作 text 提取。这对纯文本消息没问题，但对 agent loop 中的消息**完全错误**：

- **Assistant 消息**可能包含 `tool_use` blocks → 这些被丢弃了（`b.text` 是 undefined）
- **User 消息**可能包含 `tool_result` blocks → 这些也被丢弃了

GPT 看不到自己之前调用了什么工具，也看不到工具的执行结果。

---

## 2. 真实的 Agent Loop 消息历史长什么样

一次 "读取文件并分析" 的完整对话：

```json
{
  "messages": [
    // ─── Turn 1: 用户提问 ───
    {
      "role": "user",
      "content": "Read /tmp/hello.py and explain it"
    },

    // ─── Turn 2: GPT 回复 (文本 + 工具调用) ───
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "Let me read that file." },
        {
          "type": "tool_use",
          "id": "toolu_abc123",
          "name": "Read",
          "input": { "file_path": "/tmp/hello.py" }
        }
      ]
    },

    // ─── Turn 3: 工具执行结果 ───
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_abc123",
          "content": "print('hello world')"
        }
      ]
    }

    // ← GPT 的下一个回复会在这之后生成
  ]
}
```

注意：
- Turn 2 的 assistant 消息包含 **text + tool_use** 混合
- Turn 3 是 **user 消息**但内容是 tool_result（Anthropic 的设计：工具结果包在 user 消息里）
- `tool_use_id` 和 `tool_result.tool_use_id` 通过 ID 关联

---

## 3. 翻译规则

### 3a. Assistant 消息：text + tool_use → content + tool_calls

```
Anthropic:                              OpenAI:
{                                       {
  role: "assistant",                      role: "assistant",
  content: [                              content: "Let me read that file.",
    { type: "text",                       tool_calls: [
      text: "Let me read that file." },     {
    { type: "tool_use",                       id: "toolu_abc123",
      id: "toolu_abc123",                     type: "function",
      name: "Read",                           function: {
      input: { file_path: "..." }               name: "Read",
    }                                           arguments: "{\"file_path\":\"...\"}"
  ]                                           }
}                                           }
                                          ]
                                        }
```

翻译要点：
1. **text blocks** → 合并成一个 `content` 字符串（OpenAI 只有一个 content 字段）
2. **tool_use blocks** → 变成 `tool_calls` 数组
3. `input` (JSON 对象) → `arguments` (JSON **字符串**) — 需要 `JSON.stringify`
4. 如果没有 text blocks，`content` 设为 `null`（OpenAI 要求有 tool_calls 时 content 可以为 null）

```typescript
function translateAssistantMessage(msg) {
  const blocks = msg.content;

  // 分离 text 和 tool_use
  const textParts = blocks.filter(b => b.type === "text");
  const toolUses  = blocks.filter(b => b.type === "tool_use");

  const result = {
    role: "assistant",
    content: textParts.length > 0
      ? textParts.map(b => b.text).join("")
      : null,
  };

  if (toolUses.length > 0) {
    result.tool_calls = toolUses.map(tu => ({
      id: tu.id,
      type: "function",
      function: {
        name: tu.name,
        arguments: JSON.stringify(tu.input),  // 对象 → 字符串！
      },
    }));
  }

  return result;
}
```

### 3b. User 消息：tool_result → role: "tool"

```
Anthropic:                              OpenAI:
{                                       {
  role: "user",                           role: "tool",        ← 独立角色
  content: [                              tool_call_id: "toolu_abc123",
    { type: "tool_result",                content: "print('hello world')"
      tool_use_id: "toolu_abc123",      }
      content: "print('hello world')"
    }
  ]
}
```

翻译要点：
1. Anthropic 的 tool_result 放在 **user 消息**里，OpenAI 给它一个 **独立的 `role: "tool"` 消息**
2. 一条 Anthropic user 消息可能包含**多个** tool_result（对应多个并行 tool calls）→ 拆成多条 OpenAI tool 消息
3. 如果 user 消息同时包含 tool_result 和 text → text 单独成为一条 user 消息
4. `tool_use_id` → `tool_call_id`（字段名不同）
5. `content` 可能是 string 或 content block 数组 → 统一转成 string

```typescript
function translateUserMessage(msg) {
  if (typeof msg.content === "string") {
    return [{ role: "user", content: msg.content }];
  }

  const results = [];
  const blocks = msg.content;

  // 分离 tool_result 和其他 blocks
  const toolResults = blocks.filter(b => b.type === "tool_result");
  const otherBlocks = blocks.filter(b => b.type !== "tool_result");

  // 每个 tool_result → 一条独立的 tool 消息
  for (const tr of toolResults) {
    results.push({
      role: "tool",
      tool_call_id: tr.tool_use_id,
      content: typeof tr.content === "string"
        ? tr.content
        : JSON.stringify(tr.content),
    });
  }

  // 其他 text blocks → 一条 user 消息
  if (otherBlocks.length > 0) {
    const text = otherBlocks
      .map(b => b.type === "text" ? b.text : "")
      .join("");
    if (text) {
      results.push({ role: "user", content: text });
    }
  }

  return results;  // 注意：一条 Anthropic 消息 → 可能多条 OpenAI 消息！
}
```

### 3c. 完整的 translateMessages 函数

```typescript
function translateMessages(system, messages) {
  const result = [];

  // System prompt
  if (system) {
    const text = typeof system === "string"
      ? system
      : system.map(b => b.text).join("\n");
    result.push({ role: "system", content: text });
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else {
        result.push(translateAssistantMessage(msg));
      }
    } else {
      // User messages（可能包含 tool_result）
      const translated = translateUserMessage(msg);
      result.push(...translated);  // 展开！一条可能变多条
    }
  }

  return result;
}
```

---

## 4. 一条变多条：翻译的"膨胀"

这是消息翻译中最微妙的地方。

**Anthropic 格式：** 3 条消息
```
[user]       "Read two files"
[assistant]  [text + tool_use(Read A) + tool_use(Read B)]
[user]       [tool_result(A) + tool_result(B)]
```

**翻译后 OpenAI 格式：** 5 条消息
```
[user]       "Read two files"
[assistant]  content + tool_calls[Read A, Read B]
[tool]       tool_call_id=A, content=...        ← 拆开了！
[tool]       tool_call_id=B, content=...        ← 拆开了！
```

Anthropic 的 3 条消息变成了 OpenAI 的 4 条。消息数量不一定一一对应。

更复杂的情况——如果 user 消息同时有 tool_result 和 text：

**Anthropic：** 1 条 user 消息
```json
{
  "role": "user",
  "content": [
    { "type": "tool_result", "tool_use_id": "abc", "content": "file contents..." },
    { "type": "text", "text": "Now analyze this code" }
  ]
}
```

**OpenAI：** 2 条消息
```json
{ "role": "tool", "tool_call_id": "abc", "content": "file contents..." }
{ "role": "user", "content": "Now analyze this code" }
```

---

## 5. 对照生产代码

本 iteration 实现的 `translateMessages` 对应 `src/translators/messages.ts`：

| 我们的函数 | 生产版本 | 行号 |
|-----------|---------|------|
| `translateMessages()` | `translateMessages()` | lines 15-79 |
| `translateAssistantMessage()` | `translateAssistantMessage()` | lines 81-111 |
| `translateUserMessage()` 逻辑 | 内联在主函数的 `else` 分支中 | lines 34-75 |

生产版本把 user 消息翻译逻辑内联了，没有单独提取成函数，但逻辑完全一样。

---

## 6. 里程碑：Agent Loop 闭合

完成这个 iteration 后，proxy 支持完整的 agentic 工作流：

```
Turn 1:  User asks question
         → GPT sees question
Turn 2:  GPT calls Read tool
         → Claude Code reads file
Turn 3:  Tool result sent back
         → GPT sees file contents    ← 这一步之前不 work！
Turn 4:  GPT calls Edit tool
         → Claude Code edits file
Turn 5:  Tool result sent back
         → GPT sees edit result
Turn 6:  GPT says "Done!"
```

**这是一个可工作的 agent proxy 了。** 从这里开始，剩余的 iterations (6-9) 都是在改进健壮性、功能和可观测性。

---

准备好了就说 **"开始 Iteration 6"**！
