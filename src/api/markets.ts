/**
 * /api/markets — the risk desk's HTTP surface.
 *
 *   GET  /api/markets               → all World Cup matches with de-vigged odds + edges
 *   GET  /api/markets/match/:id     → one match
 *   POST /api/markets/risk          → Kelly stake + Sharpe + Monte-Carlo ruin for a selection
 *   POST /api/markets/hedge         → the lock-in hedge ("second trade") for a position
 *   POST /api/markets/intent        → parse a free-text bet request
 *   POST /api/markets/settle        → compose/execute the Bankr order(s)
 *
 * Read + compute routes are public (no wallet needed to explore). Settlement runs
 * simulated by default; a flag + Bankr key makes it live.
 */
import { Router, type Request, type Response } from "express";

import { type MatchOdds, type MarketOutcome } from "@/services/txodds.client.js";
import { resolveOddsFeed } from "@/services/odds-feed.js";
import { assessSelection, lockInHedge } from "@/services/risk/index.js";
import { parseBetIntent, explainAssessment } from "@/services/markets-agent.js";
import { settle, type SettlementLegInput } from "@/services/markets-settle.js";
import { config } from "@/config/index.js";
import { logger } from "@/utils/logger.js";

export const marketsRouter = Router();

const matchLabel = (m: MatchOdds): string => `${m.home} vs ${m.away}`;

/** Locate an outcome across all of a match's markets. */
function findOutcome(
  match: MatchOdds,
  outcomeKey: string,
): { outcome: MarketOutcome; marketKey: string } | undefined {
  for (const mk of match.markets) {
    const outcome = mk.outcomes.find((o) => o.key === outcomeKey);
    if (outcome) return { outcome, marketKey: mk.key };
  }
  return undefined;
}

marketsRouter.get("/api/markets", async (_req: Request, res: Response) => {
  try {
    const feed = (await resolveOddsFeed());
    const matches = await feed.getMatches();
    res.json({
      source: feed.source,
      settlementMode: config.markets.liveSettlement ? "live" : "simulated",
      simHorizon: config.markets.simHorizonBets,
      count: matches.length,
      matches,
    });
  } catch (err) {
    logger.error({ err }, "GET /api/markets failed");
    res.status(500).json({ error: "Failed to load markets" });
  }
});

marketsRouter.get("/api/markets/match/:id", async (req: Request, res: Response) => {
  try {
    const match = await (await resolveOddsFeed()).getMatch(String(req.params.id));
    if (!match) {
      res.status(404).json({ error: "Match not found" });
      return;
    }
    res.json(match);
  } catch (err) {
    logger.error({ err }, "GET /api/markets/match failed");
    res.status(500).json({ error: "Failed to load match" });
  }
});

marketsRouter.post("/api/markets/risk", async (req: Request, res: Response) => {
  try {
    const { matchId, outcome, bankroll, kellyFraction } = req.body as {
      matchId?: string;
      outcome?: string;
      bankroll?: number;
      kellyFraction?: number;
    };
    if (!matchId || !outcome || typeof bankroll !== "number" || !(bankroll > 0)) {
      res.status(400).json({ error: "matchId, outcome and a positive bankroll are required" });
      return;
    }
    const match = await (await resolveOddsFeed()).getMatch(matchId);
    if (!match) {
      res.status(404).json({ error: "Match not found" });
      return;
    }
    const found = findOutcome(match, outcome);
    if (!found) {
      res.status(404).json({ error: `Outcome ${outcome} not found on this match` });
      return;
    }

    // Allow > 1× (over-betting) so the desk can *show* ruin climbing past full Kelly.
    const kf = typeof kellyFraction === "number" && kellyFraction > 0 && kellyFraction <= 3
      ? kellyFraction
      : 0.5;

    const assessment = assessSelection({
      outcome,
      fairProb: found.outcome.fairProb,
      decimalOdds: found.outcome.decimalOdds,
      bankroll,
      kellyFraction: kf,
      horizonBets: config.markets.simHorizonBets,
    });

    res.json({
      matchId,
      matchLabel: matchLabel(match),
      selectionLabel: found.outcome.label,
      assessment,
      narration: explainAssessment(assessment, matchLabel(match), found.outcome.label),
    });
  } catch (err) {
    logger.error({ err }, "POST /api/markets/risk failed");
    res.status(500).json({ error: "Risk assessment failed" });
  }
});

marketsRouter.post("/api/markets/hedge", async (req: Request, res: Response) => {
  try {
    const { matchId, outcome, stake } = req.body as {
      matchId?: string;
      outcome?: string;
      stake?: number;
    };
    if (!matchId || !outcome || typeof stake !== "number" || !(stake > 0)) {
      res.status(400).json({ error: "matchId, outcome and a positive stake are required" });
      return;
    }
    const match = await (await resolveOddsFeed()).getMatch(matchId);
    if (!match) {
      res.status(404).json({ error: "Match not found" });
      return;
    }
    // Hedge across the mutually-exclusive market that contains the outcome.
    const market = match.markets.find((mk) => mk.outcomes.some((o) => o.key === outcome));
    const primary = market?.outcomes.find((o) => o.key === outcome);
    if (!market || !primary) {
      res.status(404).json({ error: `Outcome ${outcome} not found on this match` });
      return;
    }
    const hedgeLegs = market.outcomes
      .filter((o) => o.key !== outcome)
      .map((o) => ({ outcome: o.key, decimalOdds: o.decimalOdds }));

    const hedge = lockInHedge({
      primary: { outcome, decimalOdds: primary.decimalOdds, stake },
      hedgeLegs,
    });

    // Attach human labels for the UI.
    const labelFor = (key: string) => market.outcomes.find((o) => o.key === key)?.label ?? key;
    res.json({
      matchId,
      matchLabel: matchLabel(match),
      marketLabel: market.label,
      primaryLabel: primary.label,
      hedge: {
        ...hedge,
        legs: hedge.legs.map((l) => ({ ...l, label: labelFor(l.outcome) })),
        unhedgedPayoff: hedge.unhedgedPayoff.map((p) => ({ ...p, label: labelFor(p.outcome) })),
        hedgedPayoff: hedge.hedgedPayoff.map((p) => ({ ...p, label: labelFor(p.outcome) })),
      },
    });
  } catch (err) {
    logger.error({ err }, "POST /api/markets/hedge failed");
    res.status(500).json({ error: "Hedge computation failed" });
  }
});

marketsRouter.post("/api/markets/intent", async (req: Request, res: Response) => {
  try {
    const { text } = req.body as { text?: string };
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const matches = await (await resolveOddsFeed()).getMatches();
    const intent = await parseBetIntent(text, matches);
    res.json(intent);
  } catch (err) {
    logger.error({ err }, "POST /api/markets/intent failed");
    res.status(500).json({ error: "Intent parsing failed" });
  }
});

marketsRouter.post("/api/markets/settle", async (req: Request, res: Response) => {
  try {
    const { matchId, primary, hedgeLegs } = req.body as {
      matchId?: string;
      primary?: { outcome: string; stake: number };
      hedgeLegs?: { outcome: string; stake: number }[];
    };
    if (!matchId || !primary?.outcome || !(Number(primary.stake) > 0)) {
      res.status(400).json({ error: "matchId and a primary { outcome, stake>0 } are required" });
      return;
    }
    const match = await (await resolveOddsFeed()).getMatch(matchId);
    if (!match) {
      res.status(404).json({ error: "Match not found" });
      return;
    }

    const toLeg = (
      role: "primary" | "hedge",
      sel: { outcome: string; stake: number },
    ): SettlementLegInput | null => {
      const found = findOutcome(match, sel.outcome);
      if (!found || !(sel.stake > 0)) return null;
      return {
        role,
        selectionLabel: found.outcome.label,
        outcome: sel.outcome,
        matchLabel: matchLabel(match),
        competition: match.competition,
        decimalOdds: found.outcome.decimalOdds,
        stake: sel.stake,
      };
    };

    const legs: SettlementLegInput[] = [];
    const primaryLeg = toLeg("primary", primary);
    if (!primaryLeg) {
      res.status(400).json({ error: "Invalid primary selection" });
      return;
    }
    legs.push(primaryLeg);
    for (const h of hedgeLegs ?? []) {
      const leg = toLeg("hedge", h);
      if (leg) legs.push(leg);
    }

    const result = await settle(legs);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "POST /api/markets/settle failed");
    res.status(500).json({ error: "Settlement failed" });
  }
});
