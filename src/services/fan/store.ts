/**
 * Canvas Cup — in-memory prediction game store (free-to-play points).
 *
 * Fans predict World Cup outcomes with points; settlement is provably fair —
 * the result is checked against TxLINE's on-chain Merkle root. Winners' points
 * map to a claimable USDC reward (paid via the existing escrow rail / Bankr when
 * configured). Kept in-memory so the demo runs with no database.
 */
export type PredictionStatus = "open" | "won" | "lost" | "void";

export interface Prediction {
  id: string;
  player: string;
  matchId: string;
  matchLabel: string;
  outcome: string;
  selectionLabel: string;
  decimalOdds: number;
  stakePoints: number;
  createdAt: number;
  status: PredictionStatus;
  payoutPoints: number;
  rewardUsdMicro: number;
  verified?: boolean;
  proofRef?: string;
}

export interface Player {
  handle: string;
  points: number;
  wins: number;
  losses: number;
  streak: number;
  bestStreak: number;
  predictions: number;
}

export const STARTING_POINTS = 1000;
/** Points → USDC reward rate for winners (e.g. 1000 pts profit = $1 reward). */
const USD_MICRO_PER_POINT = 1_000; // 0.001 USDC per point

const predictions = new Map<string, Prediction>();
const players = new Map<string, Player>();
/** Settled matches, memoised so a result can never be re-drawn (provably-fair). */
const settledResults = new Map<string, SettleSummary>();
let counter = 0;

export function getOrCreatePlayer(handle: string): Player {
  const key = handle.trim().toLowerCase();
  let p = players.get(key);
  if (!p) {
    p = { handle, points: STARTING_POINTS, wins: 0, losses: 0, streak: 0, bestStreak: 0, predictions: 0 };
    players.set(key, p);
  }
  return p;
}

/** Read a player WITHOUT creating one — so merely viewing a name never mints a leaderboard entry. */
export function getPlayer(handle: string): Player | null {
  return players.get(handle.trim().toLowerCase()) ?? null;
}

/** A synthetic, un-persisted starting card for a name that hasn't played yet. */
export function startingCard(handle: string): Player {
  return { handle, points: STARTING_POINTS, wins: 0, losses: 0, streak: 0, bestStreak: 0, predictions: 0 };
}

export interface AddPredictionInput {
  player: string;
  matchId: string;
  matchLabel: string;
  outcome: string;
  selectionLabel: string;
  decimalOdds: number;
  stakePoints: number;
}

export function addPrediction(input: AddPredictionInput): { prediction: Prediction; player: Player } {
  const player = getOrCreatePlayer(input.player);
  const stake = Math.max(1, Math.min(Math.floor(input.stakePoints), player.points));
  player.points -= stake;
  player.predictions += 1;
  const prediction: Prediction = {
    id: `pred-${Date.now().toString(36)}-${(counter++).toString(36)}`,
    player: player.handle,
    matchId: input.matchId,
    matchLabel: input.matchLabel,
    outcome: input.outcome,
    selectionLabel: input.selectionLabel,
    decimalOdds: input.decimalOdds,
    stakePoints: stake,
    createdAt: Date.now(),
    status: "open",
    payoutPoints: 0,
    rewardUsdMicro: 0,
  };
  predictions.set(prediction.id, prediction);
  return { prediction, player };
}

export function listPredictions(player?: string): Prediction[] {
  const all = [...predictions.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (!player) return all;
  const key = player.trim().toLowerCase();
  return all.filter((p) => p.player.trim().toLowerCase() === key);
}

/** Only players who have actually staked a prediction rank — no idle 1000-pt names. */
function rankedPlayers(): Player[] {
  return [...players.values()]
    .filter((p) => p.predictions > 0)
    .sort((a, b) => b.points - a.points || b.bestStreak - a.bestStreak);
}

export function leaderboard(limit = 20): Player[] {
  return rankedPlayers().slice(0, limit);
}

/** 1-based rank of a player among all who have predicted, or null if they haven't. */
export function rankOf(handle: string): number | null {
  const key = handle.trim().toLowerCase();
  const idx = rankedPlayers().findIndex((p) => p.handle.trim().toLowerCase() === key);
  return idx >= 0 ? idx + 1 : null;
}

export interface SettleSummary {
  matchId: string;
  winningOutcome: string;
  settled: number;
  winners: number;
  proofRef: string;
  verified: boolean;
  totalRewardUsdMicro: number;
}

/** Whether a match has already been settled (its result is now immutable). */
export function isSettled(matchId: string): boolean {
  return settledResults.has(matchId);
}

export function getSettlement(matchId: string): SettleSummary | undefined {
  return settledResults.get(matchId);
}

/**
 * Settle all open predictions on a match against the (on-chain-verified) result.
 * Idempotent: once a match is settled its winning outcome is frozen — calling
 * again returns the SAME result (a result can never be re-drawn or "fudged").
 */
export function settleMatch(
  matchId: string,
  winningOutcome: string,
  proof: { verified: boolean; proofRef: string },
): SettleSummary {
  const existing = settledResults.get(matchId);
  if (existing) return existing;
  let settled = 0;
  let winners = 0;
  let totalReward = 0;
  for (const pred of predictions.values()) {
    if (pred.matchId !== matchId || pred.status !== "open") continue;
    const player = getOrCreatePlayer(pred.player);
    pred.verified = proof.verified;
    pred.proofRef = proof.proofRef;
    settled += 1;
    if (pred.outcome === winningOutcome) {
      const payout = Math.round(pred.stakePoints * pred.decimalOdds);
      const profit = payout - pred.stakePoints;
      pred.status = "won";
      pred.payoutPoints = payout;
      pred.rewardUsdMicro = Math.max(0, profit) * USD_MICRO_PER_POINT;
      player.points += payout;
      player.wins += 1;
      player.streak += 1;
      player.bestStreak = Math.max(player.bestStreak, player.streak);
      winners += 1;
      totalReward += pred.rewardUsdMicro;
    } else {
      pred.status = "lost";
      player.losses += 1;
      player.streak = 0;
    }
  }
  const summary: SettleSummary = {
    matchId,
    winningOutcome,
    settled,
    winners,
    proofRef: proof.proofRef,
    verified: proof.verified,
    totalRewardUsdMicro: totalReward,
  };
  settledResults.set(matchId, summary);
  return summary;
}

export function stats(): { players: number; predictions: number; open: number } {
  const open = [...predictions.values()].filter((p) => p.status === "open").length;
  return { players: players.size, predictions: predictions.size, open };
}

/** Test/demo helper. */
export function _reset(): void {
  predictions.clear();
  players.clear();
  settledResults.clear();
  counter = 0;
}
