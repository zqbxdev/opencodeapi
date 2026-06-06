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
export async function executeOpenCode({ model, messages, stream = false, signal }) {
  const freeModels = await getFreeModels();
  if (!freeModels.some((m) => m.id === model)) {
    throw new Error(`Model "${model}" is not a known free model`);
  }

  const targetUrl = resolveEndpoint(model);
  const isMessagesEndpoint = targetUrl.includes("/messages");
  const headers = buildOpenCodeHeaders();

  // Build request body - convert OpenAI format to Anthropic if needed
  const body = buildRequestBody(model, messages, stream, isMessagesEndpoint);

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

/**
 * Build the request body, converting to the target API format as needed.
 *
 * OpenAI Chat Completions format (default):
 *   { model, messages: [...], stream, ... }
 *
 * Anthropic Messages format (for big-pickle):
 *   { model, messages: [{role, content}], stream, max_tokens, ... }
 */
function buildRequestBody(model, messages, stream, isMessagesEndpoint) {
  // Convert to Anthropic format if routing to /zen/v1/messages
  if (isMessagesEndpoint) {
    return {
      model,
      messages: messages.map(msg => ({
        role: msg.role === "system" ? "user" : msg.role,
        content: Array.isArray(msg.content)
          ? msg.content.map(c => c.type === "text" ? c.text : "").join("\n")
          : msg.content,
      })),
      max_tokens: 4096,
      stream,
    };
  }

  // Standard OpenAI Chat Completions format
  return {
    model,
    messages,
    stream,
  };
}

/**
 * Convert streaming SSE chunks from OpenCode back to OpenAI format.
 * Handles both OpenAI-format and Anthropic-format responses.
 */
export function parseStreamChunk(line, isMessagesEndpoint) {
  if (!line.startsWith("data: ")) return null;

  const data = line.slice(6).trim();

  // [DONE] signal
  if (data === "[DONE]") return { done: true };

  try {
    const parsed = JSON.parse(data);

    if (isMessagesEndpoint) {
      // Anthropic format → convert to OpenAI format
      return convertAnthropicChunk(parsed);
    }

    // Already OpenAI format - pass through
    return { data: parsed, done: false };
  } catch {
    return null;
  }
}

/**
 * Convert Anthropic streaming message events to OpenAI-compatible chunks.
 */
function convertAnthropicChunk(parsed) {
  switch (parsed.type) {
    case "message_start":
      return {
        data: {
          id: parsed.message?.id || "chatcmpl-" + Date.now(),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: parsed.message?.model || "",
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          }],
        },
        done: false,
      };

    case "content_block_start":
    case "content_block_delta":
      return {
        data: {
          id: "chatcmpl-" + Date.now(),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "",
          choices: [{
            index: 0,
            delta: { content: parsed.delta?.text || "" },
            finish_reason: null,
          }],
        },
        done: false,
      };

    case "message_delta":
      return {
        data: {
          id: "chatcmpl-" + Date.now(),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "",
          choices: [{
            index: 0,
            delta: {},
            finish_reason: parsed.delta?.stop_reason || null,
          }],
        },
        done: false,
      };

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
  return {
    id: body.id || "chatcmpl-" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: body.content?.[0]?.text || "",
      },
      finish_reason: body.stop_reason || "stop",
    }],
    usage: {
      prompt_tokens: body.usage?.input_tokens || 0,
      completion_tokens: body.usage?.output_tokens || 0,
      total_tokens: (body.usage?.input_tokens || 0) + (body.usage?.output_tokens || 0),
    },
  };
}
