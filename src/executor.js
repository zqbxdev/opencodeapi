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
    max_completion_tokens,
  } = requestBody;

  const body = pickAnthropicParams(requestBody);
  body.messages = mergeAdjacentMessages(convertAnthropicMessages(messages, body));
  body.max_tokens = max_tokens ?? max_completion_tokens ?? 4096;

  if (typeof stop !== "undefined") {
    body.stop_sequences = Array.isArray(stop) ? stop : [stop];
  }

  const toolsDisabled = tool_choice === "none" || function_call === "none";
  const anthropicTools = toolsDisabled ? [] : convertAnthropicTools(tools, functions);
  if (anthropicTools.length > 0) {
    body.tools = anthropicTools;

    if (!toolsDisabled) {
      const anthropicToolChoice = convertAnthropicToolChoice(tool_choice ?? function_call);
      if (anthropicToolChoice) {
        body.tool_choice = anthropicToolChoice;
      }
    }
  }

  return body;
}

function pickAnthropicParams(requestBody) {
  const body = {};
  for (const key of ["model", "stream", "temperature", "top_p", "top_k", "metadata"]) {
    if (typeof requestBody[key] !== "undefined") {
      body[key] = requestBody[key];
    }
  }
  return body;
}

function convertAnthropicMessages(messages, body) {
  const systemParts = [];
  const converted = [];
  const idContext = createToolIdContext();

  messages.forEach((message, messageIndex) => {
    if (message.role === "system") {
      const systemText = contentToText(message.content);
      if (systemText) systemParts.push(systemText);
      return;
    }

    if (message.role === "tool" || message.role === "function") {
      converted.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: resolveToolResultId(message, messageIndex, idContext),
          content: contentToText(message.content),
        }],
      });
      return;
    }

    if (message.role === "assistant" && (Array.isArray(message.tool_calls) || message.function_call)) {
      const content = [];
      const text = contentToText(message.content);
      if (text) content.push({ type: "text", text });

      if (Array.isArray(message.tool_calls)) {
        message.tool_calls.forEach((toolCall, toolIndex) => {
          if (toolCall.type && toolCall.type !== "function") return;
          const name = toolCall.function?.name || toolCall.name;
          const id = resolveAssistantToolUseId(toolCall.id, messageIndex, toolIndex, name, idContext);
          content.push({
            type: "tool_use",
            id,
            name,
            input: parseToolArguments(toolCall.function?.arguments ?? toolCall.arguments),
          });
        });
      }

      if (message.function_call) {
        const name = message.function_call.name;
        const id = resolveAssistantToolUseId(message.function_call.id, messageIndex, 0, name, idContext);
        content.push({
          type: "tool_use",
          id,
          name,
          input: parseToolArguments(message.function_call.arguments),
        });
      }

      if (content.length === 0) {
        content.push({ type: "text", text: " " });
      }

      converted.push({ role: "assistant", content });
      return;
    }

    converted.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: normalizeAnthropicContent(message.content, message.role),
    });
  });

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
  if (typeof toolChoice === "string") return { type: "tool", name: toolChoice };
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
    return content.flatMap((part) => {
      if (typeof part === "string") {
        return part ? [{ type: "text", text: part }] : [];
      }
      if (part?.type === "text") {
        return part.text ? [{ type: "text", text: part.text }] : [];
      }
      return part ? [part] : [];
    });
  }
  return content ?? "";
}

function normalizeAnthropicContent(content, role) {
  const converted = convertMessageContent(content);
  if (Array.isArray(converted)) {
    const nonEmpty = converted.filter((part) => part?.type !== "text" || part.text);
    if (nonEmpty.length > 0) return nonEmpty;
  } else if (converted) {
    return converted;
  }

  return role === "assistant" ? [{ type: "text", text: " " }] : [{ type: "text", text: " " }];
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

function createToolIdContext() {
  return {
    usedIds: new Set(),
    pendingById: new Map(),
    pendingByName: new Map(),
  };
}

function resolveAssistantToolUseId(sourceId, messageIndex, toolIndex, name, context) {
  const originalId = sourceId ? String(sourceId) : null;
  const fallback = `toolu_missing_${messageIndex}_${toolIndex}_${name || "tool"}`;
  const id = uniqueToolId(sanitizeToolId(originalId || fallback), context);
  rememberPendingToolUse(name, id, context, originalId);
  return id;
}

function resolveToolResultId(message, messageIndex, context) {
  const sourceId = message.tool_call_id || message.id;
  const resolvedById = sourceId ? shiftPendingToolUseById(sourceId, context) : null;
  if (resolvedById) return resolvedById;

  const resolvedByName = message.name ? shiftPendingToolUseByName(message.name, context) : null;
  if (resolvedByName) return resolvedByName;

  if (sourceId) return sanitizeToolId(sourceId);
  if (message.name) return sanitizeToolId(message.name);
  return sanitizeToolId(`toolu_missing_${messageIndex}_0_result`);
}

function rememberPendingToolUse(name, id, context, sourceId) {
  const idKeys = new Set([id]);
  if (sourceId) {
    idKeys.add(String(sourceId));
    idKeys.add(sanitizeToolId(sourceId));
  }

  for (const key of idKeys) {
    pushPending(context.pendingById, key, id);
  }

  if (name) {
    pushPending(context.pendingByName, sanitizeToolId(name), id);
  }
}

function pushPending(map, key, id) {
  const pending = map.get(key) || [];
  pending.push(id);
  map.set(key, pending);
}

function shiftPendingToolUseById(sourceId, context) {
  const keys = [String(sourceId), sanitizeToolId(sourceId)];
  for (const key of keys) {
    const id = shiftPending(context.pendingById, key);
    if (id) return id;
  }
  return null;
}

function shiftPendingToolUseByName(name, context) {
  return shiftPending(context.pendingByName, sanitizeToolId(name));
}

function shiftPending(map, key) {
  const pending = map.get(key);
  if (!pending?.length) return null;
  const id = pending.shift();
  if (pending.length === 0) map.delete(key);
  return id;
}

function uniqueToolId(id, context) {
  let candidate = id;
  let suffix = 1;
  while (context.usedIds.has(candidate)) {
    candidate = `${id}_${suffix++}`;
  }
  context.usedIds.add(candidate);
  return candidate;
}

function sanitizeToolId(id) {
  return String(id || "toolu_missing").replace(/[^a-zA-Z0-9_-]/g, "_");
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

const SUPPRESSED_CONTENT_BLOCK_TYPES = new Set([
  "thinking",
  "redacted_thinking",
  "reasoning",
  "signature",
]);

const SUPPRESSED_DELTA_TYPES = new Set([
  "thinking_delta",
  "redacted_thinking_delta",
  "reasoning_delta",
  "signature_delta",
]);

function isSuppressedContentBlock(block) {
  return SUPPRESSED_CONTENT_BLOCK_TYPES.has(block?.type);
}

function isSuppressedDelta(delta) {
  return SUPPRESSED_DELTA_TYPES.has(delta?.type)
    || typeof delta?.thinking === "string"
    || typeof delta?.reasoning === "string"
    || typeof delta?.reasoning_content === "string"
    || typeof delta?.signature === "string";
}

function stripTaggedThinking(text) {
  if (!text) return text || "";
  return text
    .replace(/<\s*(think|thinking)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(think|thinking)\b[^>]*>[\s\S]*$/gi, "");
}

function createThinkingTagFilter() {
  return {
    pending: "",
    suppressing: false,
  };
}

function stripTaggedThinkingDelta(text, filter = createThinkingTagFilter()) {
  if (!text) return "";

  const input = filter.pending + text;
  filter.pending = "";
  let output = "";
  let index = 0;

  while (index < input.length) {
    const rest = input.slice(index);

    if (filter.suppressing) {
      const close = rest.match(/^<\s*\/\s*(think|thinking)\s*>/i);
      if (close) {
        filter.suppressing = false;
        index += close[0].length;
        continue;
      }

      const nextTag = rest.indexOf("<");
      if (nextTag === -1) {
        index = input.length;
        continue;
      }

      if (nextTag > 0) {
        index += nextTag;
        continue;
      }

      if (isPotentialThinkingClosePrefix(rest)) {
        filter.pending = rest;
        break;
      }

      index += 1;
      continue;
    }

    const open = rest.match(/^<\s*(think|thinking)\b[^>]*>/i);
    if (open) {
      filter.suppressing = true;
      index += open[0].length;
      continue;
    }

    if (rest[0] === "<" && isPotentialThinkingOpenPrefix(rest)) {
      filter.pending = rest;
      break;
    }

    output += rest[0];
    index += 1;
  }

  return output;
}

function isPotentialThinkingOpenPrefix(value) {
  return isPotentialTagPrefix(value, ["<think", "<thinking"]);
}

function isPotentialThinkingClosePrefix(value) {
  return isPotentialTagPrefix(value, ["</think", "</thinking"]);
}

function isPotentialTagPrefix(value, targets) {
  const normalized = value.toLowerCase().replace(/^<\s*/, "<").replace(/^<\/\s*/, "</");
  return targets.some((target) => target.startsWith(normalized));
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

    if (streamState && Array.isArray(parsed.choices)) {
      for (const choice of parsed.choices) {
        if (typeof choice?.delta?.content === "string") {
          choice.delta.content = stripTaggedThinkingDelta(choice.delta.content, streamState.thinkingTagFilter);
        }
      }
    }
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
    thinkingTagFilter: createThinkingTagFilter(),
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

      if (isSuppressedContentBlock(parsed.content_block)) {
        return null;
      }

      if (parsed.content_block?.type === "text") {
        const content = stripTaggedThinkingDelta(parsed.content_block.text || "", streamState.thinkingTagFilter);
        return content === "" ? null : chunk({ content });
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

      if (isSuppressedDelta(parsed.delta)) {
        return null;
      }

      if (parsed.delta?.type === "text_delta" || typeof parsed.delta?.text === "string") {
        const content = stripTaggedThinkingDelta(parsed.delta?.text || "", streamState.thinkingTagFilter);
        return content === "" ? null : chunk({ content });
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
  const textBlocks = contentBlocks
    .filter((block) => !isSuppressedContentBlock(block) && block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
  const text = stripTaggedThinking(textBlocks.join(""));
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
    content: (text === "" && toolCalls.length > 0) ? null : text,
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
