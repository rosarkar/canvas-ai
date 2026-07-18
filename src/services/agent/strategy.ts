/**
 * Strategy — turn odds (and live goals) into risk-gated trading decisions.
 * Reuses the Markets risk engine (`assessSelection`) for Kelly sizing + ruin,
 * and enforces the agent's risk limits before anything can trade.
 */
import { assessSelection } from "@/services/risk/index.js";
import type { MatchOdds } from "@/services/txodds.client.js";
import type { ProofArtifact } from "@/services/txline/verify.js";
import type { AgentDecision, AgentState } from "./types.js";

/**
 * A verified goal for the scoring side closes a fixed fraction of the remaining
 * gap to certainty: p' = p + SHIFT·(1 − p). This is a documented in-play model —
 * the shift scales with room-to-move (a 0.40 side jumps more in absolute terms
 * than a 0.90 favourite), rather than a flat constant bump.
 */
const GOAL_PROB_SHIFT = 0.25;

let counter = 0;
const nextId = (p: string): string => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Returns a reason string if trading should be halted, else null. */
export function riskBlock(state: AgentState): string | null {
  if (state.realizedPnl <= -state.risk.dailyLossCapUsd) {
    return `daily loss cap hit (${state.realizedPnl.toFixed(2)} USDC)`;
  }
  if (state.bankroll <= state.risk.ruinStopFraction * state.startingBankroll) {
    return `ruin stop — bankroll ${state.bankroll.toFixed(2)} ≤ ${(state.risk.ruinStopFraction * 100).toFixed(0)}% of start`;
  }
  return null;
}

/** Value-edge strategy: bet outcomes whose fair prob beats the market price. */
export function evaluateMatches(matches: MatchOdds[], state: AgentState): AgentDecision[] {
  const blocked = riskBlock(state);
  const held = new Set(
    state.positions.filter((p) => p.status === "open").map((p) => `${p.matchId}:${p.outcome}`),
  );
  const decisions: AgentDecision[] = [];

  for (const m of matches) {
    for (const mk of m.markets) {
      for (const o of mk.outcomes) {
        if (o.edge <= state.risk.minEdge) continue;
        if (held.has(`${m.id}:${o.key}`)) continue;
        const a = assessSelection({
          outcome: o.key,
          fairProb: o.fairProb,
          decimalOdds: o.decimalOdds,
          bankroll: state.bankroll,
          kellyFraction: state.risk.kellyFraction,
          horizonBets: 20,
          paths: 4000,
        });
        const stake = Math.min(a.stake.stake, state.risk.maxStakeUsd);
        decisions.push({
          id: nextId("val"),
          ts: Date.now(),
          strategy: "value-edge",
          matchId: m.id,
          matchLabel: `${m.home} vs ${m.away}`,
          outcome: o.key,
          selectionLabel: o.label,
          fairProb: o.fairProb,
          decimalOdds: o.decimalOdds,
          edge: o.edge,
          kellyStake: stake,
          ruinProb: a.simulation.ruinProbability,
          sharpe: a.metrics.sharpe,
          settleProb: o.fairProb,
          action: blocked ? "blocked" : a.stake.bet && stake > 0 ? "bet" : "skip",
          reason: blocked
            ? blocked
            : a.stake.bet
              ? `+${(o.edge * 100).toFixed(1)}% edge · ½-Kelly $${stake.toFixed(2)} · ruin ${(a.simulation.ruinProbability * 100).toFixed(1)}%`
              : "no positive-EV stake",
        });
      }
    }
  }
  return decisions.sort((x, y) => y.edge - x.edge);
}

/**
 * Goal-trigger strategy: the instant a goal is verified on-chain, act on the
 * scoring side before the market fully reprices (the sponsor's headline play).
 */
export function goalTriggerDecision(
  match: MatchOdds,
  scoringOutcome: string,
  state: AgentState,
  proof?: ProofArtifact,
): AgentDecision | null {
  const mk = match.markets.find((m) => m.key === "1X2") ?? match.markets[0];
  const o = mk?.outcomes.find((x) => x.key === scoringOutcome);
  if (!o) return null;
  const blocked = riskBlock(state);
  const held = new Set(
    state.positions.filter((p) => p.status === "open").map((p) => `${p.matchId}:${p.outcome}`),
  );
  const isHeld = held.has(`${match.id}:${o.key}`);
  // A verified goal shifts true probability up; trade the transient dislocation.
  const bumped = Math.min(0.97, o.fairProb + GOAL_PROB_SHIFT * (1 - o.fairProb));
  const a = assessSelection({
    outcome: o.key,
    fairProb: bumped,
    decimalOdds: o.decimalOdds,
    bankroll: state.bankroll,
    kellyFraction: state.risk.kellyFraction,
    horizonBets: 20,
    paths: 3000,
  });
  const stake = Math.min(a.stake.stake, state.risk.maxStakeUsd);
  // Key the wording off the tier, not the raw verified flag: a demonstration proof
  // genuinely recomputes (verified=true) but runs on SAMPLE data — it must not read
  // as "on-chain verified".
  const verifiedNote = !proof
    ? "goal"
    : proof.tier === "verified-onchain"
      ? "goal verified on-chain"
      : proof.tier === "root-anchored"
        ? "goal root anchored on Solana"
        : "goal proof demonstrated (sample)";
  return {
    id: nextId("goal"),
    ts: Date.now(),
    strategy: "goal-trigger",
    matchId: match.id,
    matchLabel: `${match.home} vs ${match.away}`,
    outcome: o.key,
    selectionLabel: o.label,
    fairProb: bumped,
    decimalOdds: o.decimalOdds,
    edge: bumped * o.decimalOdds - 1,
    kellyStake: stake,
    ruinProb: a.simulation.ruinProbability,
    sharpe: a.metrics.sharpe,
    // Settle on the TRUE pre-goal probability — never the inflated trade prob, so
    // the goal strategy can't look systematically (and fictitiously) profitable.
    settleProb: o.fairProb,
    action: blocked ? "blocked" : isHeld ? "skip" : stake > 0 ? "bet" : "skip",
    reason: blocked
      ? blocked
      : isHeld
        ? "already holding this position — skipping duplicate goal trigger"
        : `${verifiedNote} → trade the dislocation before repricing ($${stake.toFixed(2)})`,
    verified: proof?.verified,
    proofRef: proof?.rootPda,
    proof,
  };
}
