#!/usr/bin/env node

// ─── OpenCode Free Models API Proxy ─────────────────────────────────────────
//
// Extracted from decolua/9router (MIT License)
// https://github.com/decolua/9router
//
// Provides an OpenAI-compatible API endpoint for OpenCode's free models.
// No API key or OpenCode installation required.
//
// Endpoints:
//   GET  /v1/models              - List available free models
//   POST /v1/chat/completions    - Chat completions (streaming + non-streaming)
//   GET  /health                 - Health check
//
// Usage:
//   curl http://localhost:4097/v1/models
//   curl http://localhost:4097/v1/chat/completions \
//     -H "Content-Type: application/json" \
//     -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hello"}],"stream":true}'

import express from "express";
import modelsRouter from "./src/routes/models.js";
import chatRouter from "./src/routes/chat.js";

const PORT = process.env.PORT || 4097;
const app = express();

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────
app.use(modelsRouter);
app.use(chatRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "openapi", upstream: "opencode.ai/zen" });
});

// Root
app.get("/", (_req, res) => {
  res.json({
    name: "OpenCode Free Models API Proxy",
    version: "1.0.0",
    docs: {
      listModels: "GET /v1/models",
      chat: "POST /v1/chat/completions",
    },
  });
});

// ─── Start ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 OpenCode Free API running at http://localhost:${PORT}`);
  console.log(`📋 Models: GET  http://localhost:${PORT}/v1/models`);
  console.log(`💬 Chat:   POST http://localhost:${PORT}/v1/chat/completions`);
});
