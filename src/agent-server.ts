/**
 * Standalone Canvas Edge server — the judge-friendly entry point.
 *   npm run agent   →   http://localhost:4300/agent/
 * Needs no Postgres/Telegram; sets throwaway values for the vars the shared
 * config demands but the agent never uses (loaded via dynamic import after).
 */
import "@/utils/quiet-native-warnings.js";

process.env.DATABASE_URL ??= "postgres://agent-demo:demo@localhost:5432/agent";
process.env.TELEGRAM_BOT_TOKEN ??= "agent-demo";
process.env.TELEGRAM_WEBHOOK_URL ??= "http://localhost:4300";
process.env.TELEGRAM_WEBHOOK_SECRET ??= "agent-demo";

const express = (await import("express")).default;
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { agentRouter } = await import("./api/agent.js");
const { logger } = await import("./utils/logger.js");

const app = express();
app.use(express.json());

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
app.use("/agent", express.static(path.join(repoRoot, "public/agent")));
app.use(agentRouter);

app.get("/health", (_req, res) => res.json({ ok: true, service: "canvas-edge" }));
app.get("/", (_req, res) => res.redirect("/agent/"));

const port = Number(process.env.AGENT_PORT ?? "4300");
app
  .listen(port, () => {
    logger.info(`Canvas Edge trading agent → http://localhost:${port}/agent/`);
  })
  .on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(`Port ${port} is already in use. Set AGENT_PORT to a free port, e.g. AGENT_PORT=4301 npm run agent`);
      process.exit(1);
    }
    throw err;
  });
