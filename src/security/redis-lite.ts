/**
 * Minimal RESP2 Redis client built on node:net and node:tls.
 * Owner: antigravity-deployment-agent.
 * Frozen seam: docs/architecture-contract.md §13.6, §16.
 * Zero external dependencies.
 */
import * as net from "node:net";
import * as tls from "node:tls";

export class RedisLiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisLiteError";
  }
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutId: NodeJS.Timeout;
}

export interface RedisLiteOptions {
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export class RedisLite {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly queue: PendingCommand[] = [];
  private connectingPromise: Promise<void> | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly tls: boolean;
  private readonly username?: string;
  private readonly password?: string;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(redisUrl: string, opts?: RedisLiteOptions) {
    this.connectTimeoutMs = opts?.connectTimeoutMs ?? 5000;
    this.commandTimeoutMs = opts?.commandTimeoutMs ?? 5000;

    let parsed: URL;
    try {
      parsed = new URL(redisUrl);
    } catch {
      throw new RedisLiteError("Invalid REDIS_URL format");
    }

    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new RedisLiteError(
        `Unsupported Redis protocol: ${parsed.protocol} (expected redis: or rediss:)`,
      );
    }

    this.tls = parsed.protocol === "rediss:";
    this.host = parsed.hostname || "127.0.0.1";
    this.port = parsed.port ? Number(parsed.port) : 6379;
    this.username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    this.password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  }

  private redact(msg: string): string {
    if (!this.password) return msg;
    return msg.replaceAll(this.password, "***");
  }

  public async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed && !this.connectingPromise) return;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.cleanupSocket(new RedisLiteError("Redis connection timeout"));
          reject(new RedisLiteError("Redis connection timeout"));
        }
      }, this.connectTimeoutMs);

      const onConnect = async () => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        try {
          if (this.password) {
            const authArgs = this.username
              ? ["AUTH", this.username, this.password]
              : ["AUTH", this.password];
            await this.sendRaw<string>(authArgs);
          }
          resolve();
        } catch (err: unknown) {
          this.cleanupSocket(err instanceof Error ? err : new Error(String(err)));
          reject(err);
        }
      };

      const onError = (err: Error) => {
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          reject(new RedisLiteError(this.redact(err.message)));
        }
      };

      if (this.tls) {
        this.socket = tls.connect({
          host: this.host,
          port: this.port,
          servername: this.host,
        }, onConnect);
      } else {
        this.socket = net.createConnection({
          host: this.host,
          port: this.port,
        }, onConnect);
      }

      this.socket.on("error", onError);
      this.socket.on("data", (chunk: Buffer | string) => {
        this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      this.socket.on("close", () => {
        this.cleanupSocket(new RedisLiteError("Connection closed by server"));
      });
    }).finally(() => {
      this.connectingPromise = null;
    });

    return this.connectingPromise;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processResponses();
  }

  private processResponses(): void {
    while (this.buffer.length > 0 && this.queue.length > 0) {
      const parsed = this.parseResp(0);
      if (!parsed) break; // incomplete packet

      const { value, error, bytesRead } = parsed;
      this.buffer = this.buffer.subarray(bytesRead);
      const cmd = this.queue.shift();
      if (cmd) {
        clearTimeout(cmd.timeoutId);
        if (error) {
          cmd.reject(new RedisLiteError(this.redact(error)));
        } else {
          cmd.resolve(value);
        }
      }
    }
  }

  private parseResp(offset: number): { value?: unknown; error?: string; bytesRead: number } | null {
    if (this.buffer.length <= offset) return null;
    const type = this.buffer[offset];
    const crlf = this.buffer.indexOf("\r\n", offset);
    if (crlf === -1) return null;

    if (type === 43) { // '+' simple string
      const str = this.buffer.toString("utf8", offset + 1, crlf);
      return { value: str, bytesRead: crlf + 2 - offset };
    }
    if (type === 45) { // '-' error
      const err = this.buffer.toString("utf8", offset + 1, crlf);
      return { error: err, bytesRead: crlf + 2 - offset };
    }
    if (type === 58) { // ':' integer
      const num = parseInt(this.buffer.toString("utf8", offset + 1, crlf), 10);
      return { value: num, bytesRead: crlf + 2 - offset };
    }
    if (type === 36) { // '$' bulk string
      const lenStr = this.buffer.toString("utf8", offset + 1, crlf);
      const len = parseInt(lenStr, 10);
      if (len === -1) {
        return { value: null, bytesRead: crlf + 2 - offset };
      }
      const dataStart = crlf + 2;
      const dataEnd = dataStart + len;
      if (this.buffer.length < dataEnd + 2) return null;
      const str = this.buffer.toString("utf8", dataStart, dataEnd);
      return { value: str, bytesRead: dataEnd + 2 - offset };
    }
    if (type === 42) { // '*' array
      const count = parseInt(this.buffer.toString("utf8", offset + 1, crlf), 10);
      if (count === -1) return { value: null, bytesRead: crlf + 2 - offset };
      let cur = crlf + 2;
      const arr: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const item = this.parseResp(cur);
        if (!item) return null;
        if (item.error) throw new RedisLiteError(item.error);
        arr.push(item.value);
        cur += item.bytesRead;
      }
      return { value: arr, bytesRead: cur - offset };
    }

    throw new RedisLiteError(`Unexpected RESP type byte: ${type}`);
  }

  private sendRaw<T = unknown>(args: string[]): Promise<T> {
    if (!this.socket || this.socket.destroyed) {
      throw new RedisLiteError("Socket not connected");
    }

    let resp = `*${args.length}\r\n`;
    for (const arg of args) {
      const buf = Buffer.from(arg, "utf8");
      resp += `$${buf.length}\r\n${arg}\r\n`;
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.queue.findIndex((c) => c.timeoutId === timeoutId);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(new RedisLiteError("Redis command timeout"));
      }, this.commandTimeoutMs);

      this.queue.push({
        resolve: resolve as (val: unknown) => void,
        reject,
        timeoutId,
      });

      this.socket!.write(resp, (err) => {
        if (err) {
          clearTimeout(timeoutId);
          const idx = this.queue.findIndex((c) => c.timeoutId === timeoutId);
          if (idx !== -1) this.queue.splice(idx, 1);
          reject(new RedisLiteError(this.redact(err.message)));
        }
      });
    });
  }

  public async sendCommand<T = unknown>(args: string[]): Promise<T> {
    await this.connect();
    return this.sendRaw<T>(args);
  }

  public async ping(message?: string): Promise<string> {
    const args = message ? ["PING", message] : ["PING"];
    return (await this.sendCommand<string>(args)) || "PONG";
  }

  public async get(key: string): Promise<string | null> {
    return await this.sendCommand<string | null>(["GET", key]);
  }

  public async set(key: string, value: string): Promise<string> {
    return await this.sendCommand<string>(["SET", key, value]);
  }

  public async del(key: string): Promise<number> {
    return await this.sendCommand<number>(["DEL", key]);
  }

  public async auth(password: string, username?: string): Promise<string> {
    const args = username ? ["AUTH", username, password] : ["AUTH", password];
    return await this.sendCommand<string>(args);
  }

  public async close(): Promise<void> {
    this.cleanupSocket();
  }

  private cleanupSocket(err?: Error): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    while (this.queue.length > 0) {
      const cmd = this.queue.shift();
      if (cmd) {
        clearTimeout(cmd.timeoutId);
        cmd.reject(err || new RedisLiteError("Socket closed"));
      }
    }
    this.buffer = Buffer.alloc(0);
  }
}
