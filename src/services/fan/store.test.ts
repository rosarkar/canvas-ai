import { beforeEach, describe, expect, it } from "vitest";
import {
  _reset,
  addPrediction,
  getOrCreatePlayer,
  getPlayer,
  isSettled,
  leaderboard,
  rankOf,
  settleMatch,
} from "./store.js";

const base = {
  matchId: "m1",
  matchLabel: "A v B",
  outcome: "HOME",
  selectionLabel: "A",
  decimalOdds: 2.0,
};

describe("fan store", () => {
  beforeEach(() => _reset());

  it("debits stake points on prediction", () => {
    const { player } = addPrediction({ player: "alice", ...base, stakePoints: 100 });
    expect(player.points).toBe(900); // 1000 start − 100
  });

  it("pays winners stake × odds and grows the streak", () => {
    addPrediction({ player: "alice", ...base, stakePoints: 100 });
    const sum = settleMatch("m1", "HOME", { verified: true, proofRef: "pda" });
    expect(sum.settled).toBe(1);
    expect(sum.winners).toBe(1);
    const p = getOrCreatePlayer("alice");
    expect(p.points).toBe(1100); // 900 + 100×2.0
    expect(p.wins).toBe(1);
    expect(p.streak).toBe(1);
  });

  it("burns the stake and resets streak on a wrong pick", () => {
    addPrediction({ player: "bob", ...base, stakePoints: 300 });
    settleMatch("m1", "AWAY", { verified: false, proofRef: "pda" });
    const p = getOrCreatePlayer("bob");
    expect(p.points).toBe(700); // 1000 − 300, no payout
    expect(p.losses).toBe(1);
    expect(p.streak).toBe(0);
  });

  it("caps a stake at the player's available points", () => {
    const { prediction } = addPrediction({ player: "carol", ...base, stakePoints: 99_999 });
    expect(prediction.stakePoints).toBe(1000);
  });

  it("ranks the leaderboard by points", () => {
    addPrediction({ player: "hi", ...base, stakePoints: 100 });
    settleMatch("m1", "HOME", { verified: true, proofRef: "pda" }); // hi → 1100
    addPrediction({ player: "lo", ...base, matchId: "m2", stakePoints: 400 });
    settleMatch("m2", "AWAY", { verified: true, proofRef: "pda" }); // lo → 600
    const board = leaderboard();
    expect(board[0].handle).toBe("hi");
    expect(board[board.length - 1].handle).toBe("lo");
  });

  it("getPlayer never mints — viewing a name doesn't pollute the leaderboard", () => {
    expect(getPlayer("ghost")).toBeNull();
    expect(leaderboard()).toHaveLength(0);
    // Only a real prediction puts you on the board.
    addPrediction({ player: "real", ...base, stakePoints: 100 });
    expect(leaderboard().map((p) => p.handle)).toEqual(["real"]);
  });

  it("settlement is idempotent — a result can never be re-drawn", () => {
    addPrediction({ player: "alice", ...base, stakePoints: 100 });
    const first = settleMatch("m1", "HOME", { verified: true, proofRef: "pda-A" });
    expect(getOrCreatePlayer("alice").points).toBe(1100);
    // A second settle with a DIFFERENT winner must be ignored (frozen result).
    const second = settleMatch("m1", "AWAY", { verified: true, proofRef: "pda-B" });
    expect(second.winningOutcome).toBe("HOME");
    expect(second).toEqual(first);
    expect(getOrCreatePlayer("alice").points).toBe(1100); // not re-applied
    expect(isSettled("m1")).toBe(true);
  });

  it("rankOf reflects standing and is null for non-players", () => {
    addPrediction({ player: "top", ...base, stakePoints: 100 });
    settleMatch("m1", "HOME", { verified: true, proofRef: "pda" }); // top → 1100
    addPrediction({ player: "mid", ...base, matchId: "m2", stakePoints: 100 });
    expect(rankOf("top")).toBe(1);
    expect(rankOf("mid")).toBe(2);
    expect(rankOf("nobody")).toBeNull();
  });
});
