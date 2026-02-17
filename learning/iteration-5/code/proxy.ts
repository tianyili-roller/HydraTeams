#!/usr/bin/env npx tsx

/**
 * HydraProxy — Iteration 5: 完整消息历史翻译
 *
 * 在 Iteration 4 基础上，替换消息翻译逻辑：
 * - Assistant messages: text + tool_use → content + tool_calls
 * - User messages: tool_result → role: "tool" 独立消息
 *
 * 这个版本的 proxy 可以支持完整的 agent loop！
 *
 * 运行: OPENAI_API_KEY=sk-xxx npx tsx proxy.ts
 */

import http from "node:http";

// ─── Config ─────────────────────────────────────────────────────
const PORT = 3456;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TARGET_MODEL = "gpt-5.2";
const SPOOF_MODEL = "claude-sonnet-4-5-20250929";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!OPENAI_API_KEY) {
  console.error("Error: Set OPENAI_API_KEY environment variable");
  process.exit(1);
}

// ─── Anthropic Types ────────────────────────────────────────────

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean };

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: string };
}

// ─── OpenAI Types ───────────────────────────────────────────────

interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ─── Stream Types ───────────────────────────────────────────────

interface TrackedToolCall {
  id: string;
  name: string;
  anthropicIndex: number;
}

interface StreamState {
  blockIndex: number;
  textBlockStarted: boolean;
  activeToolCalls: Map<number, TrackedToolCall>;
}

// ─── Token Parameter Compatibility ──────────────────────────────

function needsMaxCompletionTokens(model: string): boolean {
  return /^(gpt-5|o[1-9])/.test(model);
}

// ─── SSE Helper ─────────────────────────────────────────────────

function sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ═══════════════════════════════════════════════════════════════
// REQUEST TRANSLATION
// ═══════════════════════════════════════════════════════════════

// ─── Tool Definition Translation ────────────────────────────────

function translateToolDef(tool: AnthropicTool): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema,
    },
  };
}

function translateToolChoice(
  choice?: AnthropicToolChoice,
): string | { type: "function"; function: { name: string } } | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto": return "auto";
    case "any":  return "required";
    case "tool": return { type: "function", function: { name: choice.name } };
    case "none": return "none";
  }
}

// ─── Message Translation（本 iteration 的核心变更！）──────────

/**
 * 翻译完整的消息历史: Anthropic → OpenAI
 *
 * 处理三种复杂情况：
 * 1. Assistant 消息中的 tool_use blocks → tool_calls
 * 2. User 消息中的 tool_result blocks → role: "tool" 消息
 * 3. 一条 Anthropic 消息可能翻译成多条 OpenAI 消息
 */
function translateMessages(
  system: string | AnthropicSystemBlock[] | undefined,
  messages: AnthropicMessage[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System prompt → system message
  if (system) {
    const text = typeof system === "string"
      ? system
      : system.map(b => b.text).join("\n");
    result.push({ role: "system", content: text });
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      result.push(translateAssistantMessage(msg));
    } else {
      // User messages — 可能包含 tool_result，一条可能变多条
      const translated = translateUserMessage(msg);
      result.push(...translated);
    }
  }

  return result;
}

/**
 * 翻译 assistant 消息:
 * - text blocks → content 字符串
 * - tool_use blocks → tool_calls 数组
 */
function translateAssistantMessage(msg: AnthropicMessage): OpenAIMessage {
  // 简单字符串 content
  if (typeof msg.content === "string") {
    return { role: "assistant", content: msg.content };
  }

  const blocks = msg.content;

  // 分离 text 和 tool_use
  const textParts = blocks.filter(
    (b): b is { type: "text"; text: string } => b.type === "text"
  );
  const toolUses = blocks.filter(
    (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
      b.type === "tool_use"
  );

  const result: OpenAIMessage & { role: "assistant" } = {
    role: "assistant",
    // 有 text → 合并成字符串；没有 → null（OpenAI 允许 content: null when tool_calls present）
    content: textParts.length > 0
      ? textParts.map(b => b.text).join("")
      : null,
  };

  if (toolUses.length > 0) {
    result.tool_calls = toolUses.map(tu => ({
      id: tu.id,
      type: "function" as const,
      function: {
        name: tu.name,
        arguments: JSON.stringify(tu.input),  // 对象 → JSON 字符串！
      },
    }));
  }

  return result;
}

/**
 * 翻译 user 消息:
 * - 纯文本 → 一条 user 消息
 * - tool_result blocks → 每个变成独立的 role: "tool" 消息
 * - 混合 (tool_result + text) → tool 消息 + user 消息
 *
 * 注意：一条 Anthropic 消息可能翻译成多条 OpenAI 消息！
 */
function translateUserMessage(msg: AnthropicMessage): OpenAIMessage[] {
  // 简单字符串 content
  if (typeof msg.content === "string") {
    return [{ role: "user", content: msg.content }];
  }

  const blocks = msg.content;
  const toolResults = blocks.filter(
    (b): b is { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean } =>
      b.type === "tool_result"
  );

  // 没有 tool_result → 当普通 user 消息处理
  if (toolResults.length === 0) {
    const text = blocks
      .map(b => b.type === "text" ? b.text : "")
      .join("");
    return [{ role: "user", content: text }];
  }

  const result: OpenAIMessage[] = [];

  // 每个 tool_result → 一条独立的 tool 消息
  for (const tr of toolResults) {
    result.push({
      role: "tool",
      tool_call_id: tr.tool_use_id,    // tool_use_id → tool_call_id
      content: typeof tr.content === "string"
        ? tr.content
        : JSON.stringify(tr.content),   // 结构化 content → JSON 字符串
    });
  }

  // 非 tool_result 的 text blocks → 一条 user 消息
  const otherBlocks = blocks.filter(b => b.type !== "tool_result");
  if (otherBlocks.length > 0) {
    const text = otherBlocks
      .map(b => b.type === "text" ? b.text : "")
      .join("");
    if (text) {
      result.push({ role: "user", content: text });
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// RESPONSE TRANSLATION (unchanged from Iteration 4)
// ═══════════════════════════════════════════════════════════════

async function translateStream(
  upstreamBody: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
): Promise<void> {
  const state: StreamState = {
    blockIndex: 0,
    textBlockStarted: false,
    activeToolCalls: new Map(),
  };

  sendSSE(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: SPOOF_MODEL,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data: ")) continue;

        const payload = trimmed.slice(6);

        if (payload === "[DONE]") {
          sendSSE(res, "message_stop", { type: "message_stop" });
          res.end();
          return;
        }

        let chunk: {
          choices?: Array<{
            delta: {
              role?: string;
              content?: string | null;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason: string | null;
          }>;
          usage?: { completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        if (chunk.usage?.completion_tokens) {
          outputTokens = chunk.usage.completion_tokens;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;

        // ─── Text ───
        if (delta.content) {
          if (!state.textBlockStarted) {
            sendSSE(res, "content_block_start", {
              type: "content_block_start",
              index: state.blockIndex,
              content_block: { type: "text", text: "" },
            });
            state.textBlockStarted = true;
          }
          sendSSE(res, "content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "text_delta", text: delta.content },
          });
        }

        // ─── Tool Calls ───
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const toolIndex = tc.index;

            if (tc.id) {
              if (state.textBlockStarted) {
                sendSSE(res, "content_block_stop", {
                  type: "content_block_stop",
                  index: state.blockIndex,
                });
                state.blockIndex++;
                state.textBlockStarted = false;
              }

              state.activeToolCalls.set(toolIndex, {
                id: tc.id,
                name: tc.function?.name || "",
                anthropicIndex: state.blockIndex,
              });

              sendSSE(res, "content_block_start", {
                type: "content_block_start",
                index: state.blockIndex,
                content_block: {
                  type: "tool_use",
                  id: tc.id,
                  name: tc.function?.name || "",
                },
              });

              state.blockIndex++;
            }

            if (tc.function?.arguments) {
              const tracked = state.activeToolCalls.get(toolIndex);
              if (tracked) {
                sendSSE(res, "content_block_delta", {
                  type: "content_block_delta",
                  index: tracked.anthropicIndex,
                  delta: {
                    type: "input_json_delta",
                    partial_json: tc.function.arguments,
                  },
                });
              }
            }
          }
        }

        // ─── Finish ───
        if (choice.finish_reason) {
          if (state.textBlockStarted) {
            sendSSE(res, "content_block_stop", {
              type: "content_block_stop",
              index: state.blockIndex,
            });
          }

          for (const [, tc] of state.activeToolCalls) {
            sendSSE(res, "content_block_stop", {
              type: "content_block_stop",
              index: tc.anthropicIndex,
            });
          }

          const stopReason =
            choice.finish_reason === "tool_calls"
              ? "tool_use"
              : choice.finish_reason === "length"
                ? "max_tokens"
                : "end_turn";

          sendSSE(res, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { input_tokens: 0, output_tokens: outputTokens },
          });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  res.end();
}

// ═══════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/messages") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // ── 翻译消息（新的 translateMessages 替换了之前的简陋逻辑！）──
    const openaiMessages = translateMessages(body.system, body.messages);

    // ── 构造 OpenAI 请求 ──
    const maxTokens = Math.min(body.max_tokens || 4096, 16384);
    const openaiReq: Record<string, unknown> = {
      model: TARGET_MODEL,
      messages: openaiMessages,
      ...(needsMaxCompletionTokens(TARGET_MODEL)
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (body.tools && body.tools.length > 0) {
      openaiReq.tools = body.tools.map(translateToolDef);
    }

    const toolChoice = translateToolChoice(body.tool_choice);
    if (toolChoice !== undefined) {
      openaiReq.tool_choice = toolChoice;
    }

    // ── 日志：显示翻译后的消息结构 ──
    const msgSummary = openaiMessages.map(m => {
      if (m.role === "tool") return "tool";
      if (m.role === "assistant" && "tool_calls" in m && m.tool_calls) return `asst+${m.tool_calls.length}tools`;
      return m.role;
    }).join(" → ");
    console.log(`→ ${TARGET_MODEL} [${msgSummary}] (${body.tools?.length || 0} tools)`);

    // ── 发给 OpenAI ──
    const upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(openaiReq),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`← OpenAI error ${upstream.status}: ${errText.slice(0, 200)}`);
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: errText } }));
      return;
    }

    if (!upstream.body) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "No body" } }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    await translateStream(upstream.body, res);
    console.log(`← Stream complete`);

  } catch (err) {
    console.error("Proxy error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(err) } }));
  }
});

// ─── Start ──────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║   HydraProxy Iteration 5 — Full Agent Loop       ║
╠═══════════════════════════════════════════════════╣
║   Port:   :${PORT}                                 ║
║   Target: ${TARGET_MODEL.padEnd(42)}║
║   Spoof:  ${SPOOF_MODEL.padEnd(42)}║
║   Mode:   streaming + tools + message history     ║
╚═══════════════════════════════════════════════════╝
  `);
});
