import { randomUUID } from "node:crypto";

export function generateChatCompletionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "")}`;
}
