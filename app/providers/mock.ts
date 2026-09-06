/**
 * Deterministic in-memory providers for tests. Never used unless NODE_ENV=test
 * or PROVIDERS_ALLOW_MOCK=true. They derive their output from the inputs so
 * assertions are stable - they do not fabricate a plausible-looking analysis
 * for production use.
 */

import type {
  FrameAnalysisResponse,
  QueryInput,
  QueryResult,
  SpeechToTextProvider,
  SynthesisInput,
  SynthesisProvider,
  TranscriptionResult,
  VideoAnalysisResult,
  VisionProvider,
} from "./types";

export class MockSpeechToText implements SpeechToTextProvider {
  readonly name = "mock";
  async transcribe(input: {
    audioPath: string;
    language?: string;
  }): Promise<TranscriptionResult> {
    return {
      language: input.language ?? "en",
      provider: this.name,
      model: "mock-stt-1",
      segments: [
        { startMs: 0, endMs: 1500, text: "Mock transcript segment one.", confidence: 0.9 },
        { startMs: 1500, endMs: 3000, text: "Mock transcript segment two.", confidence: 0.8 },
      ],
    };
  }
}

export class MockVision implements VisionProvider {
  readonly name = "mock";
  async analyzeFrames(input: {
    frames: { timestampMs: number; imagePath: string }[];
    prompt?: string;
  }): Promise<FrameAnalysisResponse> {
    return {
      provider: this.name,
      model: "mock-vision-1",
      results: input.frames.map((f) => ({
        timestampMs: f.timestampMs,
        description: `Mock frame at ${f.timestampMs}ms`,
        ocrText: `TEXT@${f.timestampMs}`,
        objects: [{ label: "button", kind: "interface" as const }],
      })),
    };
  }
}

export class MockSynthesis implements SynthesisProvider {
  readonly name = "mock";
  async synthesize(input: SynthesisInput): Promise<VideoAnalysisResult> {
    const firstTs = input.frames[0]?.timestampMs ?? 0;
    return {
      executiveSummary: `Mock summary of ${input.title ?? "video"}.`,
      fullDescription: `Mock description covering ${input.transcript.length} segments and ${input.frames.length} frames.`,
      transcriptSummary: input.transcript.map((s) => s.text).join(" "),
      importantEvents: [{ timestampMs: firstTs, description: "Mock event" }],
      visibleText: input.frames
        .filter((f) => f.ocrText)
        .map((f) => ({ timestampMs: f.timestampMs, text: f.ocrText! })),
      detectedObjects: [{ label: "button", timestampsMs: input.frames.map((f) => f.timestampMs) }],
      problems: [],
      recommendations: ["Mock recommendation"],
      citations: [{ claim: "Mock claim", timestampsMs: [firstTs] }],
      provider: this.name,
      model: "mock-synth-1",
    };
  }

  async answerQuestion(input: QueryInput): Promise<QueryResult> {
    const hit = input.transcript.find((s) =>
      s.text.toLowerCase().includes(input.question.toLowerCase().slice(0, 4)),
    );
    if (!hit) {
      return {
        answer: "The available transcript and frames do not contain enough evidence to answer.",
        citations: [],
        insufficientEvidence: true,
        provider: this.name,
        model: "mock-synth-1",
      };
    }
    return {
      answer: `Based on the transcript: "${hit.text}"`,
      citations: [{ claim: hit.text, timestampsMs: [hit.startMs] }],
      insufficientEvidence: false,
      provider: this.name,
      model: "mock-synth-1",
    };
  }
}
