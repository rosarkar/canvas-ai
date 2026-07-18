/**
 * Hedging — "two trades instead of one".
 *
 * Two complementary tools:
 *  1. lockInHedge: for mutually-exclusive outcomes of the *same* event (e.g. 1X2),
 *     compute stakes on the other outcomes that equalise the return across every
 *     result — converting a variable +EV position into a flat, guaranteed outcome
 *     (a lock-in profit when the book allows it, a capped loss otherwise).
 *  2. minVarianceTwoAsset: for two *correlated* markets, the Markowitz weights
 *     that minimise portfolio variance — negatively-correlated legs slash risk.
 */
import type { Position } from "./types.js";

export interface OutcomePayoff {
  outcome: string;
  /** Net profit/loss if this outcome occurs. */
  profit: number;
}

/** Net P/L for each outcome given a set of positions on that event. */
export function payoffVector(positions: Position[], outcomes: string[]): OutcomePayoff[] {
  return outcomes.map((outcome) => {
    const profit = positions.reduce((sum, pos) => {
      if (pos.outcome === outcome) return sum + pos.stake * (pos.decimalOdds - 1);
      return sum - pos.stake;
    }, 0);
    return { outcome, profit };
  });
}

export interface HedgeLegInput {
  outcome: string;
  decimalOdds: number;
}

export interface LockInHedge {
  /** The hedge trades to place (the "second trade(s)"). */
  legs: Position[];
  /** Total staked across primary + all hedge legs. */
  totalStaked: number;
  /** Gross return, identical for every outcome once hedged. */
  guaranteedReturn: number;
  /** guaranteedReturn − totalStaked (positive = locked profit / arbitrage). */
  guaranteedProfit: number;
  /** guaranteedProfit / totalStaked. */
  guaranteedRoi: number;
  /** True when the combined book prices allow a risk-free profit. */
  isArbitrage: boolean;
  /** Payoffs across outcomes before the hedge (shows the variance being removed). */
  unhedgedPayoff: OutcomePayoff[];
  /** Payoffs across outcomes after the hedge (flat line). */
  hedgedPayoff: OutcomePayoff[];
}

/**
 * Given a held primary position and the remaining outcomes' odds, size hedge
 * stakes so every outcome returns the same as the primary's winning payout.
 */
export function lockInHedge(params: { primary: Position; hedgeLegs: HedgeLegInput[] }): LockInHedge {
  const { primary, hedgeLegs } = params;
  // Equalise every outcome's gross return to the primary's winning payout.
  const target = primary.stake * primary.decimalOdds;

  const legs: Position[] = hedgeLegs.map((leg) => {
    if (!(leg.decimalOdds > 1)) throw new Error(`hedge leg odds must be > 1, got ${leg.decimalOdds}`);
    return { outcome: leg.outcome, decimalOdds: leg.decimalOdds, stake: target / leg.decimalOdds };
  });

  const totalStaked = primary.stake + legs.reduce((s, l) => s + l.stake, 0);
  const guaranteedProfit = target - totalStaked;
  const outcomes = [primary.outcome, ...legs.map((l) => l.outcome)];

  return {
    legs,
    totalStaked,
    guaranteedReturn: target,
    guaranteedProfit,
    guaranteedRoi: totalStaked > 0 ? guaranteedProfit / totalStaked : 0,
    isArbitrage: guaranteedProfit > 0,
    unhedgedPayoff: payoffVector([primary], outcomes),
    hedgedPayoff: payoffVector([primary, ...legs], outcomes),
  };
}

export interface TwoAssetPortfolio {
  weightA: number;
  weightB: number;
  expectedReturn: number;
  stdDev: number;
  sharpe: number;
}

/**
 * Minimum-variance weights for two correlated bets (long-only, weights sum to 1).
 * Closed form: wA = (σB² − ρσAσB) / (σA² + σB² − 2ρσAσB).
 */
export function minVarianceTwoAsset(params: {
  muA: number;
  sigmaA: number;
  muB: number;
  sigmaB: number;
  rho: number;
}): TwoAssetPortfolio {
  const { muA, sigmaA, muB, sigmaB, rho } = params;
  const cov = rho * sigmaA * sigmaB;
  const denom = sigmaA * sigmaA + sigmaB * sigmaB - 2 * cov;
  let wA = denom === 0 ? 0.5 : (sigmaB * sigmaB - cov) / denom;
  wA = Math.min(1, Math.max(0, wA)); // long-only
  const wB = 1 - wA;

  const variance = wA * wA * sigmaA * sigmaA + wB * wB * sigmaB * sigmaB + 2 * wA * wB * cov;
  const stdDev = Math.sqrt(Math.max(0, variance));
  const expectedReturn = wA * muA + wB * muB;

  return {
    weightA: wA,
    weightB: wB,
    expectedReturn,
    stdDev,
    sharpe: stdDev === 0 ? 0 : expectedReturn / stdDev,
  };
}
