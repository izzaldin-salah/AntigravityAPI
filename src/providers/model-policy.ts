import type { ModelOption, ModelSelection, ThinkingLevel } from "../types/model-settings";

export const DEFAULT_MODEL_SELECTION: ModelSelection = { model: "gemini-3.8-flash-tiered", thinkingLevel: "high" };

/** Only families handled by this gateway's text transport are selectable. */
export function modelOption(id: string): ModelOption | null {
  if (!/^[a-z0-9][a-z0-9.-]{0,119}$/.test(id) || /image|audio|vision|embedding|robotics/.test(id)) return null;
  let thinkingLevels: ThinkingLevel[];
  if (/^gemini-(3(?:\.\d+)?|4)(?:-|$)/.test(id)) {
    // Original Gemini 3 Pro supports only low and high; 3.1 Pro adds medium.
    thinkingLevels = /^gemini-3-pro/.test(id) ? ["low", "high"] : ["low", "medium", "high"];
  } else if (/^gemini-2\.5-(flash|pro)(?:-|$)/.test(id)) {
    thinkingLevels = ["low", "medium", "high"];
  } else if (/^claude-(sonnet|opus|haiku)-/.test(id)) {
    thinkingLevels = ["low", "medium", "high"];
  } else return null;
  return { id, name: id, thinkingLevels };
}

export function validSelection(value: unknown): value is ModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as ModelSelection;
  if (typeof selection.model !== "string") return false;
  const option = modelOption(selection.model);
  // Null means provider-default behavior. Discovery validates whether a new
  // selection must include a thinking level before it can be persisted.
  return !!option && (selection.thinkingLevel === null || option.thinkingLevels.includes(selection.thinkingLevel as ThinkingLevel));
}

export function publicModel(selection: ModelSelection): string {
  return selection.model.endsWith("-tiered")
    ? `${selection.model.slice(0, -7)}-${selection.thinkingLevel}`
    : selection.model;
}

export function thinkingConfig(selection: ModelSelection, maxTokens?: number): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (maxTokens !== undefined) config.maxOutputTokens = maxTokens;
  if (selection.thinkingLevel === null) return config;
  if (/^gemini-(3|4)/.test(selection.model)) {
    config.thinkingConfig = { includeThoughts: true, thinkingLevel: selection.thinkingLevel.toUpperCase() };
  } else {
    // Gateway effort presets for budget-based Gemini 2.5 / Claude thinking models.
    const budget = { low: 1024, medium: 8192, high: 16384 }[selection.thinkingLevel];
    config.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };
    // Budget-based thinking needs headroom for both reasoning and visible output.
    config.maxOutputTokens = budget + (maxTokens ?? 8192);
  }
  return config;
}
