import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

import { config } from "../config.server";
import { ConfigurationError, errorMessage } from "../errors";
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

// The `openai` package is an optional runtime dependency: only load it when an
// OpenAI-backed provider is actually constructed.
async function openaiClient() {
  if (!config.openaiApiKey) {
    throw new ConfigurationError(
      "OPENAI_API_KEY is not set. Configure an OpenAI key or select a " +
        "different provider (STT_PROVIDER / VISION_PROVIDER / SYNTHESIS_PROVIDER).",
    );
  }
  const mod = await import("openai");
  const OpenAI = mod.default;
  return new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
  });
}

function clampConfidence(avgLogprob: unknown): number | undefined {
  const n = Number(avgLogprob);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, Math.exp(n)));
}

function budget(text: string, max = 60_000): string {
  return text.length <= max ? text : text.slice(0, max) + "\n…[truncated]";
}

function transcriptToText(
  segments: SynthesisInput["transcript"],
): string {
  return budget(
    segments
      .map((s) => `[${Math.round(s.startMs)}-${Math.round(s.endMs)}ms] ${s.text}`)
      .join("\n"),
  );
}

function framesToText(frames: SynthesisInput["frames"]): string {
  return budget(
    frames
      .map(
        (f) =>
          `[${Math.round(f.timestampMs)}ms] ${f.description}` +
          (f.ocrText ? ` | text: ${f.ocrText}` : "") +
          (f.objects?.length
            ? ` | objects: ${f.objects.map((o) => o.label).join(", ")}`
            : ""),
      )
      .join("\n"),
  );
}

// --------------------------------------------------------------------------

export class OpenAISpeechToText implements SpeechToTextProvider {
  readonly name = "openai";

  async transcribe(input: {
    audioPath: string;
    language?: string;
  }): Promise<TranscriptionResult> {
    const client = await openaiClient();
    const model = config.sttModel;
    let res: any;
    try {
      res = await client.audio.transcriptions.create({
        file: createReadStream(input.audioPath) as any,
        model,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
        ...(input.language ? { language: input.language } : {}),
      });
    } catch (e) {
      throw new ConfigurationError(
        `OpenAI transcription failed: ${errorMessage(e)}`,
      );
    }

    const segments = (res.segments ?? []).map((s: any) => ({
      startMs: Math.round(Number(s.start) * 1000),
      endMs: Math.round(Number(s.end) * 1000),
      text: String(s.text ?? "").trim(),
      confidence: clampConfidence(s.avg_logprob),
    }));

    if (segments.length === 0 && res.text) {
      segments.push({ startMs: 0, endMs: 0, text: String(res.text).trim() });
    }

    return { language: res.language, segments, provider: this.name, model };
  }
}

// --------------------------------------------------------------------------

const FRAME_BATCH = 4;

export class OpenAIVision implements VisionProvider {
  readonly name = "openai";

  async analyzeFrames(input: {
    frames: { timestampMs: number; imagePath: string }[];
    prompt?: string;
  }): Promise<FrameAnalysisResponse> {
    const client = await openaiClient();
    const model = config.visionModel;
    const results: FrameAnalysisResponse["results"] = [];

    for (let i = 0; i < input.frames.length; i += FRAME_BATCH) {
      const batch = input.frames.slice(i, i + FRAME_BATCH);
      const content: any[] = [
        {
          type: "text",
          text:
            "Analyze each attached video keyframe. Respond as JSON " +
            '{"frames":[{"index":<int>,"description":<string>,"ocrText":<string>,' +
            '"objects":[{"label":<string>,"kind":"object|product|interface|person|text|other"}]}]}. ' +
            "index is the position in this batch starting at 0. Report visible UI text " +
            "verbatim in ocrText. Be concise and factual." +
            (input.prompt ? ` Focus: ${input.prompt}` : ""),
        },
      ];
      for (const f of batch) {
        const b64 = (await readFile(f.imagePath)).toString("base64");
        content.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "low" },
        });
      }

      let parsed: any;
      try {
        const res = await client.chat.completions.create({
          model,
          messages: [{ role: "user", content }],
          response_format: { type: "json_object" },
          temperature: 0,
        });
        parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
      } catch (e) {
        throw new ConfigurationError(
          `OpenAI vision analysis failed: ${errorMessage(e)}`,
        );
      }

      const frameArr: any[] = Array.isArray(parsed.frames) ? parsed.frames : [];
      batch.forEach((f, bi) => {
        const hit = frameArr.find((x) => Number(x.index) === bi) ?? frameArr[bi];
        results.push({
          timestampMs: f.timestampMs,
          description: String(hit?.description ?? "").trim() || "(no description)",
          ocrText: hit?.ocrText ? String(hit.ocrText).trim() : undefined,
          objects: Array.isArray(hit?.objects)
            ? hit.objects
                .filter((o: any) => o && o.label)
                .map((o: any) => ({ label: String(o.label), kind: o.kind }))
            : undefined,
        });
      });
    }

    return { results, provider: this.name, model };
  }
}

// --------------------------------------------------------------------------

const SYNTH_SYSTEM =
  "You are a video analyst. Ground every statement in the supplied transcript " +
  "and keyframe observations. Cite supporting timestamps in milliseconds. " +
  "If evidence is missing, say so rather than guessing.";

export class OpenAISynthesis implements SynthesisProvider {
  readonly name = "openai";

  async synthesize(input: SynthesisInput): Promise<VideoAnalysisResult> {
    const client = await openaiClient();
    const model = config.synthesisModel;

    const user =
      `Video title: ${input.title ?? "(untitled)"}\n` +
      `Duration: ${Math.round(input.durationMs)} ms\n` +
      (input.analysisPrompt ? `Caller focus: ${input.analysisPrompt}\n` : "") +
      `\n=== TRANSCRIPT (ms ranges) ===\n${transcriptToText(input.transcript) || "(no speech detected)"}\n` +
      `\n=== KEYFRAME OBSERVATIONS ===\n${framesToText(input.frames) || "(no frames)"}\n\n` +
      'Respond as JSON with keys: executiveSummary (string), fullDescription (string), ' +
      "transcriptSummary (string), importantEvents ([{timestampMs,description}]), " +
      "visibleText ([{timestampMs,text}]), detectedObjects ([{label,timestampsMs:[int]}]), " +
      "problems ([{description,timestampsMs:[int]}]), recommendations ([string]), " +
      "citations ([{claim,timestampsMs:[int]}]).";

    let parsed: any;
    try {
      const res = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYNTH_SYSTEM },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      });
      parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
    } catch (e) {
      throw new ConfigurationError(
        `OpenAI synthesis failed: ${errorMessage(e)}`,
      );
    }

    return normalizeAnalysis(parsed, this.name, model);
  }

  async answerQuestion(input: QueryInput): Promise<QueryResult> {
    const client = await openaiClient();
    const model = config.synthesisModel;

    const windowNote = input.window
      ? `Restrict evidence to ${input.window.startMs}-${input.window.endMs} ms.\n`
      : "";
    const user =
      `${windowNote}Question: ${input.question}\n\n` +
      `=== TRANSCRIPT ===\n${transcriptToText(input.transcript) || "(none)"}\n\n` +
      `=== KEYFRAMES ===\n${framesToText(input.frames) || "(none)"}\n\n` +
      "Answer ONLY from the evidence above. Respond as JSON " +
      '{"answer":<string>,"citations":[{"claim":<string>,"timestampsMs":[int]}],' +
      '"insufficientEvidence":<boolean>}. Set insufficientEvidence true and explain ' +
      "if the evidence cannot support an answer.";

    let parsed: any;
    try {
      const res = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYNTH_SYSTEM },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      });
      parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
    } catch (e) {
      throw new ConfigurationError(
        `OpenAI question answering failed: ${errorMessage(e)}`,
      );
    }

    return {
      answer: String(parsed.answer ?? "").trim(),
      citations: normalizeCitations(parsed.citations),
      insufficientEvidence: Boolean(parsed.insufficientEvidence),
      provider: this.name,
      model,
    };
  }
}

// --------------------------------------------------------------------------

export function normalizeCitations(v: unknown): { claim: string; timestampsMs: number[] }[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((c: any) => ({
      claim: String(c?.claim ?? "").trim(),
      timestampsMs: Array.isArray(c?.timestampsMs)
        ? c.timestampsMs.map((n: any) => Math.round(Number(n))).filter(Number.isFinite)
        : [],
    }))
    .filter((c) => c.claim.length > 0);
}

export function normalizeAnalysis(
  parsed: any,
  provider: string,
  model: string,
): VideoAnalysisResult {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const tsList = (v: unknown) =>
    arr(v).map((n: any) => Math.round(Number(n))).filter(Number.isFinite);
  return {
    executiveSummary: String(parsed.executiveSummary ?? "").trim(),
    fullDescription: String(parsed.fullDescription ?? "").trim(),
    transcriptSummary: String(parsed.transcriptSummary ?? "").trim(),
    importantEvents: arr(parsed.importantEvents).map((e: any) => ({
      timestampMs: Math.round(Number(e?.timestampMs) || 0),
      description: String(e?.description ?? "").trim(),
    })),
    visibleText: arr(parsed.visibleText).map((e: any) => ({
      timestampMs: Math.round(Number(e?.timestampMs) || 0),
      text: String(e?.text ?? "").trim(),
    })),
    detectedObjects: arr(parsed.detectedObjects).map((e: any) => ({
      label: String(e?.label ?? "").trim(),
      timestampsMs: tsList(e?.timestampsMs),
    })),
    problems: arr(parsed.problems).map((e: any) => ({
      description: String(e?.description ?? "").trim(),
      timestampsMs: tsList(e?.timestampsMs),
    })),
    recommendations: arr(parsed.recommendations).map((s: any) => String(s).trim()),
    citations: normalizeCitations(parsed.citations),
    provider,
    model,
  };
}
