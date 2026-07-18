/**
 * /api/agent — control + telemetry for Canvas Edge.
 *   GET  /api/agent/state   → live state (bankroll, P&L, decisions, positions, risk)
 *   POST /api/agent/start|stop|tick|reset
 *   POST /api/agent/goal    → inject a goal event (on-chain-verified trigger)
 *   POST /api/agent/risk    → update risk limits
 */
import { Router, type Request, type Response } from "express";
import {
  agentState,
  runAgentTurn,
  startAgentLoop,
  stopAgentLoop,
  resetAgent,
  injectGoal,
} from "@/services/agent/loop.js";
import { resolveOddsFeed } from "@/services/odds-feed.js";
import { logger } from "@/utils/logger.js";

export const agentRouter = Router();

agentRouter.get("/api/agent/matches", async (_req: Request, res: Response) => {
  try {
    const feed = await resolveOddsFeed();
    const matches = await feed.getMatches();
    res.json({
      source: feed.source,
      matches: matches.map((m) => ({
        id: m.id,
        home: m.home,
        away: m.away,
        outcomes: (m.markets.find((k) => k.key === "1X2") ?? m.markets[0])?.outcomes.map((o) => ({
          key: o.key,
          label: o.label,
        })) ?? [],
      })),
    });
  } catch (err) {
    logger.error({ err }, "GET /api/agent/matches failed");
    res.status(500).json({ error: "failed to load matches" });
  }
});

agentRouter.get("/api/agent/state", (_req: Request, res: Response) => {
  const s = agentState;
  res.json({
    running: s.running,
    mode: s.mode,
    source: s.source,
    startedAt: s.startedAt,
    lastTickTs: s.lastTickTs,
    startingBankroll: s.startingBankroll,
    bankroll: Math.round(s.bankroll * 100) / 100,
    realizedPnl: Math.round(s.realizedPnl * 100) / 100,
    openPositions: s.positions.filter((p) => p.status === "open").length,
    risk: s.risk,
    blockedReason: s.blockedReason,
    positions: s.positions,
    decisions: s.decisions,
  });
});

agentRouter.post("/api/agent/start", (req: Request, res: Response) => {
  const intervalMs = Number((req.body as { intervalMs?: number })?.intervalMs) || 12_000;
  startAgentLoop(intervalMs);
  res.json({ ok: true, running: true });
});

agentRouter.post("/api/agent/stop", (_req: Request, res: Response) => {
  stopAgentLoop();
  res.json({ ok: true, running: false });
});

agentRouter.post("/api/agent/tick", async (_req: Request, res: Response) => {
  try {
    const r = await runAgentTurn();
    res.json({ ok: true, ...r });
  } catch (err) {
    logger.error({ err }, "manual tick failed");
    res.status(500).json({ error: "tick failed" });
  }
});

agentRouter.post("/api/agent/reset", (req: Request, res: Response) => {
  resetAgent(Number((req.body as { bankroll?: number })?.bankroll) || 1000);
  res.json({ ok: true });
});

agentRouter.post("/api/agent/goal", async (req: Request, res: Response) => {
  const { matchId, outcome } = (req.body as { matchId?: string; outcome?: string }) ?? {};
  if (!matchId || !outcome) {
    res.status(400).json({ error: "matchId and outcome required" });
    return;
  }
  const decision = await injectGoal(matchId, outcome);
  res.json({ ok: Boolean(decision), decision });
});

agentRouter.post("/api/agent/risk", (req: Request, res: Response) => {
  const b = (req.body as Partial<typeof agentState.risk>) ?? {};
  const r = agentState.risk;
  for (const k of ["maxStakeUsd", "kellyFraction", "minEdge", "dailyLossCapUsd", "ruinStopFraction"] as const) {
    if (typeof b[k] === "number") r[k] = b[k] as number;
  }
  res.json({ ok: true, risk: r });
});
