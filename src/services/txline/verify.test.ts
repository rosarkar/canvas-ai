import { describe, expect, it } from "vitest";
import { explorerAddress, explorerTx } from "./program.js";

// Config is env-gated; set throwaway values before importing the module under test.
process.env.DATABASE_URL ??= "postgres://verify-test";
process.env.TELEGRAM_BOT_TOKEN ??= "verify-test";
process.env.TELEGRAM_WEBHOOK_URL ??= "http://localhost";
process.env.TELEGRAM_WEBHOOK_SECRET ??= "verify-test";
process.env.SOLANA_NETWORK ??= "devnet";

const { demonstrateProof } = await import("./verify.js");

const DAY = [
  { fixtureId: "wc26-arg-mex", matchLabel: "Argentina vs Mexico", winner: "HOME", homeGoals: 2, awayGoals: 0 },
  { fixtureId: "wc26-fra-usa", matchLabel: "France vs USA", winner: "HOME", homeGoals: 1, awayGoals: 1 },
  { fixtureId: "wc26-bra-ger", matchLabel: "Brazil vs Germany", winner: "AWAY", homeGoals: 0, awayGoals: 2 },
  { fixtureId: "wc26-eng-ned", matchLabel: "England vs Netherlands", winner: "DRAW", homeGoals: 1, awayGoals: 1 },
];

describe("verify — provable-fairness demonstration", () => {
  it("produces a real, self-verifying inclusion proof for a fixture", () => {
    const a = demonstrateProof({ dayResults: DAY, fixtureId: "wc26-bra-ger", epochDay: 20652 });
    expect(a.tier).toBe("demonstration");
    expect(a.verified).toBe(true); // the proof genuinely recomputes to the root
    expect(a.steps.length).toBeGreaterThan(0);
    // The last hop's running hash equals the published root.
    expect(a.steps[a.steps.length - 1].resultHex).toBe(a.rootHex);
    expect(a.leafPreimage).toContain("wc26-bra-ger");
    expect(a.leafPreimage).toContain("AWAY");
  });

  it("is deterministic (same inputs → same root + proof)", () => {
    const a = demonstrateProof({ dayResults: DAY, fixtureId: "wc26-arg-mex", epochDay: 20652 });
    const b = demonstrateProof({ dayResults: DAY, fixtureId: "wc26-arg-mex", epochDay: 20652 });
    expect(a.rootHex).toBe(b.rootHex);
    expect(a.leafHex).toBe(b.leafHex);
  });

  it("a different result yields a different leaf (tamper-evident)", () => {
    const clean = demonstrateProof({ dayResults: DAY, fixtureId: "wc26-arg-mex", epochDay: 20652 });
    const tampered = demonstrateProof({
      dayResults: DAY.map((r) => (r.fixtureId === "wc26-arg-mex" ? { ...r, winner: "AWAY" } : r)),
      fixtureId: "wc26-arg-mex",
      epochDay: 20652,
    });
    expect(tampered.leafHex).not.toBe(clean.leafHex);
  });

  it("cites a daily-roots account with a cluster-aware explorer link", () => {
    const a = demonstrateProof({ dayResults: DAY, fixtureId: "wc26-fra-usa", epochDay: 20652 });
    expect(a.rootPda.length).toBeGreaterThan(30);
    expect(a.rootPdaExplorerUrl).toContain("explorer.solana.com/address/");
    expect(a.rootPdaExplorerUrl).toContain("cluster=devnet");
  });

  it("single-fixture day still yields a valid (empty-path) proof", () => {
    const a = demonstrateProof({ dayResults: [DAY[0]], fixtureId: DAY[0].fixtureId, epochDay: 20652 });
    expect(a.verified).toBe(true);
    expect(a.rootHex).toBe(a.leafHex); // root of a one-leaf tree is the leaf
  });
});

describe("explorer helpers", () => {
  it("devnet links carry the cluster query, mainnet links don't", () => {
    expect(explorerTx("abc", "devnet")).toBe("https://explorer.solana.com/tx/abc?cluster=devnet");
    expect(explorerTx("abc", "mainnet")).toBe("https://explorer.solana.com/tx/abc");
    expect(explorerAddress("Xyz", "devnet")).toContain("cluster=devnet");
    expect(explorerAddress("Xyz", "mainnet")).toBe("https://explorer.solana.com/address/Xyz");
  });
});
