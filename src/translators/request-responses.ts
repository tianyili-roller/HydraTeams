import type {
  AnthropicRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicSystemBlock,
} from "./types.js";

// ─── OpenAI Responses API Types ──────────────────────────────────

export interface ResponsesAPIRequest {
  model: string;
  instructions: string;
  input: ResponsesAPIInputItem[];
  tools?: ResponsesAPITool[];
  tool_choice?: string | { type: "function"; name: string };
  store: boolean;
  stream: boolean;
}

export type ResponsesAPIInputItem =
  | ResponsesAPIMessage
  | ResponsesAPIFunctionCall
  | ResponsesAPIFunctionCallOutput;

export interface ResponsesAPIMessage {
  type: "message";
  role: "user" | "assistant";
  content: string;
}

export interface ResponsesAPIFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesAPIFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface ResponsesAPITool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ─── Translation Function ────────────────────────────────────────

export function translateRequestToResponses(
  req: AnthropicRequest,
  targetModel: string
): ResponsesAPIRequest {
  const instructions = extractSystemPrompt(req.system);
  const input = translateMessages(req.messages);
  const tools = req.tools ? translateTools(req.tools) : undefined;
  const toolChoice = req.tool_choice
    ? translateToolChoice(req.tool_choice)
    : "auto";

  return {
    model: targetModel,
    instructions,
    input,
    tools,
    tool_choice: toolChoice,
    store: false,
    stream: true,
  };
}

// ─── System Prompt Extraction ────────────────────────────────────

function extractSystemPrompt(
  system: string | AnthropicSystemBlock[] | undefined
): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

// ─── Messages Translation ────────────────────────────────────────

function translateMessages(
  messages: AnthropicMessage[]
): ResponsesAPIInputItem[] {
  const result: ResponsesAPIInputItem[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({
        type: "message",
        role: msg.role,
        content: msg.content,
      });
    } else {
      const items = translateContentBlocks(msg.content, msg.role);
      result.push(...items);
    }
  }

  return result;
}

function translateContentBlocks(
  blocks: AnthropicContentBlock[],
  role: "user" | "assistant"
): ResponsesAPIInputItem[] {
  const result: ResponsesAPIInputItem[] = [];
  let textBuffer = "";

  for (const block of blocks) {
    if (block.type === "text") {
      textBuffer += block.text;
    } else if (block.type === "tool_use") {
      if (textBuffer) {
        result.push({
          type: "message",
          role,
          content: textBuffer,
        });
        textBuffer = "";
      }
      result.push(translateToolUse(block));
    } else if (block.type === "tool_result") {
      if (textBuffer) {
        result.push({
          type: "message",
          role,
          content: textBuffer,
        });
        textBuffer = "";
      }
      result.push(translateToolResult(block));
    }
  }

  if (textBuffer) {
    result.push({
      type: "message",
      role,
      content: textBuffer,
    });
  }

  return result;
}

function translateToolUse(block: AnthropicToolUseBlock): ResponsesAPIFunctionCall {
  return {
    type: "function_call",
    id: `fc_${block.id}`,
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input),
  };
}

function translateToolResult(
  block: AnthropicToolResultBlock
): ResponsesAPIFunctionCallOutput {
  const output =
    typeof block.content === "string"
      ? block.content
      : block.content.map((c) => (c.type === "text" ? c.text : "")).join("");

  return {
    type: "function_call_output",
    call_id: block.tool_use_id,
    output,
  };
}

// ─── Tools Translation ───────────────────────────────────────────

function translateTools(tools: AnthropicTool[]): ResponsesAPITool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description || "",
    parameters: t.input_schema,
  }));
}

// ─── Tool Choice Translation ─────────────────────────────────────

function translateToolChoice(
  choice: AnthropicToolChoice
): string | { type: "function"; name: string } {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", name: choice.name };
    case "none":
      return "none";
  }
}
