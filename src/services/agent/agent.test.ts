import { describe, expect, it } from "vitest";
import { DEFAULT_RISK, type AgentPosition, type AgentState } from "./types.js";
import type { MatchOdds } from "@/services/txodds.client.js";

// Config is env-gated; set throwaway values before importing modules that load it.
process.env.DATABASE_URL ??= "postgres://agent-test";
process.env.TELEGRAM_BOT_TOKEN ??= "agent-test";
process.env.TELEGRAM_WEBHOOK_URL ??= "http://localhost";
process.env.TELEGRAM_WEBHOOK_SECRET ??= "agent-test";

const { riskBlock, evaluateMatches, goalTriggerDecision } = await import("./strategy.js");
const { executeDecision, composeAgentOrder } = await import("./executor.js");

function freshState(over: Partial<AgentState> = {}): AgentState {
  return {
    running: false,
    startedAt: null,
    lastTickTs: null,
    mode: "simulated",
    source: "fixture",
    startingBankroll: 1000,
    bankroll: 1000,
    realizedPnl: 0,
    risk: { ...DEFAULT_RISK },
    blockedReason: null,
    decisions: [],
    positions: [],
    ...over,
  };
}

function oneMatch(fairProb: number, odds: number): MatchOdds {
  const edge = fairProb * odds - 1;
  return {
    id: "m1",
    competition: "WC",
    stage: "Group",
    home: "A",
    away: "B",
    kickoff: new Date(0).toISOString(),
    status: "scheduled",
    markets: [
      {
        key: "1X2",
        label: "Result",
        outcomes: [
          { key: "HOME", label: "A", fairProb, decimalOdds: odds, impliedProb: 1 / odds, edge },
          { key: "AWAY", label: "B", fairProb: 1 - fairProb, decimalOdds: 2, impliedProb: 0.5, edge: (1 - fairProb) * 2 - 1 },
        ],
      },
    ],
    bestEdge: edge,
    source: "fixture",
  };
}

const openPos = (over: Partial<AgentPosition>): AgentPosition => ({
  id: "p1",
  ts: 0,
  matchId: "m1",
  selectionLabel: "A",
  outcome: "HOME",
  stake: 50,
  decimalOdds: 2,
  fairProb: 0.6,
  settleProb: 0.6,
  status: "open",
  pnl: 0,
  mode: "simulated",
  orderPrompt: "",
  strategy: "value-edge",
  ...over,
});

describe("riskBlock", () => {
  it("halts at the daily loss cap", () => {
    expect(riskBlock(freshState({ realizedPnl: -DEFAULT_RISK.dailyLossCapUsd }))).toMatch(/daily loss cap/i);
  });
  it("halts at the ruin stop (bankroll below floor)", () => {
    const s = freshState({ bankroll: DEFAULT_RISK.ruinStopFraction * 1000 - 1 });
    expect(riskBlock(s)).toMatch(/ruin stop/i);
  });
  it("does not halt a healthy book", () => {
    expect(riskBlock(freshState())).toBeNull();
  });
});

describe("evaluateMatches (value-edge)", () => {
  it("bets a positive-edge outcome and settles on the true fair prob", () => {
    const decisions = evaluateMatches([oneMatch(0.6, 2)], freshState());
    const home = decisions.find((d) => d.outcome === "HOME");
    expect(home?.action).toBe("bet");
    expect(home?.settleProb).toBeCloseTo(0.6, 10); // never inflated
  });
  it("skips an outcome below the min-edge threshold", () => {
    const decisions = evaluateMatches([oneMatch(0.5, 2)], freshState()); // edge 0 < minEdge
    expect(decisions.find((d) => d.outcome === "HOME")).toBeUndefined();
  });
  it("blocks every decision when a risk limit is tripped", () => {
    const decisions = evaluateMatches([oneMatch(0.6, 2)], freshState({ realizedPnl: -500 }));
    expect(decisions.every((d) => d.action === "blocked")).toBe(true);
  });
});

describe("goalTriggerDecision", () => {
  it("bumps the trade prob but settles on the unbumped prob (no fictitious edge)", () => {
    const d = goalTriggerDecision(oneMatch(0.5, 2), "HOME", freshState())!;
    expect(d.fairProb).toBeGreaterThan(0.5); // 0.5 + 0.25*(1-0.5) = 0.625
    expect(d.fairProb).toBeCloseTo(0.625, 10);
    expect(d.settleProb).toBeCloseTo(0.5, 10); // settle on the TRUE prob
    expect(d.action).toBe("bet");
  });
  it("de-dupes: skips a goal on a position already held", () => {
    const s = freshState({ positions: [openPos({ outcome: "HOME" })] });
    const d = goalTriggerDecision(oneMatch(0.5, 2), "HOME", s)!;
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/already holding/i);
  });
  it("is blocked when a risk limit is tripped", () => {
    const d = goalTriggerDecision(oneMatch(0.5, 2), "HOME", freshState({ realizedPnl: -500 }))!;
    expect(d.action).toBe("blocked");
  });
});

describe("executor", () => {
  it("debits the stake and carries settleProb on a simulated bet", async () => {
    const s = freshState();
    const d = goalTriggerDecision(oneMatch(0.5, 2), "HOME", s)!;
    const before = s.bankroll;
    const pos = await executeDecision(d, s);
    expect(pos).not.toBeNull();
    expect(pos!.settleProb).toBeCloseTo(0.5, 10);
    expect(s.bankroll).toBeCloseTo(before - d.kellyStake, 6);
    expect(pos!.mode).toBe("simulated");
  });
  it("composes a Bankr cross-chain order per the sponsor blueprint", () => {
    const d = goalTriggerDecision(oneMatch(0.5, 2), "HOME", freshState())!;
    const order = composeAgentOrder(d);
    expect(order).toMatch(/smart_cross_chain_swap/);
    expect(order).toMatch(/buy_polymarket_shares/);
  });
});
