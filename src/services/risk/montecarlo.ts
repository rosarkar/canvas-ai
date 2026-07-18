/**
 * Monte-Carlo bankroll simulation — the "will this keep me in the game?" engine.
 *
 * We simulate many independent bankroll trajectories through a sequence of bets,
 * compounding fractional-Kelly stakes, and report the *probability of ruin*
 * (dropping below a floor the bettor would quit at), the percentile fan of
 * outcomes, and the drawdown distribution. This is what turns "you have an edge"
 * into "…but at full Kelly you have a 34% chance of busting first."
 */
import type { SequencedBet } from "./types.js";

/** Deterministic, seedable PRNG (mulberry32) so simulations are reproducible/testable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BankrollBand {
  /** Bet index (0 = starting bankroll). */
  step: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface HistogramBin {
  x0: number;
  x1: number;
  count: number;
}

export interface SimulationResult {
  /** Fraction of paths that fell to/through the ruin floor at any point. */
  ruinProbability: number;
  /** Percentile bands of bankroll at each step (for the fan chart). */
  bands: BankrollBand[];
  /** Terminal-bankroll percentiles. */
  terminal: { p5: number; p25: number; p50: number; p75: number; p95: number; mean: number };
  /** Median per-bet log-growth rate (the Kelly objective). */
  medianLogGrowth: number;
  /** Worst peak-to-trough drawdown as a fraction, at the median and p95 path. */
  maxDrawdown: { p50: number; p95: number };
  /** Binned terminal-bankroll distribution (clipped to p1..p99) for a histogram. */
  terminalHistogram: HistogramBin[];
  /** A small sample of full trajectories for drawing individual lines. */
  samplePaths: number[][];
}

/** Bucket sorted values into nBins over [lo, hi]. */
function histogram(sorted: number[], nBins: number, lo: number, hi: number): HistogramBin[] {
  const width = (hi - lo) / nBins || 1;
  const bins: HistogramBin[] = Array.from({ length: nBins }, (_, i) => ({
    x0: lo + width * i,
    x1: lo + width * (i + 1),
    count: 0,
  }));
  for (const v of sorted) {
    if (v < lo || v > hi) continue;
    let idx = Math.floor((v - lo) / width);
    if (idx >= nBins) idx = nBins - 1;
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }
  return bins;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

/**
 * Run the simulation.
 * @param bets          Ordered sequence of bets (each stakes a fraction of *current* bankroll).
 * @param startBankroll Starting account balance.
 * @param ruinThreshold Bankroll level counted as "ruined" (default 25% of start).
 * @param paths         Number of trajectories (default 10,000).
 * @param seed          PRNG seed for reproducibility.
 * @param samplePathCount How many full trajectories to return for line rendering.
 */
export function simulateBankroll(params: {
  bets: SequencedBet[];
  startBankroll: number;
  ruinThreshold?: number;
  paths?: number;
  seed?: number;
  samplePathCount?: number;
}): SimulationResult {
  const { bets, startBankroll } = params;
  const paths = params.paths ?? 10_000;
  const seed = params.seed ?? 1;
  const ruinThreshold = params.ruinThreshold ?? 0.25 * startBankroll;
  const sampleCount = Math.min(params.samplePathCount ?? 40, paths);
  const nSteps = bets.length;

  const rng = mulberry32(seed);

  // bankrollAtStep[t] holds every path's bankroll at step t (t = 0..nSteps).
  const bankrollAtStep: number[][] = Array.from({ length: nSteps + 1 }, () => new Array<number>(paths));
  const samplePaths: number[][] = [];
  const drawdowns: number[] = new Array<number>(paths);
  let ruinCount = 0;

  for (let i = 0; i < paths; i++) {
    let bankroll = startBankroll;
    let peak = startBankroll;
    let maxDd = 0;
    let ruined = false;
    const path: number[] = sampleCount > 0 && i < sampleCount ? [startBankroll] : [];

    bankrollAtStep[0][i] = startBankroll;

    for (let t = 0; t < nSteps; t++) {
      const bet = bets[t];
      if (!ruined && bankroll > ruinThreshold && bet) {
        const stake = bet.stakeFraction * bankroll;
        const win = rng() < bet.p;
        bankroll += win ? stake * (bet.decimalOdds - 1) : -stake;
        if (bankroll > peak) peak = bankroll;
        const dd = peak > 0 ? (peak - bankroll) / peak : 0;
        if (dd > maxDd) maxDd = dd;
        if (bankroll <= ruinThreshold) {
          ruined = true;
          bankroll = Math.max(bankroll, 0);
        }
      }
      bankrollAtStep[t + 1][i] = bankroll;
      if (i < sampleCount) path.push(bankroll);
    }

    if (ruined) ruinCount++;
    drawdowns[i] = maxDd;
    if (i < sampleCount) samplePaths.push(path);
  }

  const bands: BankrollBand[] = bankrollAtStep.map((col, step) => {
    const sorted = [...col].sort((a, b) => a - b);
    return {
      step,
      p5: percentile(sorted, 0.05),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p95: percentile(sorted, 0.95),
    };
  });

  const terminalCol = [...bankrollAtStep[nSteps]].sort((a, b) => a - b);
  const terminalMean = terminalCol.reduce((s, x) => s + x, 0) / (terminalCol.length || 1);
  const sortedDd = [...drawdowns].sort((a, b) => a - b);

  const medianTerminal = percentile(terminalCol, 0.5);
  const medianLogGrowth =
    nSteps > 0 && medianTerminal > 0 ? Math.log(medianTerminal / startBankroll) / nSteps : 0;

  return {
    ruinProbability: ruinCount / paths,
    bands,
    terminal: {
      p5: percentile(terminalCol, 0.05),
      p25: percentile(terminalCol, 0.25),
      p50: medianTerminal,
      p75: percentile(terminalCol, 0.75),
      p95: percentile(terminalCol, 0.95),
      mean: terminalMean,
    },
    medianLogGrowth,
    maxDrawdown: { p50: percentile(sortedDd, 0.5), p95: percentile(sortedDd, 0.95) },
    terminalHistogram: histogram(
      terminalCol,
      24,
      percentile(terminalCol, 0.01),
      percentile(terminalCol, 0.99),
    ),
    samplePaths,
  };
}

export interface StrategyComparison {
  label: string;
  kellyMultiple: number;
  stakeFraction: number;
  ruinProbability: number;
  medianLogGrowth: number;
  terminalMedian: number;
}

/**
 * Compare flat vs fractional/over Kelly staking on a repeated single-edge bet.
 * Demonstrates the core lesson: past full Kelly, extra stake *lowers* growth and
 * *raises* ruin — the reason we recommend half-Kelly by default.
 */
export function compareStrategies(params: {
  p: number;
  decimalOdds: number;
  startBankroll: number;
  nBets: number;
  ruinThreshold?: number;
  paths?: number;
  seed?: number;
}): StrategyComparison[] {
  const { p, decimalOdds, startBankroll, nBets } = params;
  const b = decimalOdds - 1;
  const fullKelly = Math.max(0, (p * decimalOdds - 1) / b);
  const flatFraction = 0.02; // a fixed 2%-of-bankroll flat staker for contrast

  const strategies: { label: string; kellyMultiple: number; stakeFraction: number }[] = [
    { label: "Flat 2%", kellyMultiple: 0, stakeFraction: flatFraction },
    { label: "Quarter Kelly", kellyMultiple: 0.25, stakeFraction: fullKelly * 0.25 },
    { label: "Half Kelly", kellyMultiple: 0.5, stakeFraction: fullKelly * 0.5 },
    { label: "Full Kelly", kellyMultiple: 1, stakeFraction: fullKelly },
    { label: "Double Kelly", kellyMultiple: 2, stakeFraction: Math.min(fullKelly * 2, 0.999) },
  ];

  return strategies.map((s, idx) => {
    const bets: SequencedBet[] = Array.from({ length: nBets }, () => ({
      p,
      decimalOdds,
      stakeFraction: s.stakeFraction,
    }));
    const sim = simulateBankroll({
      bets,
      startBankroll,
      ruinThreshold: params.ruinThreshold,
      paths: params.paths ?? 5_000,
      seed: (params.seed ?? 1) + idx, // decorrelate strategy streams
      samplePathCount: 0,
    });
    return {
      label: s.label,
      kellyMultiple: s.kellyMultiple,
      stakeFraction: s.stakeFraction,
      ruinProbability: sim.ruinProbability,
      medianLogGrowth: sim.medianLogGrowth,
      terminalMedian: sim.terminal.p50,
    };
  });
}
