/**
 * Markdown fence handling for JSON-mode responses.
 *
 * The upstream sometimes answers a JSON-mode request with a fenced payload
 * (```json ... ```) even though `responseMimeType` is set. The OpenAI
 * contract promises raw JSON, so clients can call `JSON.parse()` on the
 * message content — the fences have to be removed.
 */

const OPENING_FENCE = /^\s*```[a-zA-Z0-9_+.-]*[ \t]*\r?\n/;
const CLOSING_FENCE = /```\s*$/;
const MAX_PENDING = 4096;

/** Strip a leading/trailing Markdown code fence from a JSON payload. */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!OPENING_FENCE.test(trimmed)) return text;
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
  let suffix = "";
  let finished = false;

  function body(text: string): string {
    const combined = suffix + text;
    const candidate = combined.match(/`{1,3}\s*$/);
    suffix = candidate?.[0] ?? "";
    // An exceptional trailing whitespace run must not retain an unbounded response.
    if (suffix.length > MAX_PENDING) throw new Error("JSON fence suffix exceeds buffer limit");
    return combined.slice(0, combined.length - suffix.length);
  }

  return {
    push(text: string): string {
      if (finished) return "";
      if (decided) {
        return stripping ? body(text) : text;
      }

      pending += text;
      const trimmed = pending.trimStart();
      if (pending.length > MAX_PENDING && !OPENING_FENCE.test(pending)) {
        decided = true;
        const out = pending;
        pending = "";
        return out; // Pathological undecided prefixes are passed through unchanged.
      }
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
        if (/^```[a-zA-Z0-9_+.-]*[ \t]*\r?$/.test(trimmed)) {
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
      return body(out);
    },
    finish(): string {
      if (finished) return "";
      finished = true;
      if (!decided) {
        decided = true;
        const out = pending;
        pending = "";
        return out;
      }
      const out = stripping && CLOSING_FENCE.test(suffix) ? "" : suffix;
      suffix = "";
      return out;
    },
  };
}
