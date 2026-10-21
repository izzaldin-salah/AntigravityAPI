import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CredentialStoreConfig } from "../types/config";
import type { ModelSelection, ModelSettingsStore } from "../types/model-settings";
import { validSelection } from "../providers/model-policy";
import { RedisLite } from "../security/redis-lite";

/** Separate non-secret settings storage; never modifies the credential blob. */
export function createModelSettingsStore(config: CredentialStoreConfig): ModelSettingsStore {
  const backend = config.backend === "redis" || (config.backend === "auto" && config.redisUrl) ? "redis" : "file";
  const filePath = `${config.filePath}.model-settings.json`;
  const key = "antigravity:model-settings:v1";
  async function withRedis<T>(work: (client: RedisLite) => Promise<T>): Promise<T> {
    if (!config.redisUrl) throw new Error("Model settings Redis is not configured.");
    const client = new RedisLite(config.redisUrl);
    try { return await work(client); } finally { await client.close(); }
  }
  return {
    backend,
    async load() {
      let raw: string | null;
      if (backend === "redis") raw = await withRedis(client => client.get(key));
      else {
        try { raw = await readFile(filePath, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      }
      if (raw === null) return null;
      const value: unknown = JSON.parse(raw);
      if (!validSelection(value)) throw new Error("Stored model settings are invalid.");
      return { model: value.model, thinkingLevel: value.thinkingLevel };
    },
    async save(selection) {
      if (!validSelection(selection)) throw new Error("Invalid model settings.");
      const raw = JSON.stringify({ model: selection.model, thinkingLevel: selection.thinkingLevel });
      if (backend === "redis") { await withRedis(client => client.set(key, raw)); return; }
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, raw, { mode: 0o600 });
        await rename(temporary, filePath);
      } finally { await rm(temporary, { force: true }); }
    },
  };
}
