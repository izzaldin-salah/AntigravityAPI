import type { FastifyInstance } from "fastify";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { trackProvider, type RequestTracker } from "../core/request-tracker";
import { parseCookie } from "./auth";
import { verifyCsrfToken } from "../security/csrf";
import { ProviderError, type AIProvider } from "../types/provider";
import type { SessionStore } from "../types/admin";
import type { AppConfig } from "../types/config";

export function registerOperations(app: FastifyInstance, deps: {
  config: AppConfig; provider: AIProvider; sessionStore: SessionStore; requestTracker: RequestTracker;
}): void {
  const provider = trackProvider(deps.provider, deps.requestTracker, "connection test");
  // One upstream test at a time per gateway; never allow an admin click storm.
  let running = false;
  let nextAllowedAt = 0;
  app.register(async scope => {
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const id = parseCookie(request.headers.cookie, "admin_session");
      if (!id || !(await deps.sessionStore.get(id))) return reply.code(401).send({ error: "Sign in to the dashboard to continue." });
    });
    scope.addHook("preHandler", async (request, reply) => {
      if (request.method !== "POST") return;
      const id = parseCookie(request.headers.cookie, "admin_session");
      const session = id ? await deps.sessionStore.get(id) : null;
      const body = request.body as Record<string, unknown> | undefined;
      const token = request.headers["x-csrf-token"] ?? body?.csrf_token;
      if (!session || typeof token !== "string" || !verifyCsrfToken(session.csrfToken, token)) {
        return reply.code(403).send({ error: "Your session has expired or the form token is invalid. Refresh the dashboard and try again." });
      }
    });
    scope.get("/admin/api/operations", async () => deps.requestTracker.snapshot());
    scope.post("/admin/actions/api-key", async (_request, reply) => {
      const key = deps.config.apiKeys[0];
      if (!key) return reply.code(404).send({ error: "No API key is configured." });
      return { key };
    });
    scope.post("/admin/actions/test-connection", async (request, reply) => {
      if (running || Date.now() < nextAllowedAt) {
        reply.header("Retry-After", "10");
        return reply.code(429).send({ error: "Wait a few seconds before running another connection test." });
      }
      running = true;
      const started = performance.now();
      const controller = new AbortController();
      const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.on("close", onClose);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const work = async () => {
          const models = await provider.listModels();
          if (controller.signal.aborted) throw new Error("Test cancelled");
          if (!models[0]) throw new Error("No model available");
          let response = "";
          let completed = false;
          let model = models[0].id;
          for await (const event of provider.chat({ model, messages: [{ role: "user", content: "Reply with exactly: Connection OK." }], stream: false, maxTokens: 64, requestId: `admin_test_${randomUUID()}`, signal: controller.signal })) {
            if (event.type === "start") model = event.model;
            if (event.type === "delta") response = (response + event.text).slice(0, 2048);
            if (event.type === "error") throw new ProviderError(event.error);
            if (event.type === "done") completed = event.finishReason !== "error";
          }
          if (!completed || !response.trim()) throw new Error("No usable response");
          return { ok: true, model, response, durationMs: Math.round(performance.now() - started) };
        };
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new ProviderError({ code: "timeout", message: "Connection test timed out" });
            controller.abort(error);
            reject(error);
          }, 30000);
          timeout.unref?.();
        });
        return await Promise.race([work(), deadline]);
      } catch (error) {
        const code = error instanceof ProviderError ? error.payload.code : "unknown";
        const message = code === "timeout" ? "The provider did not finish within 30 seconds. Try again shortly."
          : code === "unauthorized" ? "Account authorization was rejected. Reconnect your Google account, then test again."
          : code === "rate_limited" ? "The provider is rate limiting requests. Wait before trying again."
          : "The provider could not complete the test. Check your account connection and try again.";
        return reply.code(code === "timeout" ? 504 : 502).send({ ok: false, error: message, durationMs: Math.round(performance.now() - started) });
      } finally {
        if (timeout) clearTimeout(timeout);
        reply.raw.off("close", onClose);
        running = false;
        nextAllowedAt = Date.now() + 10000;
      }
    });
  });
}
