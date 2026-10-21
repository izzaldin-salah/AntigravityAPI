/**
 * Tool-calling mapping between the OpenAI-compatible request contract and the
 * Antigravity / Cloud Code Assist wire format.
 *
 * Reference implementation: Oh My Pi (MIT) —
 *   packages/ai/src/providers/google-gemini-cli.ts   (tools, toolConfig, forced-tool directive)
 *   packages/ai/src/providers/google-shared.ts       (functionCall / functionResponse parts)
 *   packages/ai/src/utils/schema/fields.ts          (CCA-unsupported schema keywords)
 * Provenance and the upstream findings are recorded in docs/omp-analysis.md §12.
 *
 * Wire facts this module encodes (all verified against the OMP source):
 *  - tools are declared as a single `tools: [{ functionDeclarations: [...] }]` group;
 *  - `toolConfig.functionCallingConfig.mode` accepts AUTO | ANY | NONE | VALIDATED;
 *  - Cloud Code Assist DROPS `toolConfig` on Antigravity's Gemini routes, so a
 *    forced choice (ANY) is restated in the transcript as a text directive, and
 *    `mode: "NONE"` is ignored (calls are still emitted) — the only reliable
 *    way to forbid tools is to not declare them;
 *  - Antigravity's default tool mode is VALIDATED;
 *  - tool results travel as a `user` turn holding `functionResponse` parts, and
 *    Cloud Code Assist requires all function responses of one turn to be merged
 *    into a single user turn;
 *  - a replayed function call keeps the upstream `id` and its `thoughtSignature`
 *    (Gemini 3 family rejects a function call that lost its signature).
 */
import type {
  ChatMessage,
  NormalizedChatRequest,
  ToolDefinition,
} from "../types/provider";
import { sanitizeSchemaForCca } from "./json-schema";

export { sanitizeSchemaForCca } from "./json-schema";

export type FunctionCallingMode = "AUTO" | "ANY" | "NONE" | "VALIDATED";

export interface UpstreamFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface UpstreamTool {
  functionDeclarations: UpstreamFunctionDeclaration[];
}

export interface UpstreamToolConfig {
  functionCallingConfig: {
    mode: FunctionCallingMode;
    allowedFunctionNames?: string[];
  };
}

/**
 * A replayed tool call. Live-verified 2026-10-21: the upstream sends and
 * accepts the thought signature as a SIBLING of `functionCall`
 * (`{ thoughtSignature, functionCall }`). Nesting it inside `functionCall` is
 * rejected with "Unknown name thoughtSignature", and omitting it is rejected
 * with "Function call is missing a thought_signature".
 */
export interface UpstreamFunctionCallPart {
  [key: string]: unknown;
  functionCall: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  thoughtSignature?: string;
}

export interface UpstreamFunctionResponsePart {
  [key: string]: unknown;
  functionResponse: {
    name: string;
    response: { output: string };
  };
}

/**
 * Text directive appended to the transcript when the client forces a tool
 * choice. Cloud Code Assist ignores `toolConfig` on Antigravity's Gemini
 * routes, so the requirement has to be restated in the conversation itself.
 * Adapted from OMP's `google-antigravity-forced-tool.md` (MIT).
 */
export const FORCED_TOOL_DIRECTIVE =
  "TOOL-ONLY TURN. This turn accepts a tool call and nothing else; a text reply here is discarded unread and you will be re-prompted. Emit the tool call now.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map OpenAI tool definitions to the upstream `functionDeclarations` group. */
export function buildUpstreamTools(
  tools: ToolDefinition[] | undefined,
): UpstreamTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const declarations: UpstreamFunctionDeclaration[] = [];
  for (const tool of tools) {
    const fn = tool.function;
    if (!fn || typeof fn.name !== "string" || fn.name.trim().length === 0) {
      continue;
    }
    const declaration: UpstreamFunctionDeclaration = { name: fn.name };
    if (typeof fn.description === "string" && fn.description.length > 0) {
      declaration.description = fn.description;
    }
    if (fn.parameters) {
      const sanitized = sanitizeSchemaForCca(fn.parameters);
      if (isPlainObject(sanitized)) {
        declaration.parameters = sanitized as Record<string, unknown>;
      }
    }
    declarations.push(declaration);
  }
  if (declarations.length === 0) return undefined;
  return [{ functionDeclarations: declarations }];
}

export interface ToolPlan {
  /** Tools to declare upstream; omitted when the client forbade tool use. */
  tools?: UpstreamTool[];
  /** Tool-calling mode for upstream. */
  toolConfig?: UpstreamToolConfig;
  /** Directive appended to the transcript when a forced choice is requested. */
  forcedDirective?: string;
}

/**
 * Decide how the client's `tools` / `tool_choice` are expressed upstream.
 *
 *  - no tools            -> nothing is sent (tool_choice is meaningless)
 *  - `none`              -> tools are not declared at all; Cloud Code Assist
 *                           ignores `mode: "NONE"` and still emits calls
 *  - `auto` / unset      -> Antigravity's default tool mode, VALIDATED
 *  - `required`          -> mode ANY plus a transcript directive, because
 *                           Cloud Code Assist drops toolConfig on Gemini routes
 *  - a named function    -> mode ANY with allowedFunctionNames plus directive
 */
export function planToolCall(input: {
  tools?: ToolDefinition[];
  toolChoice?: NormalizedChatRequest["toolChoice"];
}): ToolPlan {
  const upstreamTools = buildUpstreamTools(input.tools);
  if (!upstreamTools) return {};

  const choice = input.toolChoice;
  if (choice === "none") return {};

  if (choice && typeof choice === "object") {
    const name = choice.function?.name;
    if (typeof name !== "string" || name.length === 0) {
      return { tools: upstreamTools, toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } };
    }
    return {
      tools: upstreamTools,
      toolConfig: {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] },
      },
      forcedDirective: FORCED_TOOL_DIRECTIVE,
    };
  }

  if (choice === "required") {
    return {
      tools: upstreamTools,
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
      forcedDirective: FORCED_TOOL_DIRECTIVE,
    };
  }

  return {
    tools: upstreamTools,
    toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
  };
}

/** Map tool call ids to function names from the assistant turns. */
export function collectToolCallNames(
  messages: ChatMessage[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call?.id && call.function?.name) {
        names.set(call.id, call.function.name);
      }
    }
  }
  return names;
}

/**
 * Build the upstream `functionResponse` part for a tool result message.
 * Returns null when the function name cannot be resolved, which the caller
 * reports as an invalid request rather than sending an unusable turn.
 */
export function buildFunctionResponsePart(
  message: ChatMessage,
  names: Map<string, string>,
): UpstreamFunctionResponsePart | null {
  const name =
    (message.tool_call_id ? names.get(message.tool_call_id) : undefined) ??
    message.name;
  if (!name) return null;
  return {
    functionResponse: {
      name,
      response: { output: message.content ?? "" },
    },
  };
}
