import { afterEach, describe, expect, it } from "vitest";

import { ConfigurationError } from "../app/errors";
import { getSttProvider, getSynthesisProvider, getVisionProvider } from "../app/providers";
import { OpenAISpeechToText, OpenAISynthesis } from "../app/providers/openai";

const KEY = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = KEY;
});

describe("provider credential handling", () => {
  it("OpenAI STT raises a ConfigurationError when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      new OpenAISpeechToText().transcribe({ audioPath: "/tmp/none.wav" }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("OpenAI synthesis raises a ConfigurationError when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      new OpenAISynthesis().synthesize({
        durationMs: 1000,
        transcript: [],
        frames: [],
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("does not fabricate output - it fails loudly", async () => {
    delete process.env.OPENAI_API_KEY;
    let threw = false;
    try {
      await new OpenAISpeechToText().transcribe({ audioPath: "/tmp/none.wav" });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/OPENAI_API_KEY/);
    }
    expect(threw).toBe(true);
  });
});

describe("provider selection", () => {
  it("returns the mock providers under NODE_ENV=test", () => {
    expect(getSttProvider().name).toBe("mock");
    expect(getVisionProvider().name).toBe("mock");
    expect(getSynthesisProvider().name).toBe("mock");
  });

  it("rejects an unknown provider name", () => {
    const prev = process.env.STT_PROVIDER;
    process.env.STT_PROVIDER = "does-not-exist";
    try {
      expect(() => getSttProvider()).toThrow(ConfigurationError);
    } finally {
      process.env.STT_PROVIDER = prev;
    }
  });
});
