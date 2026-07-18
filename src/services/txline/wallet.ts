/**
 * Devnet Solana wallet helpers for the TxLINE subscription.
 *
 * The free World Cup tier requires no TxL payment, but the wallet still needs
 * SOL for the on-chain `subscribe` transaction + account rent. On devnet that
 * SOL is free via airdrop.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "@/utils/logger.js";

/** Parse a secret key from a base58 string or a JSON byte array; else generate one. */
export function loadOrCreateKeypair(secret?: string): { keypair: Keypair; ephemeral: boolean } {
  const trimmed = secret?.trim();
  if (trimmed) {
    try {
      const bytes = trimmed.startsWith("[")
        ? Uint8Array.from(JSON.parse(trimmed) as number[])
        : bs58.decode(trimmed);
      return { keypair: Keypair.fromSecretKey(bytes), ephemeral: false };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Invalid SOLANA_DEVNET_SECRET_KEY — using ephemeral key");
    }
  }
  return { keypair: Keypair.generate(), ephemeral: true };
}

export function anchorWallet(keypair: Keypair): anchor.Wallet {
  return new anchor.Wallet(keypair);
}

/** Ensure the wallet has at least `minSol`; airdrops on devnet if short. Returns SOL balance. */
export async function ensureSol(
  connection: Connection,
  pubkey: PublicKey,
  minSol = 0.5,
): Promise<number> {
  const lamports = await connection.getBalance(pubkey);
  if (lamports >= minSol * LAMPORTS_PER_SOL) return lamports / LAMPORTS_PER_SOL;
  try {
    logger.info({ pubkey: pubkey.toBase58() }, "Requesting devnet SOL airdrop");
    const sig = await connection.requestAirdrop(pubkey, LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Airdrop failed (devnet rate limit?) — continuing");
  }
  return (await connection.getBalance(pubkey)) / LAMPORTS_PER_SOL;
}

/** Export a keypair as a base58 secret string (for persisting into .env). */
export function secretKeyBase58(keypair: Keypair): string {
  return bs58.encode(keypair.secretKey);
}
