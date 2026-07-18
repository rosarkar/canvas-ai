/**
 * TxLINE Solana program config + Anchor loader.
 *
 * TxLINE (TxODDS' on-chain sports-data oracle, program `txoracle`) delivers
 * cryptographically-verifiable World Cup data. Access is granted by an on-chain
 * `subscribe` transaction, after which a signed message activates a REST/SSE API
 * token. Program IDs, hosts, and TXL mints come from the TxODDS docs.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SolanaNetwork = "devnet" | "mainnet";

export interface TxLineNetworkConfig {
  network: SolanaNetwork;
  rpcUrl: string;
  apiOrigin: string;
  programId: PublicKey;
  txlTokenMint: PublicKey;
  /** Free-tier service level (devnet: 1; mainnet: 1 = 60s delay, 12 = realtime). */
  freeServiceLevel: number;
}

export const TXLINE_NETWORKS: Record<SolanaNetwork, TxLineNetworkConfig> = {
  devnet: {
    network: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    apiOrigin: "https://txline-dev.txodds.com",
    programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
    txlTokenMint: new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
    freeServiceLevel: 1,
  },
  mainnet: {
    network: "mainnet",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    apiOrigin: "https://txline.txodds.com",
    programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
    txlTokenMint: new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
    freeServiceLevel: 1,
  },
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Load the txoracle Anchor IDL (fetched on-chain). Falls back to the devnet IDL. */
export function loadIdl(network: SolanaNetwork): anchor.Idl {
  const specific = path.join(moduleDir, "idl", `txoracle-${network}.json`);
  const fallback = path.join(moduleDir, "idl", "txoracle-devnet.json");
  const file = fs.existsSync(specific) ? specific : fallback;
  return JSON.parse(fs.readFileSync(file, "utf8")) as anchor.Idl;
}

export interface TxLineProgramHandle {
  program: anchor.Program;
  provider: anchor.AnchorProvider;
  connection: Connection;
  cfg: TxLineNetworkConfig;
}

/** Build an Anchor `Program` for the given network + wallet. */
export function makeProgram(cfg: TxLineNetworkConfig, wallet: anchor.Wallet): TxLineProgramHandle {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = loadIdl(cfg.network);
  // Anchor 0.30+ reads the program id from idl.address — pin it to this network.
  (idl as anchor.Idl & { address?: string }).address = cfg.programId.toBase58();
  const program = new anchor.Program(idl, provider);
  return { program, provider, connection, cfg };
}

// --- PDA derivations (seeds per TxLINE docs) ---
export function pricingMatrixPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], programId)[0];
}

export function tokenTreasuryPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], programId)[0];
}

/** Daily scores Merkle-roots PDA for on-chain score-proof verification. */
export function dailyScoresRootsPda(programId: PublicKey, epochDay: number): PublicKey {
  const seed = Buffer.alloc(2);
  seed.writeUInt16LE(epochDay, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), seed],
    programId,
  )[0];
}

/**
 * Candidate PDAs the day's scores root may live under. The Anchor 0.30 IDL does
 * not encode seed bytes, and the program refers to the account both as
 * `daily_scores_roots` (insert) and `daily_scores_merkle_roots` (validate_stat),
 * so we probe a small set of seed encodings and use whichever is actually
 * anchored on-chain. Kept explicit + honest rather than asserting one blindly.
 */
export function dailyScoresRootPdaCandidates(
  programId: PublicKey,
  epochDay: number,
): { label: string; pda: PublicKey }[] {
  const u16 = Buffer.alloc(2);
  u16.writeUInt16LE(epochDay, 0);
  const u32 = Buffer.alloc(4);
  u32.writeUInt32LE(epochDay, 0);
  const i64 = Buffer.alloc(8);
  i64.writeBigInt64LE(BigInt(epochDay), 0);
  const derive = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  return [
    { label: "daily_scores_roots+u16", pda: derive([Buffer.from("daily_scores_roots"), u16]) },
    { label: "daily_scores_merkle_roots+u16", pda: derive([Buffer.from("daily_scores_merkle_roots"), u16]) },
    { label: "daily_scores_merkle_roots+u32", pda: derive([Buffer.from("daily_scores_merkle_roots"), u32]) },
    { label: "daily_scores_merkle_roots+i64", pda: derive([Buffer.from("daily_scores_merkle_roots"), i64]) },
  ];
}

/** Solana Explorer URL for a transaction signature (cluster-aware). */
export function explorerTx(signature: string, network: SolanaNetwork): string {
  const suffix = network === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

/** Solana Explorer URL for an account/address (cluster-aware). */
export function explorerAddress(address: string, network: SolanaNetwork): string {
  const suffix = network === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/address/${address}${suffix}`;
}
