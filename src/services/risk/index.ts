/**
 * Canvas Markets risk engine — public surface.
 *
 * Composes de-vig → edge/Kelly/Sharpe → Monte-Carlo ruin into a single
 * assessment for one selection, plus hedge tooling. All pure and deterministic:
 * the LLM layer narrates these numbers, it never computes them.
 */
export * from "./types.js";
export * from "./devig.js";
export * from "./kelly.js";
export * from "./metrics.js";
export * from "./montecarlo.js";
export * from "./hedge.js";

import { betMetrics, type BetMetrics } from "./metrics.js";
import { recommendedStake, type StakeRecommendation } from "./kelly.js";
import {
  simulateBankroll,
  compareStrategies,
  type SimulationResult,
  type StrategyComparison,
} from "./montecarlo.js";
import type { SequencedBet } from "./types.js";

export interface SelectionAssessment {
  outcome: string;
  decimalOdds: number;
  fairProb: number;
  bankroll: number;
  kellyFraction: number;
  metrics: BetMetrics;
  stake: StakeRecommendation;
  /** How many repeated bets of this character the simulation projects over. */
  horizonBets: number;
  simulation: SimulationResult;
  /** Ruin/growth across Kelly multiples — the "stay in the game" comparison. */
  strategies: StrategyComparison[];
}

/**
 * Full risk assessment for a single selection: what to stake, the edge quality,
 * and — projecting this staking discipline across a betting horizon — the
 * probability of ruin and the outcome fan.
 */
export function assessSelection(params: {
  outcome?: string;
  fairProb: number;
  decimalOdds: number;
  bankroll: number;
  kellyFraction?: number;
  cap?: number;
  horizonBets?: number;
  ruinThresholdFraction?: number;
  paths?: number;
  seed?: number;
}): SelectionAssessment {
  const kellyFraction = params.kellyFraction ?? 0.5;
  const horizonBets = params.horizonBets ?? 20;
  const paths = params.paths ?? 8_000;
  const seed = params.seed ?? 1;
  const ruinThreshold = (params.ruinThresholdFraction ?? 0.25) * params.bankroll;

  const metrics = betMetrics(params.fairProb, params.decimalOdds);
  const stake = recommendedStake({
    p: params.fairProb,
    decimalOdds: params.decimalOdds,
    bankroll: params.bankroll,
    kellyFraction,
    cap: params.cap,
  });

  const bets: SequencedBet[] = Array.from({ length: horizonBets }, () => ({
    p: params.fairProb,
    decimalOdds: params.decimalOdds,
    stakeFraction: stake.appliedFraction,
  }));

  const simulation = simulateBankroll({
    bets,
    startBankroll: params.bankroll,
    ruinThreshold,
    paths,
    seed,
  });

  const strategies = compareStrategies({
    p: params.fairProb,
    decimalOdds: params.decimalOdds,
    startBankroll: params.bankroll,
    nBets: horizonBets,
    ruinThreshold,
    paths: Math.min(paths, 5_000),
    seed,
  });

  return {
    outcome: params.outcome ?? "SELECTION",
    decimalOdds: params.decimalOdds,
    fairProb: params.fairProb,
    bankroll: params.bankroll,
    kellyFraction,
    metrics,
    stake,
    horizonBets,
    simulation,
    strategies,
  };
}
