import { describe, it, expect } from "vitest";
import { createProviderFromConfig, AntigravityProvider } from "../../src/providers";
import { ProviderError } from "../../src/types/provider";
import type { ProviderConfig } from "../../src/types/config";

describe("createProviderFromConfig", () => {
  it("rejects the removed mock mode instead of returning simulated responses", () => {
    const config = { mode: "mock" } as unknown as ProviderConfig;
    expect(() => createProviderFromConfig(config)).toThrowError(ProviderError);
  });

  it("returns AntigravityProvider when mode is antigravity", () => {
    const config: ProviderConfig = {
      mode: "antigravity",
      credentials: {
        accessToken: "test-token",
        projectId: "test-proj",
      },
    };
    const provider = createProviderFromConfig(config);
    expect(provider).toBeInstanceOf(AntigravityProvider);
    expect(provider.id).toBe("antigravity");
  });

  it("throws invalid_request ProviderError when mode is unknown", () => {
    const config = { mode: "unsupported-mode" } as unknown as ProviderConfig;
    expect(() => createProviderFromConfig(config)).toThrowError(ProviderError);
    try {
      createProviderFromConfig(config);
    } catch (err) {
      expect((err as ProviderError).payload.code).toBe("invalid_request");
    }
  });
});
