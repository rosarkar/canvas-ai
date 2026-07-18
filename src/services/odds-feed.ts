/**
 * Odds-feed resolver — picks the real TxLINE (Solana) feed when enabled and
 * reachable, otherwise falls back to the labelled sample/ TxODDS feed. One
 * async entry point so every surface (markets, agent, fan) shares the choice.
 */
import { config } from "@/config/index.js";
import { logger } from "@/utils/logger.js";
import { getOddsFeed as getTxoddsFeed, type OddsFeed } from "@/services/txodds.client.js";
import { TxLineFeed } from "@/services/txline/feed.js";

let cached: OddsFeed | null = null;

export async function resolveOddsFeed(): Promise<OddsFeed> {
  if (cached) return cached;
  if (config.solana.useTxline) {
    try {
      const feed = new TxLineFeed();
      await feed.ensureReady();
      logger.info("Odds source: live TxLINE (Solana, on-chain-verified)");
      cached = feed;
      return feed;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "TxLINE feed unavailable (e.g. no devnet SOL) — falling back to sample fixtures",
      );
    }
  }
  cached = getTxoddsFeed();
  return cached;
}

/** Reset the cached feed (used by tests / after config changes). */
export function resetOddsFeed(): void {
  cached = null;
}
