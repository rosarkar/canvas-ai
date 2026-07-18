/**
 * TxLineClient — the on-chain subscribe + activate + data-fetch flow.
 *
 * 1. subscribe():  on-chain Anchor `subscribe(serviceLevel, weeks)` on the txoracle program.
 * 2. activate():   guest JWT → sign `${txSig}:${leagues}:${jwt}` → POST /api/token/activate → apiToken.
 * 3. REST/SSE:     fetch fixtures/odds/scores with Authorization + X-Api-Token headers.
 *
 * StablePrice (OddsPayload.Pct[]) is TxLINE's de-margined percentage set — i.e. the
 * fair probabilities, no de-vig needed on our side.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import nacl from "tweetnacl";
import { logger } from "@/utils/logger.js";
import {
  makeProgram,
  pricingMatrixPda,
  tokenTreasuryPda,
  type TxLineNetworkConfig,
  type TxLineProgramHandle,
} from "./program.js";
import { anchorWallet } from "./wallet.js";

export interface TxLineFixture {
  Ts: number;
  StartTime: number;
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
}

export interface TxLineOddsPayload {
  FixtureId: number;
  MessageId: string;
  Ts: number;
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string;
  GameState?: string;
  InRunning: boolean;
  PriceNames: string[];
  Prices: number[];
  /** StablePrice — de-margined percentages summing to ~1 (our fair probabilities). */
  Pct: number[];
}

export interface TxLineScore {
  fixtureId: number;
  gameState: string;
  startTime: number;
  action: string;
  id: number;
  ts: number;
  seq: number;
  [k: string]: unknown;
}

export class TxLineClient {
  private handle: TxLineProgramHandle;
  private jwt: string | null = null;
  private apiToken: string | null = null;
  /** The most recent on-chain `subscribe` tx signature (for explorer receipts). */
  public lastSubscribeSig: string | null = null;

  constructor(
    public readonly cfg: TxLineNetworkConfig,
    private readonly keypair: Keypair,
  ) {
    this.handle = makeProgram(cfg, anchorWallet(keypair));
  }

  get connection() {
    return this.handle.connection;
  }

  get walletPubkey(): PublicKey {
    return this.keypair.publicKey;
  }

  isActivated(): boolean {
    return Boolean(this.jwt && this.apiToken);
  }

  /** On-chain free-tier subscription. Returns the transaction signature. */
  async subscribe(weeks = 4, serviceLevel = this.cfg.freeServiceLevel): Promise<string> {
    const { program } = this.handle;
    const programId = this.cfg.programId;
    const user = this.keypair.publicKey;

    const userTokenAccount = getAssociatedTokenAddressSync(
      this.cfg.txlTokenMint,
      user,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const treasuryPda = tokenTreasuryPda(programId);
    const tokenTreasuryVault = getAssociatedTokenAddressSync(
      this.cfg.txlTokenMint,
      treasuryPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    // Free tier costs no TXL, but the subscribe ix reads the user's TXL ATA — create it if absent.
    const createUserAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      user,
      userTokenAccount,
      user,
      this.cfg.txlTokenMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const txSig = await program.methods
      .subscribe(serviceLevel, weeks)
      .accounts({
        user,
        pricingMatrix: pricingMatrixPda(programId),
        tokenMint: this.cfg.txlTokenMint,
        userTokenAccount,
        tokenTreasuryVault,
        tokenTreasuryPda: treasuryPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([createUserAtaIx])
      .rpc();

    this.lastSubscribeSig = txSig;
    logger.info({ txSig, network: this.cfg.network }, "TxLINE subscribe confirmed");
    return txSig;
  }

  /** Activate an API token by signing the subscription proof. */
  async activate(txSig: string, leagues: number[] = []): Promise<string> {
    const startRes = await fetch(`${this.cfg.apiOrigin}/auth/guest/start`, { method: "POST" });
    if (!startRes.ok) throw new Error(`guest/start ${startRes.status}`);
    const jwt = ((await startRes.json()) as { token: string }).token;

    const messageString = `${txSig}:${leagues.join(",")}:${jwt}`;
    const signature = nacl.sign.detached(new TextEncoder().encode(messageString), this.keypair.secretKey);
    const walletSignature = Buffer.from(signature).toString("base64");

    const actRes = await fetch(`${this.cfg.apiOrigin}/api/token/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ txSig, walletSignature, leagues }),
    });
    if (!actRes.ok) throw new Error(`token/activate ${actRes.status}: ${await actRes.text()}`);
    const body = (await actRes.json()) as { token?: string } | string;
    const apiToken = typeof body === "string" ? body : (body.token ?? "");
    if (!apiToken) throw new Error("activation returned no token");

    this.jwt = jwt;
    this.apiToken = apiToken;
    logger.info({ network: this.cfg.network }, "TxLINE API token activated");
    return apiToken;
  }

  /** Subscribe (if needed) then activate — full bring-up. */
  async connect(weeks = 4): Promise<void> {
    const txSig = await this.subscribe(weeks);
    await this.activate(txSig);
  }

  private authHeaders(): Record<string, string> {
    if (!this.jwt || !this.apiToken) throw new Error("TxLineClient not activated");
    return { Authorization: `Bearer ${this.jwt}`, "X-Api-Token": this.apiToken, Accept: "application/json" };
  }

  private async get<T>(pathAndQuery: string): Promise<T> {
    const res = await fetch(`${this.cfg.apiOrigin}/api${pathAndQuery}`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`TxLINE GET ${pathAndQuery} → ${res.status}`);
    return (await res.json()) as T;
  }

  getFixtures(params?: { startEpochDay?: number; competitionId?: number }): Promise<TxLineFixture[]> {
    const q = new URLSearchParams();
    if (params?.startEpochDay !== undefined) q.set("startEpochDay", String(params.startEpochDay));
    if (params?.competitionId !== undefined) q.set("competitionId", String(params.competitionId));
    const qs = q.toString();
    return this.get<TxLineFixture[]>(`/fixtures/snapshot${qs ? `?${qs}` : ""}`);
  }

  getOdds(fixtureId: number, asOf?: number): Promise<TxLineOddsPayload[]> {
    return this.get<TxLineOddsPayload[]>(`/odds/snapshot/${fixtureId}${asOf ? `?asOf=${asOf}` : ""}`);
  }

  getScores(fixtureId: number, asOf?: number): Promise<TxLineScore[]> {
    return this.get<TxLineScore[]>(`/scores/snapshot/${fixtureId}${asOf ? `?asOf=${asOf}` : ""}`);
  }

  /** Fetch a Merkle validation proof for a score stat (for on-chain verification). */
  getScoreValidation(fixtureId: number, seq: number, statKeys: number[] = [1]): Promise<unknown> {
    const q = new URLSearchParams({
      fixtureId: String(fixtureId),
      seq: String(seq),
      statKeys: statKeys.join(","),
    });
    return this.get(`/scores/stat-validation?${q.toString()}`);
  }

  /** The underlying Anchor program (for `.view()` on-chain proof verification). */
  get program() {
    return this.handle.program;
  }

  /** Fetch-based SSE stream (the docs specify fetch, not EventSource). Yields parsed data payloads. */
  async *stream<T>(path: "scores" | "odds", fixtureId?: number, signal?: AbortSignal): AsyncGenerator<T> {
    const url = `${this.cfg.apiOrigin}/api/${path}/stream${fixtureId ? `?fixtureId=${fixtureId}` : ""}`;
    const res = await fetch(url, {
      headers: { ...this.authHeaders(), Accept: "text/event-stream", "Cache-Control": "no-cache" },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`TxLINE stream ${path} → ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;
        try {
          yield JSON.parse(dataLines.join("\n")) as T;
        } catch {
          /* heartbeat / non-JSON frame — ignore */
        }
      }
    }
  }

  streamScores(fixtureId?: number, signal?: AbortSignal): AsyncGenerator<TxLineScore> {
    return this.stream<TxLineScore>("scores", fixtureId, signal);
  }

  streamOdds(fixtureId?: number, signal?: AbortSignal): AsyncGenerator<TxLineOddsPayload> {
    return this.stream<TxLineOddsPayload>("odds", fixtureId, signal);
  }
}
