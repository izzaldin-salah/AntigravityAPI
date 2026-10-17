import * as net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisLite, RedisLiteError } from "../../src/security/redis-lite";

describe("RedisLite (tests/security/redis-lite.test.ts)", () => {
  let server: net.Server;
  let serverPort: number;
  const inMemoryDb = new Map<string, string>();
  let lastAuthCommand: string[] | null = null;

  beforeAll(async () => {
    server = net.createServer((socket) => {
      let buffer = "";

      socket.on("data", (data) => {
        buffer += data.toString("utf8");

        // Simple RESP array parser for commands: *<count>\r\n$<len>\r\n<arg>\r\n...
        while (buffer.includes("\r\n")) {
          if (!buffer.startsWith("*")) {
            // Unhandled format or raw line
            const idx = buffer.indexOf("\r\n");
            buffer = buffer.slice(idx + 2);
            continue;
          }

          const lines = buffer.split("\r\n");
          const count = parseInt(lines[0].slice(1), 10);
          // Each arg has 2 lines: $<len> and <value>
          if (lines.length < count * 2 + 1) {
            // Need more data
            break;
          }

          const args: string[] = [];
          for (let i = 0; i < count; i++) {
            args.push(lines[1 + i * 2 + 1]);
          }

          // Consume processed lines
          const consumedLength = lines.slice(0, count * 2 + 1).join("\r\n").length + 2;
          buffer = buffer.slice(consumedLength);

          const cmd = args[0]?.toUpperCase();

          if (cmd === "PING") {
            const msg = args[1];
            if (msg) {
              socket.write(`$${msg.length}\r\n${msg}\r\n`);
            } else {
              socket.write("+PONG\r\n");
            }
          } else if (cmd === "AUTH") {
            lastAuthCommand = args;
            const pass = args.length === 2 ? args[1] : args[2];
            if (pass === "valid-secret") {
              socket.write("+OK\r\n");
            } else {
              socket.write(`-ERR invalid password: ${pass}\r\n`);
            }
          } else if (cmd === "GET") {
            const key = args[1];
            const val = inMemoryDb.get(key);
            if (val !== undefined) {
              socket.write(`$${val.length}\r\n${val}\r\n`);
            } else {
              socket.write("$-1\r\n");
            }
          } else if (cmd === "SET") {
            const key = args[1];
            const val = args[2];
            inMemoryDb.set(key, val);
            socket.write("+OK\r\n");
          } else if (cmd === "DEL") {
            const key = args[1];
            const deleted = inMemoryDb.delete(key) ? 1 : 0;
            socket.write(`:${deleted}\r\n`);
          } else if (cmd === "ERRTEST") {
            socket.write("-ERR custom simulated redis error\r\n");
          } else {
            socket.write(`-ERR unknown command '${cmd}'\r\n`);
          }
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("URL parsing: validates redis:// and rediss:// and rejects unsupported protocols", () => {
    const valid = new RedisLite(`redis://:secret@localhost:${serverPort}`);
    expect(valid).toBeInstanceOf(RedisLite);

    const validTls = new RedisLite("rediss://default:secret@remote.host:6380");
    expect(validTls).toBeInstanceOf(RedisLite);

    expect(() => new RedisLite("http://localhost:6379")).toThrowError(
      /Unsupported Redis protocol/,
    );
    expect(() => new RedisLite("not-a-url")).toThrowError(
      /Invalid REDIS_URL format/,
    );
  });

  it("AUTH on connect when password is in URL", async () => {
    const client = new RedisLite(`redis://:valid-secret@127.0.0.1:${serverPort}`);
    const pong = await client.ping();
    expect(pong).toBe("PONG");
    expect(lastAuthCommand).toEqual(["AUTH", "valid-secret"]);
    await client.close();
  });

  it("AUTH failure redacts password from error message", async () => {
    const secretPassword = "my-super-secret-password-xyz";
    const client = new RedisLite(`redis://:${secretPassword}@127.0.0.1:${serverPort}`);

    try {
      await client.ping();
      expect.unreachable("Should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RedisLiteError);
      const msg = (err as Error).message;
      expect(msg).not.toContain(secretPassword);
      expect(msg).toContain("***");
    } finally {
      await client.close();
    }
  });

  it("executes PING/GET/SET/DEL successfully", async () => {
    const client = new RedisLite(`redis://127.0.0.1:${serverPort}`);

    // PING
    expect(await client.ping()).toBe("PONG");
    expect(await client.ping("hello")).toBe("hello");

    // GET non-existent
    expect(await client.get("missing-key")).toBeNull();

    // SET
    expect(await client.set("test-key", "test-val")).toBe("OK");

    // GET existing
    expect(await client.get("test-key")).toBe("test-val");

    // DEL
    expect(await client.del("test-key")).toBe(1);
    expect(await client.get("test-key")).toBeNull();
    expect(await client.del("test-key")).toBe(0);

    await client.close();
  });

  it("surfaces Redis error replies as typed RedisLiteError", async () => {
    const client = new RedisLite(`redis://127.0.0.1:${serverPort}`);
    await expect(client.sendCommand(["ERRTEST"])).rejects.toThrowError(
      RedisLiteError,
    );
    await client.close();
  });

  it("connection failure surfaces as RedisLiteError", async () => {
    // Port 1 is typically closed/refused
    const client = new RedisLite("redis://127.0.0.1:1", {
      connectTimeoutMs: 1000,
      commandTimeoutMs: 1000,
    });
    await expect(client.ping()).rejects.toThrowError(RedisLiteError);
    await client.close();
  });
});
