export const OPENCODE_BASE = "https://opencode.ai";

export const MESSAGES_FORMAT_MODELS = new Set([
  "big-pickle",
]);

export const STATIC_FALLBACK_MODELS = [
  { id: "big-pickle", name: "Big Pickle", free: true },
  { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash Free", free: true },
  { id: "mimo-v2.5-free", name: "MiMo-V2.5 Free", free: true },
  { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", free: true },
  { id: "grok-code", name: "Grok Code Fast 1", free: true },
  { id: "glm-5-free", name: "GLM 5 Free", free: true },
  { id: "kimi-k2.5-free", name: "Kimi K2.5 Free", free: true },
  { id: "minimax-m2.5-free", name: "MiniMax M2.5 Free", free: true },
];

let cachedModels = null;
let cacheTime = 0;
const CACHE_TTL = 3600 * 1000;

export function buildOpenCodeHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer public",
    "x-opencode-client": "desktop",
    "Accept": "text/event-stream",
  };
}

export function resolveEndpoint(modelId) {
  if (MESSAGES_FORMAT_MODELS.has(modelId)) {
    return `${OPENCODE_BASE}/zen/v1/messages`;
  }
  return `${OPENCODE_BASE}/zen/v1/chat/completions`;
}

export async function getFreeModels() {
  const now = Date.now();
  if (cachedModels && now - cacheTime < CACHE_TTL) {
    return cachedModels;
  }

  try {
    const resp = await fetch(`${OPENCODE_BASE}/zen/v1/models`, {
      headers: buildOpenCodeHeaders(),
    });

    if (!resp.ok) {
      throw new Error(`Failed to fetch models: ${resp.status}`);
    }

    const payload = await resp.json();
    if (Array.isArray(payload.data)) {
      const parsedModels = payload.data
        .map((m) => m.id)
        .filter((id) => id.includes("-free") || id === "big-pickle" || id === "grok-code" || id === "gpt-5-nano")
        .map((id) => ({
          id,
          name: id
            .split("-")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" "),
          free: true,
        }));

      if (parsedModels.length > 0) {
        cachedModels = parsedModels;
        cacheTime = now;
        return cachedModels;
      }
    }
  } catch (err) {
    console.error("Error fetching dynamic models, using static fallback:", err.message);
  }

  if (!cachedModels) {
    cachedModels = STATIC_FALLBACK_MODELS;
    cacheTime = now;
  }
  return cachedModels;
}
