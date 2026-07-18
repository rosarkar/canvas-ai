import { describe, expect, it } from "vitest";

import {
  bookSum,
  margin,
  devigMultiplicative,
  devigShin,
  impliedProbability,
} from "./devig.js";
import { kellyFraction, fractionalKelly, recommendedStake } from "./kelly.js";
import { edge, returnStdDev, sharpeRatio, betMetrics } from "./metrics.js";
import { simulateBankroll, compareStrategies, mulberry32 } from "./montecarlo.js";
import { lockInHedge, minVarianceTwoAsset, payoffVector } from "./hedge.js";
import { assessSelection } from "./index.js";
import type { SequencedBet } from "./types.js";

describe("devig", () => {
  it("impliedProbability inverts decimal odds", () => {
    expect(impliedProbability(2)).toBeCloseTo(0.5, 10);
    expect(impliedProbability(4)).toBeCloseTo(0.25, 10);
  });

  it("bookSum/margin measure the overround", () => {
    expect(bookSum([2, 4, 4])).toBeCloseTo(1, 10); // fair book
    expect(margin([1.9, 3.5, 4.0])).toBeCloseTo(0.062030, 4);
  });

  it("multiplicative de-vig returns fair probabilities that sum to 1", () => {
    const p = devigMultiplicative([1.9, 3.5, 4.0]);
    expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
    expect(p[0]).toBeGreaterThan(p[1]); // favourite most likely
  });

  it("multiplicative de-vig is identity on a fair book", () => {
    expect(devigMultiplicative([2, 4, 4])).toEqual([0.5, 0.25, 0.25]);
  });

  it("Shin de-vig also sums to 1 with all probabilities in (0,1)", () => {
    const p = devigShin([1.9, 3.5, 4.0]);
    expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
    for (const x of p) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
    }
    // Shin shifts probability toward the favourite vs multiplicative.
    const m = devigMultiplicative([1.9, 3.5, 4.0]);
    expect(p[0]).toBeGreaterThan(m[0]);
  });
});

describe("kelly", () => {
  it("computes the binary Kelly fraction", () => {
    expect(kellyFraction(0.55, 2.0)).toBeCloseTo(0.1, 10); // (0.55*2-1)/1
    expect(kellyFraction(0.5, 3.0)).toBeCloseTo(0.25, 10); // (0.5*3-1)/2
  });

  it("is negative when the bet has no edge", () => {
    expect(kellyFraction(0.4, 2.0)).toBeCloseTo(-0.2, 10);
  });

  it("fractionalKelly halves a positive edge and zeroes a negative one", () => {
    expect(fractionalKelly(0.1, 0.5)).toBeCloseTo(0.05, 10);
    expect(fractionalKelly(-0.2, 0.5)).toBe(0);
  });

  it("recommendedStake applies the fraction and cap", () => {
    const r = recommendedStake({ p: 0.55, decimalOdds: 2.0, bankroll: 1000, kellyFraction: 0.5 });
    expect(r.fullKelly).toBeCloseTo(0.1, 10);
    expect(r.appliedFraction).toBeCloseTo(0.05, 10);
    expect(r.stake).toBeCloseTo(50, 10);
    expect(r.bet).toBe(true);
  });

  it("recommendedStake caps an aggressive edge", () => {
    // Huge edge → full Kelly 0.5, half 0.25, but cap defaults to 0.25.
    const r = recommendedStake({ p: 0.75, decimalOdds: 2.0, bankroll: 1000, kellyFraction: 1 });
    expect(r.fullKelly).toBeCloseTo(0.5, 10);
    expect(r.appliedFraction).toBeCloseTo(0.25, 10); // capped
    expect(r.stake).toBeCloseTo(250, 10);
  });

  it("recommendedStake says don't bet with no edge", () => {
    const r = recommendedStake({ p: 0.4, decimalOdds: 2.0, bankroll: 1000 });
    expect(r.bet).toBe(false);
    expect(r.stake).toBe(0);
  });
});

describe("metrics", () => {
  it("edge = p·o − 1", () => {
    expect(edge(0.55, 2.0)).toBeCloseTo(0.1, 10);
    expect(edge(0.5, 2.0)).toBeCloseTo(0, 10); // fair coin at even money
  });

  it("returnStdDev = o·√(p(1−p))", () => {
    expect(returnStdDev(0.55, 2.0)).toBeCloseTo(2 * Math.sqrt(0.55 * 0.45), 10);
  });

  it("sharpe = edge / stdDev", () => {
    expect(sharpeRatio(0.55, 2.0)).toBeCloseTo(0.1 / (2 * Math.sqrt(0.2475)), 8);
  });

  it("betMetrics bundles implied prob and prob edge", () => {
    const m = betMetrics(0.55, 2.0);
    expect(m.impliedProb).toBeCloseTo(0.5, 10);
    expect(m.probEdge).toBeCloseTo(0.05, 10);
    expect(m.edge).toBeCloseTo(0.1, 10);
  });
});

describe("montecarlo", () => {
  it("mulberry32 is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });

  const betsAt = (frac: number, n: number): SequencedBet[] =>
    Array.from({ length: n }, () => ({ p: 0.55, decimalOdds: 2.0, stakeFraction: frac }));

  it("is reproducible with the same seed", () => {
    const run = () =>
      simulateBankroll({ bets: betsAt(0.1, 40), startBankroll: 1000, paths: 2000, seed: 7 });
    expect(run().ruinProbability).toBe(run().ruinProbability);
  });

  it("starts flat and returns ordered terminal percentiles", () => {
    const sim = simulateBankroll({ bets: betsAt(0.05, 30), startBankroll: 1000, paths: 2000, seed: 1 });
    expect(sim.bands).toHaveLength(31);
    expect(sim.bands[0].p5).toBe(1000);
    expect(sim.bands[0].p95).toBe(1000);
    expect(sim.terminal.p5).toBeLessThanOrEqual(sim.terminal.p50);
    expect(sim.terminal.p50).toBeLessThanOrEqual(sim.terminal.p95);
  });

  it("over-betting raises the probability of ruin (the core lesson)", () => {
    const common = { startBankroll: 1000, ruinThreshold: 250, paths: 4000, seed: 3 };
    const half = simulateBankroll({ bets: betsAt(0.05, 60), ...common }); // half Kelly
    const dbl = simulateBankroll({ bets: betsAt(0.2, 60), ...common }); // double Kelly
    expect(dbl.ruinProbability).toBeGreaterThan(half.ruinProbability);
    expect(half.ruinProbability).toBeLessThan(0.1);
  });

  it("full Kelly grows faster than double Kelly", () => {
    const common = { startBankroll: 1000, paths: 4000, seed: 5 };
    const full = simulateBankroll({ bets: betsAt(0.1, 80), ...common });
    const dbl = simulateBankroll({ bets: betsAt(0.2, 80), ...common });
    expect(full.medianLogGrowth).toBeGreaterThan(dbl.medianLogGrowth);
  });

  it("compareStrategies ranks ruin by aggressiveness", () => {
    const rows = compareStrategies({
      p: 0.55,
      decimalOdds: 2.0,
      startBankroll: 1000,
      nBets: 50,
      ruinThreshold: 250,
      paths: 4000,
      seed: 9,
    });
    expect(rows).toHaveLength(5);
    const quarter = rows.find((r) => r.label === "Quarter Kelly")!;
    const double = rows.find((r) => r.label === "Double Kelly")!;
    expect(double.ruinProbability).toBeGreaterThan(quarter.ruinProbability);
  });
});

describe("hedge", () => {
  it("payoffVector nets stake on the winner against stakes on the losers", () => {
    const payoff = payoffVector(
      [{ outcome: "HOME", decimalOdds: 3.0, stake: 100 }],
      ["HOME", "DRAW", "AWAY"],
    );
    expect(payoff.find((p) => p.outcome === "HOME")!.profit).toBeCloseTo(200, 10);
    expect(payoff.find((p) => p.outcome === "DRAW")!.profit).toBeCloseTo(-100, 10);
  });

  it("lockInHedge flattens the payoff across every outcome", () => {
    const h = lockInHedge({
      primary: { outcome: "HOME", decimalOdds: 3.0, stake: 100 },
      hedgeLegs: [
        { outcome: "DRAW", decimalOdds: 3.5 },
        { outcome: "AWAY", decimalOdds: 3.0 },
      ],
    });
    // Every hedged outcome yields the same profit (variance removed).
    const profits = h.hedgedPayoff.map((p) => p.profit);
    for (const pr of profits) expect(pr).toBeCloseTo(profits[0], 6);
    // This book (Σ1/o = 0.952 < 1) is an arbitrage → locked profit.
    expect(h.isArbitrage).toBe(true);
    expect(h.guaranteedProfit).toBeCloseTo(14.2857, 3);
    expect(h.guaranteedRoi).toBeCloseTo(0.05, 3);
  });

  it("lockInHedge locks a capped loss when the book has margin", () => {
    const h = lockInHedge({
      primary: { outcome: "HOME", decimalOdds: 2.0, stake: 100 },
      hedgeLegs: [
        { outcome: "DRAW", decimalOdds: 3.5 },
        { outcome: "AWAY", decimalOdds: 4.0 },
      ],
    });
    expect(h.isArbitrage).toBe(false);
    expect(h.guaranteedProfit).toBeCloseTo(-7.1428, 3);
  });

  it("minVarianceTwoAsset halves risk for two negatively-correlated bets", () => {
    const p = minVarianceTwoAsset({ muA: 0.1, sigmaA: 1, muB: 0.1, sigmaB: 1, rho: -0.5 });
    expect(p.weightA).toBeCloseTo(0.5, 6);
    expect(p.stdDev).toBeCloseTo(0.5, 6); // down from 1.0 for either leg alone
  });
});

describe("assessSelection", () => {
  it("bundles metrics, stake, simulation and strategy comparison", () => {
    const a = assessSelection({
      outcome: "HOME",
      fairProb: 0.55,
      decimalOdds: 2.0,
      bankroll: 1000,
      kellyFraction: 0.5,
      horizonBets: 20,
      paths: 3000,
      seed: 1,
    });
    expect(a.stake.stake).toBeCloseTo(50, 6); // half-Kelly of $1000
    expect(a.metrics.edge).toBeCloseTo(0.1, 6);
    expect(a.simulation.bands).toHaveLength(21);
    expect(a.strategies).toHaveLength(5);
    expect(a.simulation.ruinProbability).toBeGreaterThanOrEqual(0);
    expect(a.simulation.ruinProbability).toBeLessThanOrEqual(1);
  });

  it("recommends no bet and a flat simulation when there is no edge", () => {
    const a = assessSelection({ fairProb: 0.4, decimalOdds: 2.0, bankroll: 1000, paths: 1000 });
    expect(a.stake.bet).toBe(false);
    expect(a.simulation.ruinProbability).toBe(0); // never bets → never ruined
  });
});
