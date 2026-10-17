import Fastify from "fastify";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  getRedactionConfig,
  redactBearerToken,
  redactSensitiveObject,
} from "../../src/security/redaction";
import { REDACT_LOG_PATHS } from "../../src/types/config";

describe("Log Redaction (tests/security/redaction.test.ts)", () => {
  it("builds fastify with REDACT_LOG_PATHS, captures pino output via stream, and asserts secret is [Redacted]", async () => {
    let logOutput = "";
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logOutput += chunk.toString();
        callback();
      },
    });

    const app = Fastify({
      logger: {
        level: "info",
        redact: {
          paths: REDACT_LOG_PATHS,
          censor: "[Redacted]",
        },
        stream: logStream,
      },
    });

    app.get("/log-test", async (request) => {
      // Log nested object containing sensitive credentials
      request.log.info(
        {
          credentials: {
            apiKey: "super-secret-key-12345",
            clientSecret: "client-secret-9999",
            token: "oauth-token-val",
          },
        },
        "Processed request with credentials",
      );
      return { ok: true };
    });

    const res = await app.inject({
      method: "GET",
      url: "/log-test",
    });

    expect(res.statusCode).toBe(200);

    // Wait briefly for stream write flush
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(logOutput).toContain('"apiKey":"[Redacted]"');
    expect(logOutput).toContain('"clientSecret":"[Redacted]"');
    expect(logOutput).toContain('"token":"[Redacted]"');
    expect(logOutput).not.toContain("super-secret-key-12345");
    expect(logOutput).not.toContain("client-secret-9999");

    await app.close();
  });

  it("redactSensitiveObject recursively redacts known sensitive fields", () => {
    const input = {
      user: "alice",
      apiKey: "secret-key",
      nested: {
        refreshToken: "refresh-val",
        publicData: 123,
      },
      list: [{ clientSecret: "secret-in-array", name: "item1" }],
    };

    const redacted = redactSensitiveObject(input);
    expect(redacted.apiKey).toBe("[Redacted]");
    expect(redacted.nested.refreshToken).toBe("[Redacted]");
    expect(redacted.nested.publicData).toBe(123);
    expect(redacted.list[0].clientSecret).toBe("[Redacted]");
    expect(redacted.list[0].name).toBe("item1");
    expect(redacted.user).toBe("alice");
  });

  it("redactBearerToken redacts Authorization token strings", () => {
    expect(redactBearerToken("Bearer my-secret-api-key")).toBe("Bearer [Redacted]");
    expect(redactBearerToken("")).toBe("");
    expect(redactBearerToken(undefined)).toBe("");
  });

  it("getRedactionConfig returns valid Pino configuration", () => {
    const config = getRedactionConfig();
    expect(config.censor).toBe("[Redacted]");
    expect(config.paths).toContain("req.headers.authorization");
    expect(config.paths).toContain("*.apiKey");
  });
});
