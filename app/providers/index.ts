import { config } from "../config.server";
import { ConfigurationError } from "../errors";
import { MockSpeechToText, MockSynthesis, MockVision } from "./mock";
import { OpenAISpeechToText, OpenAISynthesis, OpenAIVision } from "./openai";
import type {
  SpeechToTextProvider,
  SynthesisProvider,
  VisionProvider,
} from "./types";

export type {
  SpeechToTextProvider,
  SynthesisProvider,
  VisionProvider,
} from "./types";

interface ProviderSet {
  stt?: SpeechToTextProvider;
  vision?: VisionProvider;
  synthesis?: SynthesisProvider;
}

let override: ProviderSet | undefined;

/** Test hook: inject providers directly, bypassing env selection. */
export function __setProviders(set: ProviderSet | undefined): void {
  override = set;
}

function mockAllowed(): boolean {
  return config.isTest || config.providersAllowMock;
}

function select<T>(
  name: string,
  makers: Record<string, () => T>,
  kind: string,
): T {
  const maker = makers[name];
  if (!maker) {
    throw new ConfigurationError(
      `Unknown ${kind} provider "${name}". Available: ${Object.keys(makers).join(", ")}.`,
    );
  }
  if (name === "mock" && !mockAllowed()) {
    throw new ConfigurationError(
      `The "mock" ${kind} provider is only available in test/dev ` +
        `(set PROVIDERS_ALLOW_MOCK=true to force it).`,
    );
  }
  return maker();
}

export function getSttProvider(): SpeechToTextProvider {
  if (override?.stt) return override.stt;
  return select<SpeechToTextProvider>(
    config.sttProvider,
    {
      openai: () => new OpenAISpeechToText(),
      mock: () => new MockSpeechToText(),
    },
    "speech-to-text",
  );
}

export function getVisionProvider(): VisionProvider {
  if (override?.vision) return override.vision;
  return select<VisionProvider>(
    config.visionProvider,
    {
      openai: () => new OpenAIVision(),
      mock: () => new MockVision(),
    },
    "vision",
  );
}

export function getSynthesisProvider(): SynthesisProvider {
  if (override?.synthesis) return override.synthesis;
  return select<SynthesisProvider>(
    config.synthesisProvider,
    {
      openai: () => new OpenAISynthesis(),
      mock: () => new MockSynthesis(),
    },
    "synthesis",
  );
}
