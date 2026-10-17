/**
 * Coordinator smoke test — proves the scaffold baseline builds and serves /health.
 * Agents add their own suites under tests/<zone>/.
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config/env";
import type { AIProvider } from "../src/types/provider";

const smokeProvider: AIProvider = {
  id: "smoke",
  async listModels() {
    return [];
  },
  async *chat() {
    yield { type: "done", finishReason: "stop" as const };
  },
  async getUsage() {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  },
};

describe("scaffold smoke", () => {
  it("GET /health responds 200 with status ok", async () => {
    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const app = await buildApp({ config, provider: smokeProvider });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });
});
