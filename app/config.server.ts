/**
 * Central environment configuration. Every `process.env` read in the server
 * lives here so the surface is auditable and documented in one place.
 * Values are read lazily so tests can mutate `process.env` before import use.
 */

function str(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function list(name: string): string[] {
  return str(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  get nodeEnv() {
    return str("NODE_ENV", "development");
  },
  get isProduction() {
    return this.nodeEnv === "production";
  },
  get isTest() {
    return this.nodeEnv === "test" || bool("VITEST");
  },

  // --- MCP transport / auth ---
  get mcpBridgeSecret() {
    return str("MCP_BRIDGE_SECRET");
  },
  /** Allowed browser Origin header values. Empty = allow all (non-browser). */
  get mcpAllowedOrigins() {
    return list("MCP_ALLOWED_ORIGINS");
  },
  /** Allowed Host header values (DNS-rebinding protection). Empty = allow all. */
  get mcpAllowedHosts() {
    return list("MCP_ALLOWED_HOSTS");
  },
  /** When true, do not normalize a lenient Accept header for legacy clients. */
  get mcpStrictAccept() {
    return bool("MCP_STRICT_ACCEPT", false);
  },
  get mcpMaxBodyBytes() {
    return num("MCP_MAX_BODY_BYTES", 5 * 1024 * 1024);
  },

  // --- Clarity aggregate API ---
  get clarityApiToken() {
    return str("CLARITY_API_TOKEN");
  },
  get clarityCacheTtlMs() {
    return num("CLARITY_CACHE_TTL_MS", 6 * 60 * 60 * 1000);
  },
  /**
   * Refresh policy for a STALE cache entry when daily quota remains:
   *   - "revalidate" (default): synchronously refresh, return fresh data.
   *   - "stale":  return stale data now; never auto-refresh (forceRefresh only).
   */
  get clarityRefreshPolicy(): "revalidate" | "stale" {
    return str("CLARITY_REFRESH_POLICY", "revalidate") === "stale"
      ? "stale"
      : "revalidate";
  },

  // --- Clarity recording CSV import ---
  get clarityCsvMaxBytes() {
    return num("CLARITY_CSV_MAX_BYTES", 25 * 1024 * 1024);
  },
  get clarityCsvMaxRows() {
    return num("CLARITY_CSV_MAX_ROWS", 200_000);
  },

  // --- Storage ---
  get storageDriver() {
    return str("STORAGE_DRIVER", "filesystem");
  },
  get storageDir() {
    return str("STORAGE_DIR", "./storage");
  },

  // --- Video ingest limits ---
  get videoMaxBytes() {
    return num("VIDEO_MAX_BYTES", 500 * 1024 * 1024);
  },
  get videoMaxDurationSec() {
    return num("VIDEO_MAX_DURATION_SEC", 3 * 60 * 60);
  },
  get videoKeyframeIntervalSec() {
    return num("VIDEO_KEYFRAME_INTERVAL_SEC", 15);
  },
  get videoMaxKeyframes() {
    return num("VIDEO_MAX_KEYFRAMES", 120);
  },
  get videoSceneThreshold() {
    return num("VIDEO_SCENE_THRESHOLD", 0.4);
  },
  get downloadConnectTimeoutMs() {
    return num("DOWNLOAD_CONNECT_TIMEOUT_MS", 15_000);
  },
  get downloadTotalTimeoutMs() {
    return num("DOWNLOAD_TOTAL_TIMEOUT_MS", 10 * 60_000);
  },
  get downloadMaxRedirects() {
    return num("DOWNLOAD_MAX_REDIRECTS", 3);
  },
  /** Allow plain-HTTP + private/loopback download targets (dev only). */
  get allowInsecureUrls() {
    return bool("ALLOW_INSECURE_URLS", !this.isProduction);
  },

  // --- FFmpeg ---
  get ffmpegPath() {
    return str("FFMPEG_PATH", "ffmpeg");
  },
  get ffprobePath() {
    return str("FFPROBE_PATH", "ffprobe");
  },

  // --- Worker ---
  get workerId() {
    return str("WORKER_ID", `worker-${process.pid}`);
  },
  get workerPollIntervalMs() {
    return num("WORKER_POLL_INTERVAL_MS", 3_000);
  },
  get workerJobTimeoutMs() {
    return num("WORKER_JOB_TIMEOUT_MS", 30 * 60_000);
  },
  get workerStaleLockMs() {
    return num("WORKER_STALE_LOCK_MS", 15 * 60_000);
  },

  // --- Providers ---
  get openaiApiKey() {
    return str("OPENAI_API_KEY");
  },
  get openaiBaseUrl() {
    return str("OPENAI_BASE_URL") || undefined;
  },
  get sttProvider() {
    return str("STT_PROVIDER", "openai");
  },
  get visionProvider() {
    return str("VISION_PROVIDER", "openai");
  },
  get synthesisProvider() {
    return str("SYNTHESIS_PROVIDER", "openai");
  },
  get sttModel() {
    return str("STT_MODEL", "whisper-1");
  },
  get visionModel() {
    return str("VISION_MODEL", "gpt-4o-mini");
  },
  get synthesisModel() {
    return str("SYNTHESIS_MODEL", "gpt-4o-mini");
  },
  /** Only honored in test/dev; enables the deterministic mock providers. */
  get providersAllowMock() {
    return bool("PROVIDERS_ALLOW_MOCK", false);
  },
};

export type AppConfig = typeof config;
