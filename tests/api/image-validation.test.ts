import { describe, expect, it } from "vitest";
import { validateAndNormalizeChatRequest } from "../../src/api/validation";

function image(data: string) {
  return validateAndNormalizeChatRequest(
    {
      model: "model",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${data}` },
            },
          ],
        },
      ],
    },
    "test",
  );
}

describe("inline image validation", () => {
  it("rejects malformed base64 rather than silently decoding it", () => {
    for (const data of [
      "!!!!!",
      "A",
      "AA=",
      "A===",
      "AA=A",
      "AAAA====",
      "AA AA",
      "AA\nAA",
    ]) {
      expect(() => image(data), data).toThrow();
    }
  });
  it("accepts padded/unpadded base64 and counts exact decoded bytes", () => {
    for (const data of ["YQ==", "YWI=", "YWJj", "YQ", "YWI"])
      expect(() => image(data)).not.toThrow();
    expect(() =>
      image(Buffer.alloc(8 * 1024 * 1024).toString("base64")),
    ).not.toThrow();
    expect(() =>
      image(Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64")),
    ).toThrow(/byte limit/);
  });
});
