/**
 * Loop — the autonomous turn engine + in-memory state.
 *
 * Each turn: pull odds → value-edge decisions (top-K paced) → execute → settle
 * open positions. Goals can be injected (from the live TxLINE scores stream, or
 * a demo trigger) to exercise the on-chain-verified goal-trigger strategy.
 */
import { resolveOddsFeed } from "@/services/odds-feed.js";
import { logger } from "@/utils/logger.js";
import { evaluateMatches, goalTriggerDecision } from "./strategy.js";
import { executeDecision, currentMode } from "./executor.js";
import { TxLineFeed } from "@/services/txline/feed.js";
import { demonstrateProof, epochDayFromMs, verifyScore, type FixtureResult } from "@/services/txline/verify.js";
import type { MatchOdds } from "@/services/txodds.client.js";
import { DEFAULT_RISK, type AgentDecision, type AgentState } from "./types.js";

/** Max fresh bets executed per turn (pacing). */
const BETS_PER_TURN = 2;

export const agentState: AgentState = {
  running: false,
  startedAt: null,
  lastTickTs: null,
  mode: currentMode(),
  source: "—",
  startingBankroll: 1000,
  bankroll: 1000,
  realizedPnl: 0,
  risk: { ...DEFAULT_RISK },
  blockedReason: null,
  decisions: [],
  positions: [],
};

function record(d: AgentDecision): void {
  agentState.decisions.unshift(d);
  if (agentState.decisions.length > 60) agentState.decisions.length = 60;
}

/** Simulated settlement — resolve each open SIMULATED position (this tick, ~50%). */
function settleOpenPositions(): void {
  for (const p of agentState.positions) {
    if (p.status !== "open") continue;
    // Never draw P&L for a live order from a PRNG — those resolve from the real
    // Bankr job / Polymarket market, not here. Only simulated positions settle.
    if (p.mode === "live") continue;
    if (Math.random() > 0.5) continue; // let positions linger a couple of turns
    // Settle against the TRUE probability (settleProb), so goal-trigger positions —
    // sized on an inflated in-play prob — are not fictitiously more profitable.
    const won = Math.random() < p.settleProb;
    if (won) {
      agentState.bankroll += p.stake * p.decimalOdds;
      p.pnl = p.stake * (p.decimalOdds - 1);
      p.status = "won";
      agentState.realizedPnl += p.pnl;
    } else {
      p.pnl = -p.stake;
      p.status = "lost";
      agentState.realizedPnl -= p.stake;
    }
  }
}

// Guards against a reset() or a second timer tick interleaving with a turn.
let turnInFlight = false;

export async function runAgentTurn(): Promise<{ evaluated: number; bet: number }> {
  if (turnInFlight) return { evaluated: 0, bet: 0 };
  turnInFlight = true;
  try {
    const feed = await resolveOddsFeed();
    const matches = await feed.getMatches();
    agentState.source = feed.source;
    agentState.mode = currentMode();

    const decisions = evaluateMatches(matches, agentState);
    agentState.blockedReason = decisions.find((d) => d.action === "blocked")?.reason ?? null;

    let bet = 0;
    for (const d of decisions) {
      record(d);
      if (d.action === "bet" && bet < BETS_PER_TURN) {
        const pos = await executeDecision(d, agentState);
        if (pos) {
          agentState.positions.unshift(pos);
          if (agentState.positions.length > 40) agentState.positions.length = 40;
          bet++;
        }
      }
    }

    settleOpenPositions();
    agentState.lastTickTs = Date.now();
    return { evaluated: decisions.length, bet };
  } finally {
    turnInFlight = false;
  }
}

/** Deterministic day-result set for the goal-event Merkle demonstration (sample path). */
function dayResultsForAgent(
  matches: MatchOdds[],
  targetId: string,
  targetOutcome: string,
): FixtureResult[] {
  return matches.map((m) => {
    const outs = (m.markets.find((k) => k.key === "1X2") ?? m.markets[0])?.outcomes ?? [];
    const winner =
      m.id === targetId
        ? targetOutcome
        : outs.reduce((b, o) => (o.fairProb > (b?.fairProb ?? -1) ? o : b), outs[0])?.key ?? "HOME";
    return {
      fixtureId: m.id,
      matchLabel: `${m.home} vs ${m.away}`,
      winner,
      homeGoals: winner === "HOME" ? 1 : 0,
      awayGoals: winner === "AWAY" ? 1 : 0,
    };
  });
}

/**
 * Inject a goal event (from the live TxLINE scores stream or a demo trigger).
 * Produces a REAL proof artifact: on the live feed it verifies the score record
 * against TxLINE's on-chain root; on sample data it demonstrates the same Merkle
 * inclusion proof (clearly labelled) — never a hardcoded "verified:true".
 */
export async function injectGoal(
  matchId: string,
  outcome: string,
): Promise<AgentDecision | null> {
  const feed = await resolveOddsFeed();
  const match = await feed.getMatch(matchId);
  if (!match) return null;

  const epochDay = epochDayFromMs(Date.now());
  let proof;
  if (feed.source === "txodds-live" && feed instanceof TxLineFeed && feed.txClient) {
    const fixtureId = feed.fixtureIdFor(matchId);
    proof = await verifyScore(feed.txClient, fixtureId ?? 0, 1, Date.now());
  } else {
    const matches = await feed.getMatches();
    proof = demonstrateProof({
      dayResults: dayResultsForAgent(matches, matchId, outcome),
      fixtureId: matchId,
      epochDay,
    });
  }

  const d = goalTriggerDecision(match, outcome, agentState, proof);
  if (!d) return null;
  record(d);
  if (d.action === "bet") {
    const pos = await executeDecision(d, agentState);
    if (pos) agentState.positions.unshift(pos);
  }
  return d;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAgentLoop(intervalMs = 15_000): void {
  if (timer) return;
  agentState.running = true;
  agentState.startedAt = Date.now();
  logger.info({ intervalMs }, "Canvas Edge agent loop started");
  void runAgentTurn().catch((err) => logger.error({ err }, "agent turn failed"));
  timer = setInterval(() => {
    void runAgentTurn().catch((err) => logger.error({ err }, "agent turn failed"));
  }, intervalMs);
}

export function stopAgentLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  agentState.running = false;
}

export function resetAgent(bankroll = 1000): void {
  stopAgentLoop();
  agentState.startingBankroll = bankroll;
  agentState.bankroll = bankroll;
  agentState.realizedPnl = 0;
  agentState.decisions = [];
  agentState.positions = [];
  agentState.blockedReason = null;
  agentState.startedAt = null;
  agentState.lastTickTs = null;
}
