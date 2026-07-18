/**
 * Kelly criterion for a binary bet.
 *
 * For a bet at decimal odds o (net odds b = o − 1) with fair win probability p,
 * the growth-optimal fraction of bankroll to stake is
 *   f* = (p·b − (1 − p)) / b = (p·o − 1) / (o − 1).
 *
 * Full Kelly maximises long-run log-growth but is famously volatile, so we
 * default to *fractional* Kelly (half by default) — this is the single biggest
 * lever on "probability of ruin" and the reason a bettor stays in the game.
 */

/** Growth-optimal Kelly fraction. Can be ≤ 0, meaning the bet has no edge — don't bet. */
export function kellyFraction(p: number, decimalOdds: number): number {
  if (!(p >= 0 && p <= 1)) throw new Error(`p must be in [0,1], got ${p}`);
  if (!(decimalOdds > 1)) throw new Error(`decimalOdds must be > 1, got ${decimalOdds}`);
  const b = decimalOdds - 1;
  return (p * decimalOdds - 1) / b;
}

/** Scale a Kelly fraction (e.g. half-Kelly). Negative edge collapses to 0 (no bet). */
export function fractionalKelly(fStar: number, fraction = 0.5): number {
  if (fStar <= 0) return 0;
  return fStar * fraction;
}

export interface StakeRecommendation {
  /** Raw full-Kelly fraction (may be negative → no edge). */
  fullKelly: number;
  /** Fraction actually applied after the fractional multiplier + cap. */
  appliedFraction: number;
  /** Recommended stake in account units. */
  stake: number;
  /** True when there is positive edge and a stake is recommended. */
  bet: boolean;
}

/**
 * Turn an edge into a concrete, safety-capped stake.
 * @param cap Hard ceiling on bankroll fraction regardless of Kelly (default 25%).
 */
export function recommendedStake(params: {
  p: number;
  decimalOdds: number;
  bankroll: number;
  kellyFraction?: number;
  cap?: number;
}): StakeRecommendation {
  const { p, decimalOdds, bankroll } = params;
  const fraction = params.kellyFraction ?? 0.5;
  const cap = params.cap ?? 0.25;

  const fullKelly = kellyFraction(p, decimalOdds);
  const scaled = fractionalKelly(fullKelly, fraction);
  const appliedFraction = Math.min(scaled, cap);
  const stake = Math.max(0, appliedFraction * bankroll);

  return {
    fullKelly,
    appliedFraction,
    stake,
    bet: appliedFraction > 0 && stake > 0,
  };
}
