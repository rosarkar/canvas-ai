/**
 * Standalone Canvas Cup server — the judge-friendly fan-experience entry point.
 *   npm run fan   →   http://localhost:4400/fan/
 * Needs no Postgres/Telegram (in-memory prediction store).
 */
import "@/utils/quiet-native-warnings.js";

process.env.DATABASE_URL ??= "postgres://fan-demo:demo@localhost:5432/fan";
process.env.TELEGRAM_BOT_TOKEN ??= "fan-demo";
process.env.TELEGRAM_WEBHOOK_URL ??= "http://localhost:4400";
process.env.TELEGRAM_WEBHOOK_SECRET ??= "fan-demo";

const express = (await import("express")).default;
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { fanRouter } = await import("./api/fan.js");
const { logger } = await import("./utils/logger.js");

const app = express();
app.use(express.json());

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
app.use("/fan", express.static(path.join(repoRoot, "public/fan")));
app.use(fanRouter);

app.get("/health", (_req, res) => res.json({ ok: true, service: "canvas-cup" }));
app.get("/", (_req, res) => res.redirect("/fan/"));

const port = Number(process.env.FAN_PORT ?? "4400");
app
  .listen(port, () => {
    logger.info(`Canvas Cup fan experience → http://localhost:${port}/fan/`);
  })
  .on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(`Port ${port} is already in use. Set FAN_PORT to a free port, e.g. FAN_PORT=4401 npm run fan`);
      process.exit(1);
    }
    throw err;
  });
