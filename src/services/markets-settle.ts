/**
 * Settlement — turn a risk-approved position (plus its hedge) into on-chain bets
 * via Bankr's natural-language Agent API.
 *
 * Bankr already understands "place bets on outcomes" across its prediction-market
 * integration; we simply compose the order(s) and hand them over. Default mode is
 * `simulated`: the exact prompt is returned and shown, but no funds move. Flip
 * `MARKETS_LIVE_SETTLEMENT=true` (with a BANKR_API_KEY) to place real bets.
 */
import { config } from "@/config/index.js";
import { logger } from "@/utils/logger.js";
import { isBankrConfigured, runPrompt } from "@/services/bankr.client.js";

export interface SettlementLegInput {
  role: "primary" | "hedge";
  /** Human selection, e.g. "Argentina". */
  selectionLabel: string;
  /** Outcome key, e.g. "HOME". */
  outcome: string;
  /** Match label, e.g. "Argentina vs Mexico". */
  matchLabel: string;
  competition: string;
  decimalOdds: number;
  /** Stake in USDC. */
  stake: number;
}

export interface SettlementLegResult extends SettlementLegInput {
  /** The natural-language order composed for Bankr. */
  prompt: string;
  jobId?: string;
  status?: string;
  response?: string;
  error?: string;
}

export interface SettlementResult {
  mode: "simulated" | "live";
  legs: SettlementLegResult[];
  note: string;
}

/** Compose the Bankr order text for one leg. */
export function composeOrder(leg: SettlementLegInput): string {
  const stake = leg.stake.toFixed(2);
  const roleNote =
    leg.role === "hedge" ? " (hedge leg to cap downside)" : "";
  return (
    `Bet $${stake} USDC on "${leg.selectionLabel}" (${leg.outcome}) in the ${leg.competition} ` +
    `match ${leg.matchLabel} at decimal odds ${leg.decimalOdds}${roleNote}.`
  );
}

/**
 * Settle a set of legs. In simulated mode returns the composed prompts only;
 * in live mode submits each to Bankr and reports job status.
 */
export async function settle(legs: SettlementLegInput[]): Promise<SettlementResult> {
  const live = config.markets.liveSettlement && isBankrConfigured();
  const composed: SettlementLegResult[] = legs.map((leg) => ({ ...leg, prompt: composeOrder(leg) }));

  if (!live) {
    const why = !config.markets.liveSettlement
      ? "MARKETS_LIVE_SETTLEMENT is off"
      : "BANKR_API_KEY is not set";
    return {
      mode: "simulated",
      legs: composed,
      note: `Simulated — no funds moved (${why}). These are the exact orders Bankr would execute.`,
    };
  }

  logger.info({ legs: composed.length }, "Markets: submitting live settlement to Bankr");
  for (const leg of composed) {
    try {
      const result = await runPrompt(leg.prompt, { maxWaitMs: 90_000 });
      leg.jobId = result.jobId;
      leg.status = result.status;
      leg.response = result.response;
      leg.error = result.error;
    } catch (err) {
      leg.status = "failed";
      leg.error = err instanceof Error ? err.message : String(err);
      logger.error({ err, leg: leg.prompt }, "Bankr settlement leg failed");
    }
  }

  return {
    mode: "live",
    legs: composed,
    note: "Live — orders submitted to Bankr for on-chain execution.",
  };
}
