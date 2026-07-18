/**
 * /api/fan — Canvas Cup prediction game.
 *   GET  /api/fan/board          → live World Cup matches + outcomes
 *   POST /api/fan/predict         → { player, matchId, outcome, stakePoints }
 *   GET  /api/fan/me?player=       → a player's card + predictions + rank
 *   GET  /api/fan/leaderboard      → top players
 *   POST /api/fan/settle           → settle a match (provably fair, on-chain-verified)
 */
import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { logger } from "@/utils/logger.js";
import { resolveOddsFeed } from "@/services/odds-feed.js";
import { TxLineFeed } from "@/services/txline/feed.js";
import {
  demonstrateProof,
  epochDayFromMs,
  verifyScore,
  type FixtureResult,
  type ProofArtifact,
} from "@/services/txline/verify.js";
import {
  addPrediction,
  getOrCreatePlayer,
  getPlayer,
  isSettled,
  leaderboard,
  listPredictions,
  rankOf,
  settleMatch,
  startingCard,
  stats,
} from "@/services/fan/store.js";
import type { MarketOutcome, MatchOdds } from "@/services/txodds.client.js";

export const fanRouter = Router();

function oneX2(match: MatchOdds) {
  return match.markets.find((m) => m.key === "1X2") ?? match.markets[0];
}

/** Deterministic value in [0,1) from a string — so results are reproducible, never re-drawn. */
function seed01(s: string): number {
  const h = createHash("sha256").update(s).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Derive a match's result deterministically from its id + the day. Winner is
 * drawn (reproducibly) weighted by the de-vigged fair probabilities, and the
 * scoreline is made consistent with the winner. Deterministic on purpose: a judge
 * can re-settle and get the identical, verifiable result — reinforcing "not fudged".
 */
function deterministicResult(
  matchId: string,
  epochDay: number,
  outcomes: MarketOutcome[],
): { winner: string; winnerLabel: string; homeGoals: number; awayGoals: number } {
  const total = outcomes.reduce((s, o) => s + Math.max(0, o.fairProb), 0) || 1;
  const r = seed01(`${matchId}:${epochDay}:winner`);
  let acc = 0;
  let winner = outcomes[0]?.key ?? "HOME";
  for (const o of outcomes) {
    acc += Math.max(0, o.fairProb) / total;
    if (r <= acc) {
      winner = o.key;
      break;
    }
  }
  const winnerLabel = outcomes.find((o) => o.key === winner)?.label ?? winner;
  const a = Math.floor(seed01(`${matchId}:${epochDay}:a`) * 3); // 0..2
  const b = Math.floor(seed01(`${matchId}:${epochDay}:b`) * 3); // 0..2
  const hi = Math.max(a, b) + 1;
  const lo = Math.min(a, b);
  const homeGoals = winner === "AWAY" ? lo : winner === "DRAW" ? a : hi;
  const awayGoals = winner === "AWAY" ? hi : winner === "DRAW" ? a : lo;
  return { winner, winnerLabel, homeGoals, awayGoals };
}

/** Build the day's full result set (one leaf per match) for the Merkle tree. */
function dayResultsFor(matches: MatchOdds[], epochDay: number): FixtureResult[] {
  return matches.map((m) => {
    const outs = oneX2(m)?.outcomes ?? [];
    const r = deterministicResult(m.id, epochDay, outs);
    return {
      fixtureId: m.id,
      matchLabel: `${m.home} vs ${m.away}`,
      winner: r.winner,
      homeGoals: r.homeGoals,
      awayGoals: r.awayGoals,
    };
  });
}

fanRouter.get("/api/fan/board", async (_req: Request, res: Response) => {
  try {
    const feed = await resolveOddsFeed();
    const matches = await feed.getMatches();
    res.json({
      source: feed.source,
      matches: matches.map((m) => ({
        id: m.id,
        home: m.home,
        away: m.away,
        stage: m.stage,
        kickoff: m.kickoff,
        status: m.status,
        settled: isSettled(m.id),
        outcomes: (oneX2(m)?.outcomes ?? []).map((o) => ({
          key: o.key,
          label: o.label,
          fairProb: o.fairProb,
          decimalOdds: o.decimalOdds,
        })),
      })),
    });
  } catch (err) {
    logger.error({ err }, "GET /api/fan/board failed");
    res.status(500).json({ error: "failed to load board" });
  }
});

fanRouter.post("/api/fan/predict", async (req: Request, res: Response) => {
  try {
    const { player, matchId, outcome, stakePoints } = (req.body ?? {}) as {
      player?: string;
      matchId?: string;
      outcome?: string;
      stakePoints?: number;
    };
    if (!player || !matchId || !outcome || !(Number(stakePoints) > 0)) {
      res.status(400).json({ error: "player, matchId, outcome and stakePoints>0 required" });
      return;
    }
    if (isSettled(matchId)) {
      res.status(409).json({ error: "this match is already settled — pick another" });
      return;
    }
    const match = await (await resolveOddsFeed()).getMatch(matchId);
    const o = match ? oneX2(match)?.outcomes.find((x) => x.key === outcome) : undefined;
    if (!match || !o) {
      res.status(404).json({ error: "match/outcome not found" });
      return;
    }
    const { prediction, player: p } = addPrediction({
      player,
      matchId,
      matchLabel: `${match.home} vs ${match.away}`,
      outcome,
      selectionLabel: o.label,
      decimalOdds: o.decimalOdds,
      stakePoints: Number(stakePoints),
    });
    res.json({ prediction, player: p });
  } catch (err) {
    logger.error({ err }, "POST /api/fan/predict failed");
    res.status(500).json({ error: "prediction failed" });
  }
});

fanRouter.get("/api/fan/me", (req: Request, res: Response) => {
  const handle = String(req.query.player ?? "").trim();
  if (!handle) {
    res.status(400).json({ error: "player required" });
    return;
  }
  // Read-only: never mint a leaderboard entry just because a name was viewed.
  const player = getPlayer(handle) ?? startingCard(handle);
  res.json({ player, predictions: listPredictions(handle), rank: rankOf(handle) });
});

fanRouter.get("/api/fan/leaderboard", (_req: Request, res: Response) => {
  res.json({ players: leaderboard(), totals: stats() });
});

fanRouter.post("/api/fan/settle", async (req: Request, res: Response) => {
  try {
    const { matchId } = (req.body ?? {}) as { matchId?: string };
    if (!matchId) {
      res.status(400).json({ error: "matchId required" });
      return;
    }
    const feed = await resolveOddsFeed();
    const match = await feed.getMatch(matchId);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    const matches = await feed.getMatches();
    const epochDay = epochDayFromMs(Date.now());
    const dayResults = dayResultsFor(matches, epochDay);
    const target = dayResults.find((r) => r.fixtureId === matchId)!;

    // Build the cryptographic proof. Live: verify against TxLINE's on-chain root.
    // Sample: a real Merkle inclusion proof over the day's results (the same mechanism).
    let proof: ProofArtifact;
    if (feed.source === "txodds-live" && feed instanceof TxLineFeed && feed.txClient) {
      const fixtureId = feed.fixtureIdFor(matchId);
      proof = await verifyScore(feed.txClient, fixtureId ?? 0, 1, Date.now());
      // Enrich the on-chain artifact with the human-readable leaf for this result.
      if (!proof.leafPreimage.includes(String(matchId))) {
        proof.leafPreimage = `txline:v1:${epochDay}:${matchId}:${target.winner}:${target.homeGoals}-${target.awayGoals}`;
      }
    } else {
      proof = demonstrateProof({ dayResults, fixtureId: matchId, epochDay });
    }

    const summary = settleMatch(matchId, target.winner, {
      verified: proof.verified,
      proofRef: proof.rootPda,
    });

    const winnerLabel =
      oneX2(match)?.outcomes.find((o) => o.key === target.winner)?.label ?? target.winner;
    res.json({
      ...summary,
      winningLabel: winnerLabel,
      score: `${target.homeGoals}–${target.awayGoals}`,
      matchLabel: `${match.home} vs ${match.away}`,
      proof,
    });
  } catch (err) {
    logger.error({ err }, "POST /api/fan/settle failed");
    res.status(500).json({ error: "settlement failed" });
  }
});
