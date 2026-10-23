/** Offline, bounded load check. Both servers bind loopback; no production URL input. */
import { createServer } from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config/env";
import { AntigravityProvider } from "../src/providers/antigravity";
import { createSseWriter } from "../src/core/sse-writer";

async function main() {
  const overall = AbortSignal.timeout(30000);
  const sockets = new Set<import("node:net").Socket>();
  const upstream = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1internal:streamGenerateContent")) {
      res.writeHead(404).end();
      return;
    }
    for await (const _ of req) {
      /* bounded local request consumed */
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const writer = createSseWriter(res, overall);
    try {
      for (let i = 0; i < 128; i++) {
        if (res.destroyed) return;
        await writer.write(
          `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "x".repeat(4096) }] } }] } })}\n\n`,
        );
      }
      res.end(
        'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":100,"totalTokenCount":110}}}\n\n',
      );
    } catch {
      res.destroy();
    }
  });
  upstream.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as import("node:net").AddressInfo)
    .port;
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  const provider = new AntigravityProvider({
    accessToken: "local-fixture",
    endpoint: `http://127.0.0.1:${upstreamPort}`,
  });
  const app = await buildApp({ config, provider });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as import("node:net").AddressInfo).port;
  let peakRss = process.memoryUsage().rss;
  const sampling = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  const reports = [];
  try {
    for (const scenario of [
      { name: "normal", concurrency: 1 },
      { name: "normal", concurrency: 5 },
      { name: "normal", concurrency: 10 },
      { name: "slow reader", concurrency: 2 },
      { name: "disconnect", concurrency: 2 },
      { name: "large request", concurrency: 2 },
    ]) {
      const latencies: number[] = [];
      let errors = 0;
      let cancellations = 0;
      await Promise.all(
        Array.from({ length: scenario.concurrency }, async () => {
          for (let run = 0; run < 2; run++) {
            const controller = new AbortController();
            const started = performance.now();
            try {
              const response = await fetch(
                `http://127.0.0.1:${port}/v1/chat/completions`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  signal: AbortSignal.any([overall, controller.signal]),
                  body: JSON.stringify({
                    model: "fixture",
                    messages: [
                      {
                        role: "user",
                        content:
                          scenario.name === "large request"
                            ? "a".repeat(4 * 1024 * 1024)
                            : "hello",
                      },
                    ],
                    stream: true,
                  }),
                },
              );
              if (!response.ok || !response.body)
                throw Error(`HTTP ${response.status}`);
              const reader = response.body.getReader();
              let tail = "";
              try {
                while (true) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  tail = (tail + new TextDecoder().decode(chunk.value)).slice(
                    -512,
                  );
                  if (scenario.name === "disconnect") {
                    controller.abort();
                    cancellations++;
                    break;
                  }
                  if (scenario.name === "slow reader")
                    await delay(5, undefined, { signal: overall });
                }
              } finally {
                await reader.cancel().catch(() => undefined);
                reader.releaseLock();
              }
              if (
                scenario.name !== "disconnect" &&
                !tail.includes("data: [DONE]")
              )
                throw Error("Missing terminal frame");
              if (tail.includes('"error":')) throw Error("Stream error");
            } catch (error) {
              if (!controller.signal.aborted) errors++;
            }
            latencies.push(Math.round(performance.now() - started));
          }
        }),
      );
      latencies.sort((a, b) => a - b);
      reports.push({
        ...scenario,
        requests: latencies.length,
        errors,
        cancellations,
        p50Ms: latencies[Math.ceil(latencies.length * 0.5) - 1],
        p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
      });
    }
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          fixture: {
            responseBytes: 128 * 4096,
            largePromptBytes: 4 * 1024 * 1024,
          },
          peakRssMiB: Math.round(peakRss / 1024 / 1024),
          reports,
          limitation:
            "Synthetic loopback test in one process; not production capacity.",
        },
        null,
        2,
      ),
    );
    if (reports.some((report) => report.errors > 0)) process.exitCode = 1;
  } finally {
    clearInterval(sampling);
    await app.close();
    for (const socket of sockets) socket.destroy();
    upstream.close();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Local load check failed",
  );
  process.exitCode = 1;
});
