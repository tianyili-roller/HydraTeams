#!/usr/bin/env npx tsx

/**
 * HydraProxy — Iteration 4: Tool Use
 *
 * 在 Iteration 3 基础上加入：
 * - Request: tool definitions + tool_choice 翻译
 * - Response: 流式 tool_calls → Anthropic content_block 事件
 *
 * 还不支持：消息历史中的 tool_result（Iteration 5）
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

// ─── Types ──────────────────────────────────────────────────────

/** Anthropic tool definition */
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** Anthropic tool_choice */
type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" };

/** OpenAI function tool definition */
interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 跟踪一个活跃的 tool call */
interface TrackedToolCall {
  id: string;
  name: string;
  anthropicIndex: number; // 在 Anthropic content blocks 中的 index
}

/** 流翻译的状态机 */
interface StreamState {
  blockIndex: number;
  textBlockStarted: boolean;
  activeToolCalls: Map<number, TrackedToolCall>; // OpenAI tool index → tracked info
}

// ─── Token Parameter Compatibility ──────────────────────────────
// OpenAI 前沿模型 (GPT-5.x, o-series) 拒绝旧版 max_tokens，
// 要求使用 max_completion_tokens。详见 provider-routing-guide。

function needsMaxCompletionTokens(model: string): boolean {
  return /^(gpt-5|o[1-9])/.test(model);
}

// ─── SSE Helper ─────────────────────────────────────────────────

function sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Request Translation ────────────────────────────────────────

/**
 * 翻译 tool definition: Anthropic → OpenAI
 *
 * Anthropic: { name, description, input_schema }
 * OpenAI:    { type: "function", function: { name, description, parameters } }
 */
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

/**
 * 翻译 tool_choice: Anthropic → OpenAI
 *
 * auto → "auto"
 * any  → "required"  (必须调用某个工具)
 * tool → { type: "function", function: { name } }  (必须调用指定工具)
 * none → "none"
 */
function translateToolChoice(
  choice?: AnthropicToolChoice,
): string | { type: "function"; function: { name: string } } | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
    case "none":
      return "none";
  }
}

// ─── Stream Translator ─────────────────────────────────────────

async function translateStream(
  upstreamBody: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
): Promise<void> {
  const state: StreamState = {
    blockIndex: 0,
    textBlockStarted: false,
    activeToolCalls: new Map(),
  };

  // message_start
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

        // ─── 文本内容 ───────────────────────────────────────
        // 跟 Iteration 3 完全一样
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

        // ─── Tool Calls（新增！）───────────────────────────
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const toolIndex = tc.index; // OpenAI 的 tool call index

            // ── 新 tool call 开始（有 id 的 chunk）──
            if (tc.id) {
              // 先关闭已打开的 text block
              if (state.textBlockStarted) {
                sendSSE(res, "content_block_stop", {
                  type: "content_block_stop",
                  index: state.blockIndex,
                });
                state.blockIndex++;
                state.textBlockStarted = false;
              }

              // 记录这个 tool call
              state.activeToolCalls.set(toolIndex, {
                id: tc.id,
                name: tc.function?.name || "",
                anthropicIndex: state.blockIndex,
              });

              // 发送 content_block_start (tool_use)
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

            // ── 参数片段到达 ──
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

        // ─── 流结束 ─────────────────────────────────────────
        if (choice.finish_reason) {
          // 关闭打开的 text block
          if (state.textBlockStarted) {
            sendSSE(res, "content_block_stop", {
              type: "content_block_stop",
              index: state.blockIndex,
            });
          }

          // 关闭所有打开的 tool call blocks
          for (const [, tc] of state.activeToolCalls) {
            sendSSE(res, "content_block_stop", {
              type: "content_block_stop",
              index: tc.anthropicIndex,
            });
          }

          // stop_reason 翻译
          const stopReason =
            choice.finish_reason === "tool_calls"
              ? "tool_use" // ← GPT 调用了工具
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

// ─── Server ─────────────────────────────────────────────────────

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

    // ── 翻译请求 ──
    const openaiMessages: Array<{ role: string; content: string }> = [];

    if (body.system) {
      const text =
        typeof body.system === "string"
          ? body.system
          : body.system.map((b: { text: string }) => b.text).join("\n");
      openaiMessages.push({ role: "system", content: text });
    }

    for (const msg of body.messages) {
      openaiMessages.push({
        role: msg.role,
        content:
          typeof msg.content === "string"
            ? msg.content
            : msg.content.map((b: { text?: string }) => b.text || "").join(""),
      });
    }

    // 构造 OpenAI 请求（新增 tools + tool_choice）
    const maxTokens = Math.min(body.max_tokens || 4096, 16384);
    const openaiReq: Record<string, unknown> = {
      model: TARGET_MODEL,
      messages: openaiMessages,
      // 前沿模型用 max_completion_tokens，旧模型用 max_tokens
      ...(needsMaxCompletionTokens(TARGET_MODEL)
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
      stream: true,
      stream_options: { include_usage: true },
    };

    // ── 新增：翻译 tools ──
    if (body.tools && body.tools.length > 0) {
      openaiReq.tools = body.tools.map(translateToolDef);
      console.log(
        `  Tools: ${body.tools.map((t: AnthropicTool) => t.name).join(", ")}`,
      );
    }

    // ── 新增：翻译 tool_choice ──
    const toolChoice = translateToolChoice(body.tool_choice);
    if (toolChoice !== undefined) {
      openaiReq.tool_choice = toolChoice;
    }

    console.log(
      `→ ${body.model} → ${TARGET_MODEL} (${body.messages.length} msgs, ${body.tools?.length || 0} tools)`,
    );

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
      console.error(
        `← OpenAI error ${upstream.status}: ${errText.slice(0, 200)}`,
      );
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: errText },
        }),
      );
      return;
    }

    if (!upstream.body) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "No body" },
        }),
      );
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
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: String(err) },
      }),
    );
  }
});

// ─── Start ──────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   HydraProxy Iteration 4 — Tool Use       ║
╠════════════════════════════════════════════╣
║   Port:   :${PORT}                          ║
║   Target: ${TARGET_MODEL.padEnd(33)}║
║   Spoof:  ${SPOOF_MODEL.padEnd(33)}║
║   Mode:   streaming + tools (no history)   ║
╚════════════════════════════════════════════╝
  `);
});
