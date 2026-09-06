/**
 * Durable job worker. Run one or more of these alongside the web server:
 *
 *     npm run worker
 *
 * Multiple workers are safe: `claimNextJob` uses SELECT ... FOR UPDATE SKIP
 * LOCKED so a job is only ever processed by one worker at a time. A crashed
 * worker's job is reclaimed after WORKER_STALE_LOCK_MS.
 */

import { config } from "./config.server";
import prisma from "./db.server";
import { errorMessage } from "./errors";
import { claimNextJob, failJob } from "./video/jobs.server";
import { processJob } from "./video/pipeline.server";

const workerId = config.workerId;
let running = true;
let active = false;

function log(msg: string, extra?: Record<string, unknown>) {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), worker: workerId, msg, ...extra }),
  );
}

async function tick(): Promise<boolean> {
  const job = await claimNextJob(workerId);
  if (!job) return false;

  active = true;
  log("job.claimed", { jobId: job.id, videoId: job.videoId, attempt: job.attempts });
  const startedAt = Date.now();

  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`job exceeded WORKER_JOB_TIMEOUT_MS (${config.workerJobTimeoutMs}ms)`)),
        config.workerJobTimeoutMs,
      ),
    );
    await Promise.race([processJob(job), timeout]);
    log("job.completed", { jobId: job.id, ms: Date.now() - startedAt });
  } catch (err) {
    const message = errorMessage(err);
    const { willRetry } = await failJob(job.id, job.videoId, message);
    log("job.failed", { jobId: job.id, willRetry, error: message.slice(0, 500) });
  } finally {
    active = false;
  }
  return true;
}

async function loop() {
  log("worker.start", {
    pollIntervalMs: config.workerPollIntervalMs,
    jobTimeoutMs: config.workerJobTimeoutMs,
  });
  while (running) {
    let didWork = false;
    try {
      didWork = await tick();
    } catch (err) {
      log("worker.tick_error", { error: errorMessage(err) });
    }
    if (!didWork && running) {
      await new Promise((r) => setTimeout(r, config.workerPollIntervalMs));
    }
  }
  log("worker.stopped");
}

async function shutdown(signal: string) {
  log("worker.shutdown", { signal, active });
  running = false;
  // Give an in-flight job a short grace period before forcing exit.
  const deadline = Date.now() + 10_000;
  while (active && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

loop().catch(async (err) => {
  log("worker.fatal", { error: errorMessage(err) });
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
