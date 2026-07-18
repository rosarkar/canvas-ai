/**
 * Executor — compose and (optionally) submit the Bankr order for a decision.
 *
 * The order follows the sponsor's blueprint: cross-chain-swap Solana funds to
 * Polygon USDC.e, then buy the Polymarket shares. `simulated` (default) shows
 * the exact order without moving funds; `live` submits it to Bankr.
 */
import { logger } from "@/utils/logger.js";
import { isBankrConfigured, runPrompt } from "@/services/bankr.client.js";
import type { AgentDecision, AgentPosition, AgentState, ExecutionMode } from "./types.js";

let posCounter = 0;
const posId = (): string => `pos-${Date.now().toString(36)}-${(posCounter++).toString(36)}`;

export function composeAgentOrder(d: AgentDecision): string {
  return (
    `Fund and bet $${d.kellyStake.toFixed(2)} USDC on "${d.selectionLabel}" (${d.outcome}) in ${d.matchLabel}. ` +
    `If my USDC is on Solana, smart_cross_chain_swap it to Polygon USDC.e first, then ` +
    `buy_polymarket_shares on the matching World Cup market near ${d.decimalOdds.toFixed(2)} decimal odds.`
  );
}

export function currentMode(): ExecutionMode {
  return process.env.EXECUTION_MODE?.trim() === "live" && isBankrConfigured() ? "live" : "simulated";
}

/** Execute a "bet" decision. Commits the stake from bankroll and opens a position. */
export async function executeDecision(
  d: AgentDecision,
  state: AgentState,
): Promise<AgentPosition | null> {
  if (d.action !== "bet" || d.kellyStake <= 0) return null;
  const mode = currentMode();
  const prompt = composeAgentOrder(d);
  const pos: AgentPosition = {
    id: posId(),
    ts: Date.now(),
    matchId: d.matchId,
    selectionLabel: d.selectionLabel,
    outcome: d.outcome,
    stake: d.kellyStake,
    decimalOdds: d.decimalOdds,
    fairProb: d.fairProb,
    settleProb: d.settleProb,
    status: "open",
    pnl: 0,
    mode,
    orderPrompt: prompt,
    strategy: d.strategy,
  };

  if (mode === "live") {
    // Only commit the stake once Bankr accepts the order. A failed live order must
    // NOT open a position or debit bankroll (that would silently drain the book).
    try {
      const r = await runPrompt(prompt, { maxWaitMs: 90_000 });
      if (!r.jobId) throw new Error(`no jobId (status ${r.status})`);
      pos.jobId = r.jobId;
      logger.info({ jobId: r.jobId }, "Agent live order submitted to Bankr");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "Bankr live execution failed — not opening position");
      return null;
    }
  }

  state.bankroll -= d.kellyStake; // stake committed
  return pos;
}
