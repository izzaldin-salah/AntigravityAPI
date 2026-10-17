#!/usr/bin/env node
/**
 * End-to-end smoke test against the integrated BUILT server (dist/server.js).
 * Coordinator-owned integration check (Stage D).
 *
 * Phase 1 — full server with security stack (production mode, API key required):
 *   /health public + shape, auth 401s, /v1/models, non-stream chat, SSE stream
 *   (role/finish/[DONE]/usage chunk), /usage aggregation, validation 400, CORS
 *   preflight without auth, x-request-id header.
 * Phase 2 — rate limiting: RATE_LIMIT_MAX=3 -> 4th request 429 + Retry-After.
 *
 * No dependencies. Run from repo root (after `npm run build`):
 *   node scripts/smoke-e2e.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const results = [];
let failures = 0;

function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

function startServer(env) {
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.getLog = () => out;
  return child;
}

async function waitForHealth(base) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await delay(250);
  }
  return false;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, 3000);
    t.unref?.();
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill();
  });
}

const KEY = "smoke-secret-key";
const PORT1 = 3456;
const BASE1 = `http://127.0.0.1:${PORT1}`;

const server1 = startServer({
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  PORT: String(PORT1),
  API_KEYS: KEY,
  PROVIDER_MODE: "mock",
  RATE_LIMIT_MAX: "1000",
  RATE_LIMIT_WINDOW_MS: "60000",
  LOG_LEVEL: "warn",
  TRUST_PROXY: "false",
  CORS_ORIGINS: "*",
});

try {
  const ready = await waitForHealth(BASE1);
  check("server starts; /health is public", ready);
  if (!ready) {
    console.error(server1.getLog());
    process.exit(1);
  }

  const health = await (await fetch(`${BASE1}/health`)).json();
  check(
    "health shape ok (status + provider.mode)",
    health.status === "ok" && health.provider?.mode === "mock",
    JSON.stringify(health).slice(0, 140),
  );

  const noAuth = await fetch(`${BASE1}/v1/models`);
  const noAuthBody = await noAuth.json().catch(() => ({}));
  check(
    "auth: /v1/models without key -> 401 invalid_api_key",
    noAuth.status === 401 && noAuthBody.error?.code === "invalid_api_key",
    `status=${noAuth.status}`,
  );

  const badAuth = await fetch(`${BASE1}/v1/models`, {
    headers: { Authorization: "Bearer wrong-key" },
  });
  check("auth: wrong key -> 401", badAuth.status === 401, `status=${badAuth.status}`);

  const modelsRes = await fetch(`${BASE1}/v1/models`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const models = await modelsRes.json();
  const ids = (models.data || []).map((m) => m.id);
  check(
    "/v1/models with key -> OpenAI list incl. mock model",
    modelsRes.status === 200 &&
      models.object === "list" &&
      ids.some((id) => String(id).startsWith("mock")),
    `ids=${ids.join(",")}`,
  );

  const chatRes = await fetch(`${BASE1}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ids[0],
      messages: [{ role: "user", content: "hello integration" }],
    }),
  });
  const chat = await chatRes.json();
  check(
    "non-stream chat -> assistant content + usage",
    chatRes.status === 200 &&
      typeof chat.choices?.[0]?.message?.content === "string" &&
      chat.choices[0].message.content.length > 0 &&
      Number(chat.usage?.total_tokens) > 0,
    `status=${chatRes.status} tokens=${chat.usage?.total_tokens}`,
  );

  const streamRes = await fetch(`${BASE1}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ids[0],
      messages: [{ role: "user", content: "stream me" }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  const ctype = streamRes.headers.get("content-type") || "";
  check(
    "SSE headers: text/event-stream",
    streamRes.status === 200 && ctype.includes("text/event-stream"),
    `content-type=${ctype}`,
  );
  const sseText = await streamRes.text();
  const hasRole = sseText.includes('"role":"assistant"');
  const hasFinish = sseText.includes('"finish_reason":"stop"');
  const hasDone = sseText.includes("data: [DONE]");
  const hasUsageChunk = sseText.includes('"total_tokens"');
  check(
    "SSE stream: role + finish_reason + usage chunk + [DONE]",
    hasRole && hasFinish && hasDone && hasUsageChunk,
    `role=${hasRole} finish=${hasFinish} usage=${hasUsageChunk} done=${hasDone}`,
  );

  const usageRes = await fetch(`${BASE1}/usage`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const usage = await usageRes.json();
  check(
    "/usage aggregates requests + by_model",
    usageRes.status === 200 &&
      Number(usage.data?.requests) >= 2 &&
      usage.data?.by_model &&
      Object.keys(usage.data.by_model).length > 0,
    `requests=${usage.data?.requests}`,
  );

  const bad = await fetch(`${BASE1}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "no model" }] }),
  });
  const badBody = await bad.json().catch(() => ({}));
  check(
    "validation: missing model -> 400 envelope param=model",
    bad.status === 400 && badBody.error?.param === "model",
    `status=${bad.status} param=${badBody.error?.param}`,
  );

  const pre = await fetch(`${BASE1}/v1/models`, {
    method: "OPTIONS",
    headers: { Origin: "https://example.com", "Access-Control-Request-Method": "GET" },
  });
  check("CORS preflight OPTIONS public (no 401)", pre.status < 400, `status=${pre.status}`);

  const ridRes = await fetch(`${BASE1}/health`);
  check("x-request-id response header present", !!ridRes.headers.get("x-request-id"));
} finally {
  await stopServer(server1);
}

const PORT2 = 3457;
const BASE2 = `http://127.0.0.1:${PORT2}`;
const server2 = startServer({
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: String(PORT2),
  API_KEYS: KEY,
  PROVIDER_MODE: "mock",
  RATE_LIMIT_MAX: "3",
  RATE_LIMIT_WINDOW_MS: "60000",
  LOG_LEVEL: "error",
});

try {
  const ready2 = await waitForHealth(BASE2);
  check("rate-limit instance starts", ready2);
  if (ready2) {
    const codes = [];
    let lastResp = null;
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${BASE2}/v1/models`, {
        headers: { Authorization: `Bearer ${KEY}` },
      });
      codes.push(r.status);
      if (i === 3) lastResp = r;
    }
    check(
      "rate limit: first 3 x 200, 4th -> 429",
      codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429,
      `codes=${codes.join(",")}`,
    );
    const retryAfter = lastResp?.headers.get("retry-after");
    check("429 includes Retry-After header", !!retryAfter, `retry-after=${retryAfter}`);
    const rlBody = lastResp ? await lastResp.json().catch(() => ({})) : {};
    check(
      "429 envelope rate_limit_exceeded",
      rlBody.error?.code === "rate_limit_exceeded",
      `code=${rlBody.error?.code}`,
    );
  }
} finally {
  await stopServer(server2);
}

console.log("\n=== End-to-end smoke results ===");
for (const line of results) console.log(line);
console.log(
  `\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"} (${results.length} checks)`,
);
process.exit(failures === 0 ? 0 : 1);
