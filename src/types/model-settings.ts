export type ThinkingLevel = "low" | "medium" | "high";

/** Non-secret gateway-wide routing preferences. */
export interface ModelSelection {
  model: string;
  thinkingLevel: ThinkingLevel | null;
}

export interface ModelOption {
  id: string;
  name: string;
  thinkingLevels: ThinkingLevel[];
}

export interface ModelSettingsSnapshot extends ModelSelection {
  publicModel: string;
  storage: "memory" | "file" | "redis";
}

export interface ModelSettingsStore {
  readonly backend: "memory" | "file" | "redis";
  load(): Promise<ModelSelection | null>;
  save(selection: ModelSelection): Promise<void>;
}
