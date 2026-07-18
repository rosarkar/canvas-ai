/**
 * Standalone Canvas Markets server — the judge-friendly entry point.
 *
 * The main bot server hard-requires Postgres + Telegram credentials at config
 * load. The risk desk needs none of that (odds + math + Bankr only), so this
 * entry sets throwaway values for the vars the shared config demands but markets
 * never uses, then boots a tiny Express app serving the desk + /api/markets.
 *
 *   npm run markets   →   http://localhost:4000/markets/
 *
 * The only static import is the native-warning filter (it must run first and is
 * config-independent); the env defaults below must still run before the shared
 * config module is (dynamically) loaded.
 */
import "@/utils/quiet-native-warnings.js";

process.env.DATABASE_URL ??= "postgres://markets-demo:demo@localhost:5432/markets";
process.env.TELEGRAM_BOT_TOKEN ??= "markets-demo";
process.env.TELEGRAM_WEBHOOK_URL ??= "http://localhost:4000";
process.env.TELEGRAM_WEBHOOK_SECRET ??= "markets-demo";

const express = (await import("express")).default;
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { marketsRouter } = await import("./api/markets.js");
const { logger } = await import("./utils/logger.js");

const app = express();
app.use(express.json());

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
app.use("/markets", express.static(path.join(repoRoot, "public/markets")));
app.use(marketsRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "canvas-markets" });
});

// Convenience: root redirects to the desk.
app.get("/", (_req, res) => res.redirect("/markets/"));

const port = Number(process.env.MARKETS_PORT ?? "4000");
app
  .listen(port, () => {
    logger.info(`Canvas Markets risk desk → http://localhost:${port}/markets/`);
  })
  .on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        `Port ${port} is already in use. Set MARKETS_PORT to a free port, e.g. MARKETS_PORT=4001 npm run markets`,
      );
      process.exit(1);
    }
    throw err;
  });
