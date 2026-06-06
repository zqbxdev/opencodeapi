import { Router } from "express";
import { getFreeModels } from "../config.js";

const router = Router();

router.get("/v1/models", async (_req, res) => {
  try {
    const freeModels = await getFreeModels();
    res.json({
      object: "list",
      data: freeModels.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "opencode",
        permission: [],
        root: m.id,
        parent: null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
