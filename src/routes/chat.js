import { Router } from "express";
import { executeOpenCode, parseStreamChunk, convertAnthropicResponse, createStreamState } from "../executor.js";
import { getFreeModels, resolveEndpoint } from "../config.js";

const router = Router();

router.post("/v1/chat/completions", async (req, res) => {
  const requestBody = req.body;
  const { model, messages, stream = false } = requestBody;

  if (!model) {
    return res.status(400).json({ error: "model is required" });
  }

  const freeModels = await getFreeModels();
  const modelExists = freeModels.some((m) => m.id === model);

  if (!modelExists) {
    return res.status(400).json({
      error: `Model "${model}" is not available. Free models: ${freeModels.map((m) => m.id).join(", ")}`,
    });
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }

  const isMessagesEndpoint = resolveEndpoint(model).includes("/messages");

  if (stream) {
    return handleStreaming(req, res, { ...requestBody, stream: true }, isMessagesEndpoint);
  }

  return handleNonStreaming(req, res, { ...requestBody, stream: false }, isMessagesEndpoint);
});

async function handleStreaming(req, res, requestBody, isMessagesEndpoint) {
  const abortController = new AbortController();

  res.on("close", () => {
    abortController.abort();
  });

  try {
    const upstream = await executeOpenCode({
      requestBody,
      signal: abortController.signal,
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const streamState = isMessagesEndpoint ? createStreamState() : undefined;
    let buffer = "";
    let doneSent = false;

    const sendDone = () => {
      if (doneSent) return;
      res.write("data: [DONE]\n\n");
      doneSent = true;
    };

    while (true) {
      if (abortController.signal.aborted || doneSent) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const raw of lines) {
        if (!raw.trim()) continue;
        const chunk = parseStreamChunk(raw, isMessagesEndpoint, streamState);
        if (!chunk) continue;
        if (chunk.done) {
          sendDone();
          break;
        }
        res.write(`data: ${JSON.stringify(chunk.data)}\n\n`);
      }
    }

    if (!doneSent) {
      const remaining = buffer + decoder.decode();
      if (remaining.trim()) {
        const chunk = parseStreamChunk(remaining, isMessagesEndpoint, streamState);
        if (chunk?.done) {
          sendDone();
        } else if (chunk) {
          res.write(`data: ${JSON.stringify(chunk.data)}\n\n`);
        }
      }
    }

    sendDone();
    res.end();
  } catch (err) {
    if (err.name === "AbortError") return;
    if (!res.headersSent) {
      res.status(502).json({ error: err.message });
    } else {
      try { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); } catch {}
    }
  }
}

async function handleNonStreaming(req, res, requestBody, isMessagesEndpoint) {
  try {
    const response = await executeOpenCode({
      requestBody,
    });

    const body = await response.json();

    if (isMessagesEndpoint) {
      return res.json(convertAnthropicResponse(body));
    }

    return res.json(body);
  } catch (err) {
    console.error("Non-streaming error:", err);
    res.status(502).json({ error: err.message });
  }
}

export default router;
