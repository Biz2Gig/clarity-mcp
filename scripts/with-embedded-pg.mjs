/**
 * Boot a throwaway embedded PostgreSQL, apply migrations, run a command with
 * DATABASE_URL / TEST_DATABASE_URL pointed at it, then tear everything down.
 *
 *   node scripts/with-embedded-pg.mjs migrate      # just apply migrations
 *   node scripts/with-embedded-pg.mjs test [args]  # migrate + vitest run
 *
 * Local integration verification only. Production uses a real database.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";

const require = createRequire(import.meta.url);
const PORT = Number(process.env.EMBEDDED_PG_PORT ?? 55432);
const USER = "clarity";
const PASSWORD = "clarity";
const DB = "clarity_mcp_test";

const mode = process.argv[2] ?? "test";
const extraArgs = process.argv.slice(3);

const prismaBin = path.join(
  path.dirname(require.resolve("prisma/package.json")),
  "build",
  "index.js",
);
const vitestBin = require.resolve("vitest/vitest.mjs");

function node(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", (e) => {
      console.error(e);
      resolve(1);
    });
  });
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "clarity-mcp-pg-"));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: false,
});

let code = 1;
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB);
  const url = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DB}?schema=public`;
  const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url };
  console.log(`[embedded-pg] ready on ${PORT}`);

  console.log("[embedded-pg] prisma migrate deploy");
  code = await node([prismaBin, "migrate", "deploy"], env);

  if (code === 0 && mode === "test") {
    console.log("[embedded-pg] vitest run");
    code = await node([vitestBin, "run", ...extraArgs], env);
  }
} finally {
  await pg.stop().catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  console.log("[embedded-pg] stopped");
}
process.exit(code);
