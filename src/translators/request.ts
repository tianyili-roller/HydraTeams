import type {
  AnthropicRequest,
  AnthropicTool,
  AnthropicToolChoice,
  OpenAIRequest,
  OpenAITool,
  OpenAIToolChoice,
} from "./types.js";
import { translateMessages } from "./messages.js";

/**
 * Translate a full Anthropic Messages API request to an OpenAI Chat Completions API request.
 */
export function translateRequest(
  req: AnthropicRequest,
  targetModel: string
): OpenAIRequest {
  // Clamp max_tokens — Claude allows 32k+ but GPT-4o caps at 16384
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
    messages: translateMessages(req.system, req.messages),
    max_tokens: maxTokens,
    temperature: req.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (req.tools && req.tools.length > 0) {
    result.tools = req.tools.map(translateToolDef);
  }

  const toolChoice = translateToolChoice(req.tool_choice);
  if (toolChoice !== undefined) {
    result.tool_choice = toolChoice;
  }

  return result;
}

/**
 * Translate an Anthropic tool definition to an OpenAI function tool definition.
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
 * Translate Anthropic tool_choice to OpenAI tool_choice.
 *
 * auto → "auto"
 * any  → "required"
 * tool → { type: "function", function: { name } }
 * none → "none"
 */
function translateToolChoice(
  choice?: AnthropicToolChoice
): OpenAIToolChoice | undefined {
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
    default:
      return undefined;
  }
}
