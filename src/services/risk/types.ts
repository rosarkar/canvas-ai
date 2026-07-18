/**
 * Shared types for the Canvas Markets risk engine.
 *
 * The engine is intentionally decoupled from any specific market structure: it
 * reasons about *binary bets* — a stake on a single outcome at some decimal odds
 * with a fair win probability. The TxODDS / market layer maps 1X2, over/under,
 * BTTS, etc. onto these primitives.
 */

/** A single backable outcome with the sharp (de-vigged) fair probability attached. */
export interface Selection {
  /** Outcome key, e.g. "HOME" | "DRAW" | "AWAY" | "OVER_2_5". */
  outcome: string;
  /** Decimal odds available to bet (payout multiple incl. stake). */
  decimalOdds: number;
  /** Fair win probability in [0,1] (de-vigged sharp price). */
  fairProb: number;
}

/** A taken position: a stake (in account units, e.g. USDC) on one outcome. */
export interface Position {
  outcome: string;
  decimalOdds: number;
  stake: number;
}

/** One leg of a bet sequence for the Monte-Carlo bankroll simulation. */
export interface SequencedBet {
  /** Fair win probability. */
  p: number;
  /** Decimal odds. */
  decimalOdds: number;
  /** Fraction of *current* bankroll staked on this bet (Kelly-style compounding). */
  stakeFraction: number;
}
