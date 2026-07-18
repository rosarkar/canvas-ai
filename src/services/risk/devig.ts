/**
 * De-vigging: turn a bookmaker's decimal odds (which carry a margin / "overround")
 * into fair probabilities that sum to 1.
 *
 * TxODDS ships a "true-price" feed that is already de-margined; for a marginated
 * feed we remove the vig ourselves. Two methods are provided:
 *  - multiplicative (default): proportional normalisation — simple and exact.
 *  - Shin: accounts for informed ("insider") money, correcting the
 *    favourite–longshot bias so favourites aren't systematically underpriced.
 */

/** Raw implied probability of a single decimal-odds quote (includes the vig). */
export function impliedProbability(decimalOdds: number): number {
  if (!(decimalOdds > 1)) throw new Error(`decimalOdds must be > 1, got ${decimalOdds}`);
  return 1 / decimalOdds;
}

/** Book sum Σ(1/oᵢ). Values > 1 mean the book carries a margin. */
export function bookSum(odds: number[]): number {
  return odds.reduce((s, o) => s + impliedProbability(o), 0);
}

/** Bookmaker margin ("overround / vig") as a fraction, e.g. 0.05 = 5%. */
export function margin(odds: number[]): number {
  return bookSum(odds) - 1;
}

/** Multiplicative de-vig: normalise raw implied probabilities to sum to 1. */
export function devigMultiplicative(odds: number[]): number[] {
  const implied = odds.map(impliedProbability);
  const total = implied.reduce((s, q) => s + q, 0);
  return implied.map((q) => q / total);
}

/**
 * Shin (1992) de-vig. Solves for z ∈ [0,1) — the estimated proportion of
 * informed money — such that the recovered probabilities sum to 1:
 *   pᵢ(z) = [√(z² + 4(1−z)·qᵢ²/B) − z] / (2(1−z)),  qᵢ = 1/oᵢ,  B = Σqⱼ
 * Root-found by bisection; falls back to multiplicative if it fails to converge.
 */
export function devigShin(odds: number[]): number[] {
  const q = odds.map(impliedProbability);
  const B = q.reduce((s, x) => s + x, 0);
  if (B <= 1) return devigMultiplicative(odds); // no margin → nothing to correct

  const probsAt = (z: number): number[] => {
    const denom = 2 * (1 - z);
    return q.map((qi) => (Math.sqrt(z * z + (4 * (1 - z) * qi * qi) / B) - z) / denom);
  };
  const sumAt = (z: number): number => probsAt(z).reduce((s, x) => s + x, 0);

  // f(z) = Σpᵢ(z) − 1 is monotone decreasing from f(0)=√B−1 > 0 toward < 0.
  let lo = 0;
  let hi = 0.9999;
  if (sumAt(lo) - 1 <= 0 || sumAt(hi) - 1 >= 0) return devigMultiplicative(odds);
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) - 1 > 0) lo = mid;
    else hi = mid;
  }
  const p = probsAt((lo + hi) / 2);
  const total = p.reduce((s, x) => s + x, 0);
  // Renormalise away any residual bisection error so it sums to exactly 1.
  return p.map((x) => x / total);
}

export type DevigMethod = "multiplicative" | "shin";

/** De-vig a set of mutually-exclusive-and-exhaustive odds into fair probabilities. */
export function devig(odds: number[], method: DevigMethod = "multiplicative"): number[] {
  return method === "shin" ? devigShin(odds) : devigMultiplicative(odds);
}
