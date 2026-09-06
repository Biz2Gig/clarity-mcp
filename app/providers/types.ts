/**
 * Provider interfaces for the three external capabilities the video pipeline
 * needs. Implementations live alongside this file; the pipeline only ever
 * depends on these types. Missing credentials MUST raise ConfigurationError -
 * never return fabricated transcripts or analysis.
 */

export interface TranscriptSegmentResult {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  confidence?: number;
}

export interface TranscriptionResult {
  language?: string;
  segments: TranscriptSegmentResult[];
  provider: string;
  model: string;
}

export interface SpeechToTextProvider {
  readonly name: string;
  transcribe(input: {
    audioPath: string;
    language?: string;
  }): Promise<TranscriptionResult>;
}

export interface FrameAnalysisInput {
  timestampMs: number;
  imagePath: string;
}

export interface DetectedObject {
  label: string;
  kind?: "object" | "product" | "interface" | "person" | "text" | "other";
}

export interface FrameAnalysisResult {
  timestampMs: number;
  description: string;
  ocrText?: string;
  objects?: DetectedObject[];
}

export interface FrameAnalysisResponse {
  results: FrameAnalysisResult[];
  provider: string;
  model: string;
}

export interface VisionProvider {
  readonly name: string;
  analyzeFrames(input: {
    frames: FrameAnalysisInput[];
    prompt?: string;
  }): Promise<FrameAnalysisResponse>;
}

export interface TimestampCitation {
  claim: string;
  timestampsMs: number[];
}

export interface VideoAnalysisResult {
  executiveSummary: string;
  fullDescription: string;
  transcriptSummary: string;
  importantEvents: { timestampMs: number; description: string }[];
  visibleText: { timestampMs: number; text: string }[];
  detectedObjects: { label: string; timestampsMs: number[] }[];
  problems: { description: string; timestampsMs: number[] }[];
  recommendations: string[];
  citations: TimestampCitation[];
  provider: string;
  model: string;
}

export interface SynthesisInput {
  title?: string;
  analysisPrompt?: string;
  durationMs: number;
  transcript: TranscriptSegmentResult[];
  frames: FrameAnalysisResult[];
}

export interface QueryInput {
  question: string;
  window?: { startMs: number; endMs: number };
  transcript: TranscriptSegmentResult[];
  frames: FrameAnalysisResult[];
  analysis?: VideoAnalysisResult | null;
}

export interface QueryResult {
  answer: string;
  citations: TimestampCitation[];
  insufficientEvidence: boolean;
  provider: string;
  model: string;
}

export interface SynthesisProvider {
  readonly name: string;
  synthesize(input: SynthesisInput): Promise<VideoAnalysisResult>;
  answerQuestion(input: QueryInput): Promise<QueryResult>;
}
