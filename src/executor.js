// ─── OpenCode API Executor ─────────────────────────────────────────────────
// Extracted from decolua/9router (MIT License)
// https://github.com/decolua/9router/blob/master/open-sse/executors/opencode.js
//
// This executor reverse-engineers the opencode.ai/zen API by mimicking
// the official OpenCode desktop CLI client headers and authentication.

import { buildOpenCodeHeaders, resolveEndpoint, getFreeModels } from "./config.js";

/**
 * Execute a chat completion request against OpenCode's Zen API.
 * Supports both streaming (SSE) and non-streaming modes.
 *
 * This is a simplified version of 9router's BaseExecutor + OpenCodeExecutor:
 * - Uses `Authorization: Bearer public` (same as official CLI)
 * - Uses `x-opencode-client: desktop` (identifies as official client)
 * - Routes to correct endpoint based on model
 * - Handles OpenAI-to-Anthropic format conversion for messages-format models
 */
export async function executeOpenCode({ model, messages, stream = false, signal, requestBody }) {
  const bodyInput = requestBody || { model, messages, stream };
  const freeModels = await getFreeModels();
  if (!freeModels.some((m) => m.id === bodyInput.model)) {
    throw new Error(`Model "${bodyInput.model}" is not a known free model`);
  }

  const targetUrl = resolveEndpoint(bodyInput.model);
  const isMessagesEndpoint = targetUrl.includes("/messages");
  const headers = buildOpenCodeHeaders();

  // Build request body - convert OpenAI format to Anthropic if needed
  const body = buildRequestBody(bodyInput, undefined, undefined, isMessagesEndpoint);

  const response = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`OpenCode API error (${response.status}): ${errorText}`);
  }

  return response;
}

export function buildRequestBody(modelOrBody, messages, stream, isMessagesEndpoint, extraParams = {}) {
  const requestBody = typeof modelOrBody === "object" && modelOrBody !== null
    ? { ...modelOrBody }
    : { model: modelOrBody, messages, stream, ...extraParams };

  if (typeof requestBody.stream === "undefined") {
    requestBody.stream = false;
  }

  if (isMessagesEndpoint) {
    return buildAnthropicRequestBody(requestBody);
  }

  return { ...requestBody };
}

function buildAnthropicRequestBody(requestBody) {
  const {
    messages = [],
    tools,
    tool_choice,
    functions,
    function_call,
    stop,
    max_tokens,
    ...rest
  } = requestBody;

  const body = { ...rest };
  body.messages = mergeAdjacentMessages(convertAnthropicMessages(messages, body));
  body.max_tokens = max_tokens ?? 4096;

  if (typeof stop !== "undefined") {
    body.stop_sequences = Array.isArray(stop) ? stop : [stop];
  }

  const toolsDisabled = tool_choice === "none" || function_call === "none";
  const anthropicTools = toolsDisabled ? [] : convertAnthropicTools(tools, functions);
  if (anthropicTools.length > 0) {
    body.tools = anthropicTools;
  }

  if (!toolsDisabled) {
    const anthropicToolChoice = convertAnthropicToolChoice(tool_choice ?? function_call);
    if (anthropicToolChoice) {
      body.tool_choice = anthropicToolChoice;
    }
  }

  return body;
}

function convertAnthropicMessages(messages, body) {
  const systemParts = [];
  const converted = [];

  for (const message of messages) {
    if (message.role === "system") {
      const systemText = contentToText(message.content);
      if (systemText) systemParts.push(systemText);
      continue;
    }

    if (message.role === "tool") {
      converted.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: sanitizeToolId(message.tool_call_id || message.id),
          content: contentToText(message.content),
        }],
      });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const content = [];
      const text = contentToText(message.content);
      if (text) content.push({ type: "text", text });
      for (const toolCall of message.tool_calls) {
        if (toolCall.type && toolCall.type !== "function") continue;
        content.push({
          type: "tool_use",
          id: sanitizeToolId(toolCall.id),
          name: toolCall.function?.name || toolCall.name,
          input: parseToolArguments(toolCall.function?.arguments ?? toolCall.arguments),
        });
      }
      converted.push({ role: "assistant", content });
      continue;
    }

    converted.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: convertMessageContent(message.content),
    });
  }

  if (systemParts.length > 0) {
    body.system = systemParts.join("\n");
  }

  return converted;
}

function convertAnthropicTools(tools, functions) {
  const functionTools = [];

  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool.type !== "function" || !tool.function) continue;
      functionTools.push(tool.function);
    }
  }

  if (Array.isArray(functions)) {
    functionTools.push(...functions);
  }

  return functionTools.map((fn) => ({
    name: fn.name,
    description: fn.description || "",
    input_schema: fn.parameters || { type: "object", properties: {} },
  }));
}

function convertAnthropicToolChoice(toolChoice) {
  if (!toolChoice) return null;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return null;
  if (toolChoice === "required") return { type: "any" };
  if (typeof toolChoice === "object") {
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      return { type: "tool", name: toolChoice.function.name };
    }
    if (toolChoice.name) {
      return { type: "tool", name: toolChoice.name };
    }
  }
  return null;
}

function convertMessageContent(content) {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text || "" };
      return part;
    });
  }
  return content ?? "";
}

function contentToText(content) {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part.type === "text") return part.text || "";
      return part.text || part.content || "";
    }).filter(Boolean).join("\n");
  }
  return content ?? "";
}

function parseToolArguments(args) {
  if (!args) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function sanitizeToolId(id) {
  return String(id || `toolu_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function mergeAdjacentMessages(messages) {
  const merged = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (!previous || previous.role !== message.role) {
      merged.push(message);
      continue;
    }

    previous.content = mergeContent(previous.content, message.content);
  }
  return merged;
}

function mergeContent(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return [
      ...(Array.isArray(left) ? left : [{ type: "text", text: left || "" }]),
      ...(Array.isArray(right) ? right : [{ type: "text", text: right || "" }]),
    ];
  }
  return [left, right].filter(Boolean).join("\n");
}

export function mapAnthropicStopReason(stopReason) {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "end_turn":
    case "stop_sequence":
    case undefined:
    case null:
      return "stop";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

/**
 * Convert streaming SSE chunks from OpenCode back to OpenAI format.
 * Handles both OpenAI-format and Anthropic-format responses.
 */
export function parseStreamChunk(line, isMessagesEndpoint, streamState) {
  if (!line.startsWith("data: ")) return null;

  const data = line.slice(6).trim();

  // [DONE] signal
  if (data === "[DONE]") return { done: true };

  try {
    const parsed = JSON.parse(data);

    if (isMessagesEndpoint) {
      // Anthropic format → convert to OpenAI format
      return convertAnthropicChunk(parsed, streamState);
    }

    // Already OpenAI format - pass through
    return { data: parsed, done: false };
  } catch {
    return null;
  }
}

/**
 * Create per-request state for Anthropic streaming tool-call conversion.
 */
export function createStreamState() {
  return {
    messageId: null,
    model: "",
    toolCalls: new Map(),
    nextToolCallIndex: 0,
  };
}

/**
 * Convert Anthropic streaming message events to OpenAI-compatible chunks.
 */
export function convertAnthropicChunk(parsed, streamState = createStreamState()) {
  const chunk = (delta, finishReason = null) => ({
    data: {
      id: streamState.messageId || "chatcmpl-" + Date.now(),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: streamState.model || "",
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    },
    done: false,
  });

  switch (parsed.type) {
    case "message_start":
      streamState.messageId = parsed.message?.id || streamState.messageId || "chatcmpl-" + Date.now();
      streamState.model = parsed.message?.model || streamState.model || "";
      return chunk({ role: "assistant", content: "" });

    case "content_block_start": {
      if (parsed.content_block?.type === "tool_use") {
        const toolCallIndex = streamState.nextToolCallIndex++;
        streamState.toolCalls.set(parsed.index, toolCallIndex);
        return chunk({
          tool_calls: [{
            index: toolCallIndex,
            id: parsed.content_block.id,
            type: "function",
            function: {
              name: parsed.content_block.name,
              arguments: "",
            },
          }],
        });
      }

      if (parsed.content_block?.type === "text") {
        return chunk({ content: parsed.content_block.text || "" });
      }

      return null;
    }

    case "content_block_delta":
      if (parsed.delta?.type === "input_json_delta") {
        const toolCallIndex = streamState.toolCalls.get(parsed.index) ?? parsed.index;
        return chunk({
          tool_calls: [{
            index: toolCallIndex,
            function: {
              arguments: parsed.delta.partial_json || "",
            },
          }],
        });
      }

      if (parsed.delta?.type === "text_delta" || typeof parsed.delta?.text === "string") {
        return chunk({ content: parsed.delta?.text || "" });
      }

      return null;

    case "message_delta":
      return chunk({}, mapAnthropicStopReason(parsed.delta?.stop_reason));

    case "message_stop":
      return { done: true };

    case "ping":
      return null; // skip keepalive

    default:
      return null;
  }
}

/**
 * Convert a complete Anthropic response to OpenAI format.
 */
export function convertAnthropicResponse(body) {
  const contentBlocks = Array.isArray(body.content) ? body.content : [];
  const text = contentBlocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const toolCalls = contentBlocks
    .filter((block) => block?.type === "tool_use")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));
  const message = {
    role: "assistant",
    content: text,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: body.id || "chatcmpl-" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "",
    choices: [{
      index: 0,
      message,
      finish_reason: mapAnthropicStopReason(body.stop_reason),
    }],
    usage: {
      prompt_tokens: body.usage?.input_tokens || 0,
      completion_tokens: body.usage?.output_tokens || 0,
      total_tokens: (body.usage?.input_tokens || 0) + (body.usage?.output_tokens || 0),
    },
  };
}
