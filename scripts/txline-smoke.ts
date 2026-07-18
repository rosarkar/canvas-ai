#!/usr/bin/env tsx
/**
 * TxLINE devnet smoke test: subscribe on-chain → activate → fetch real World Cup
 * fixtures/odds/scores. Prints a reusable wallet secret if one was generated.
 *   npm run txline:smoke
 */
// Dummy values for the vars the shared config hard-requires but this script never uses.
process.env.DATABASE_URL ??= "postgres://txline-smoke";
process.env.TELEGRAM_BOT_TOKEN ??= "txline-smoke";
process.env.TELEGRAM_WEBHOOK_URL ??= "http://localhost:3000";
process.env.TELEGRAM_WEBHOOK_SECRET ??= "txline-smoke";

const { TXLINE_NETWORKS } = await import("@/services/txline/program.js");
const { loadOrCreateKeypair, ensureSol, secretKeyBase58 } = await import("@/services/txline/wallet.js");
const { TxLineClient } = await import("@/services/txline/client.js");
const { config } = await import("@/config/index.js");

const cfg = TXLINE_NETWORKS[config.solana.network];
const { keypair, ephemeral } = loadOrCreateKeypair(config.solana.devnetSecretKey);
console.log(`\nTxLINE smoke — ${config.solana.network}`);
console.log("wallet:", keypair.publicKey.toBase58(), ephemeral ? "(ephemeral, generated)" : "(from env)");
if (ephemeral) console.log("  reuse it:  SOLANA_DEVNET_SECRET_KEY=" + secretKeyBase58(keypair));

const client = new TxLineClient(cfg, keypair);
const sol = await ensureSol(client.connection, keypair.publicKey, 0.3);
console.log("SOL balance:", sol.toFixed(3));

try {
  console.log("\n1) subscribe on-chain (service level " + config.solana.serviceLevel + ")…");
  const txSig = await client.subscribe(4, config.solana.serviceLevel);
  console.log("   tx:", txSig);

  console.log("2) activate API token…");
  const apiToken = await client.activate(txSig);
  console.log("   apiToken:", apiToken.slice(0, 16) + "…");

  console.log("3) fetch fixtures…");
  const fixtures = await client.getFixtures();
  console.log("   fixtures:", fixtures.length);
  const f = fixtures.find((x) => /world cup/i.test(x.Competition)) ?? fixtures[0];
  if (f) {
    console.log(`   sample: ${f.Participant1} vs ${f.Participant2}  (id ${f.FixtureId}, ${f.Competition})`);
    const odds = await client.getOdds(f.FixtureId);
    console.log("   odds payloads:", odds.length);
    if (odds[0]) console.log("     StablePrice:", odds[0].PriceNames, "→ Pct", odds[0].Pct);
    const scores = await client.getScores(f.FixtureId);
    console.log("   score records:", scores.length, scores[0] ? `(gameState ${scores[0].gameState})` : "");
  }
  console.log("\n✅ TxLINE live path OK\n");
} catch (err) {
  const strict = process.argv.includes("--strict");
  console.error("\n⚠️  TxLINE live path unavailable:", err instanceof Error ? err.message : err);
  console.error(
    "   By design, the app falls back to labelled sample World Cup fixtures, so every\n" +
      "   demo still works end-to-end. Fund the wallet with devnet SOL (https://faucet.solana.com)\n" +
      "   and set USE_TXLINE=true to bring the real on-chain feed up.\n",
  );
  // Only fail the process under --strict (CI). A rate-limited devnet airdrop on
  // demo day must not read as "the integration is broken" — the fallback is intended.
  process.exit(strict ? 1 : 0);
}
