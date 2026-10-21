/**
 * Markdown fence handling for JSON-mode responses.
 *
 * The upstream sometimes answers a JSON-mode request with a fenced payload
 * (```json ... ```) even though `responseMimeType` is set. The OpenAI
 * contract promises raw JSON, so clients can call `JSON.parse()` on the
 * message content — the fences have to be removed.
 */

const OPENING_FENCE = /^\s*```[a-zA-Z0-9_+.-]*[ \t]*\r?\n?/;
const CLOSING_FENCE = /```\s*$/;

/** Strip a leading/trailing Markdown code fence from a JSON payload. */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return text;
  const withoutOpening = trimmed.replace(OPENING_FENCE, "");
  return withoutOpening.replace(CLOSING_FENCE, "").trim();
}

export interface JsonFenceFilter {
  /** Feed a text delta; returns the text that should be sent to the client. */
  push(text: string): string;
  /** Flush anything still buffered at the end of the stream. */
  finish(): string;
}

/**
 * Streaming counterpart of `stripJsonFence`.
 *
 * The filter buffers the first deltas until it can tell whether the payload
 * is fenced. A fence is recognized only once its opening marker is complete
 * (three backticks, an optional language tag and a newline), so a marker or
 * a language tag split across deltas is still handled correctly. Once a fence
 * is detected the markers are dropped from the stream; an unfenced payload is
 * passed through untouched.
 */
export function createJsonFenceFilter(): JsonFenceFilter {
  let pending = "";
  let decided = false;
  let stripping = false;

  return {
    push(text: string): string {
      if (decided) {
        return stripping ? text.replace(/```/g, "") : text;
      }

      pending += text;
      const trimmed = pending.trimStart();
      if (trimmed.length === 0) return "";

      if (trimmed[0] !== "`") {
        // Cannot be a fence: emit everything buffered so far.
        decided = true;
        const out = pending;
        pending = "";
        return out;
      }

      if (trimmed.length < 3) {
        // Might still become "```" once the next delta arrives.
        return "";
      }

      if (trimmed.slice(0, 3) !== "```") {
        // Starts with a backtick but is not a fence.
        decided = true;
        const out = pending;
        pending = "";
        return out;
      }

      // A fence: wait until the opening marker is complete (language tag and
      // newline) before deciding how to strip it.
      if (!/^```[a-zA-Z0-9_+.-]*[ \t]*\r?\n/.test(trimmed)) {
        if (/^```[a-zA-Z0-9_+.-]*[ \t]*$/.test(trimmed)) {
          return ""; // the language tag may still be arriving
        }
        decided = true;
        const out = pending;
        pending = "";
        return out;
      }

      decided = true;
      stripping = true;
      const out = pending.replace(OPENING_FENCE, "");
      pending = "";
      return out.replace(/```/g, "");
    },
    finish(): string {
      if (!decided) {
        decided = true;
        const out = pending;
        pending = "";
        return out;
      }
      return "";
    },
  };
}
