/**
 * Per-bet risk/return metrics.
 *
 * A binary bet's per-unit-stake return R is a two-point distribution:
 *   R = +(o − 1) with probability p   (win)
 *   R = −1       with probability 1−p (lose)
 * so its mean is the edge and its std has the clean closed form σ = o·√(p(1−p)).
 */

/** Expected value per unit staked = p·o − 1 (a.k.a. the "edge"). Positive ⇒ +EV. */
export function edge(p: number, decimalOdds: number): number {
  return p * decimalOdds - 1;
}

/** Expected profit on a concrete stake. */
export function expectedValue(p: number, decimalOdds: number, stake: number): number {
  return stake * edge(p, decimalOdds);
}

/** Standard deviation of the per-unit-stake return: σ = o·√(p(1−p)). */
export function returnStdDev(p: number, decimalOdds: number): number {
  return decimalOdds * Math.sqrt(p * (1 - p));
}

/**
 * Per-bet Sharpe ratio: edge divided by the return's standard deviation.
 * Stake-independent (both mean and σ scale linearly with stake), so it measures
 * the *quality* of the edge, not its size. Higher = more reward per unit risk.
 */
export function sharpeRatio(p: number, decimalOdds: number): number {
  const sigma = returnStdDev(p, decimalOdds);
  if (sigma === 0) return 0;
  return edge(p, decimalOdds) / sigma;
}

export interface BetMetrics {
  fairProb: number;
  decimalOdds: number;
  /** Market's own implied probability (1/odds) for reference. */
  impliedProb: number;
  /** p − impliedProb: how much sharper our fair price is than the market. */
  probEdge: number;
  edge: number;
  sharpe: number;
  returnStdDev: number;
}

/** Bundle the headline metrics for one selection. */
export function betMetrics(p: number, decimalOdds: number): BetMetrics {
  return {
    fairProb: p,
    decimalOdds,
    impliedProb: 1 / decimalOdds,
    probEdge: p - 1 / decimalOdds,
    edge: edge(p, decimalOdds),
    sharpe: sharpeRatio(p, decimalOdds),
    returnStdDev: returnStdDev(p, decimalOdds),
  };
}
