# Canvas Edge — Autonomous Sports-Trading Agent

**Superteam "World Cup" Hackathon · Track: Trading Tools & Agents · TxODDS × Solana**

An autonomous, **risk-managed** trading agent that follows the sponsor's own blueprint:
**TxLINE (Solana, on-chain-verified World Cup data) → agent logic → Bankr executes on
Polymarket (cross-chain).** It streams live odds and scores, sizes every position with the
**Kelly criterion** under hard risk limits, and — the headline play — reacts *the instant a
goal is verified on-chain*.

> Most trading bots blow up because they over-bet. Canvas Edge is built the other way round:
> it will find an edge, size it with fractional Kelly, and **halt itself** on a ruin-stop or a
> daily loss cap before it ever busts.

## What it does

- **Value-edge strategy** — compares TxLINE StablePrice (de-margined fair prob) to the market
  price, and bets outcomes with real positive EV. Sizes with `assessSelection` (Kelly + ruin +
  Sharpe from our Markets risk engine).
- **Goal-trigger strategy** — consumes the TxLINE scores SSE stream; on a goal it verifies the
  event **on-chain** (`validate_stat` / `daily_scores_roots` PDA) and trades the transient
  dislocation before the market reprices.
- **Risk management** — half-Kelly default, per-trade max stake, **daily loss cap**, and a
  **ruin-stop** that halts all trading below a bankroll floor. Every limit is live-tunable.
- **Execution via Bankr** — composes the exact `smart_cross_chain_swap` → `buy_polymarket_shares`
  order. Simulated by default; `EXECUTION_MODE=live` + a Bankr key places real orders.
- **Live dashboard** — decisions feed, positions/P&L, realized-equity curve, on-chain proof
  badges, risk gauges, and a kill switch.

## Run it

```bash
npm install
npm run agent          # → http://localhost:4300/agent/
```

Open the dashboard, hit **Start agent**, and watch it evaluate edges, size stakes, and settle.
Drag the risk sliders down and it stops taking bets; push the daily-loss cap and it halts.
**Inject goal** exercises the on-chain-verified goal-trigger. Headless runner: `npm run agent:run`.

## Real Solana data

The agent consumes the shared TxLINE foundation (`src/services/txline/`): an on-chain
`subscribe` + activate flow, StablePrice odds, SSE score streams, and Merkle-proof verification.
With `USE_TXLINE=true` and a funded devnet wallet (`npm run txline:smoke` to bring it up) it
trades on **real on-chain-verified TxLINE data**; otherwise it runs on clearly-labelled sample
World Cup fixtures so the demo always works. See the repo's TxLINE notes for the full flow.

## Architecture

```
resolveOddsFeed() ── TxLineFeed (Solana) | FixtureFeed (labelled)
        │
        ▼
strategy.ts  value-edge + goal-trigger  ──►  risk engine (Kelly / ruin / Sharpe)
        │                                     + risk limits (loss cap, ruin stop)
        ▼
executor.ts  compose Bankr order  ──►  simulated | live (smart_cross_chain_swap → buy_polymarket_shares)
        │
        ▼
loop.ts  autonomous turns + in-memory book  ──►  /api/agent/*  ──►  public/agent dashboard
```

## Files

```
src/services/agent/strategy.ts   value-edge + goal-trigger, risk gating
src/services/agent/executor.ts   Bankr order composition (sim/live)
src/services/agent/loop.ts       autonomous loop + state + settlement
src/api/agent.ts                 /api/agent/* control + telemetry
src/agent-server.ts              standalone server (npm run agent)
scripts/agent-run.ts             headless loop (npm run agent:run)
public/agent/index.html          live dashboard
src/services/txline/*            shared real TxLINE (Solana) foundation
src/services/risk/*              reused Kelly / Monte-Carlo / hedge engine
```

## Honesty

- **On-chain goal proof is real, not asserted.** A goal produces a self-describing `ProofArtifact`
  (`src/services/txline/verify.ts` + `merkle.ts`) that tiers itself: `verified-onchain` (the day's
  score root is read from Solana *and* a Merkle proof recomputes to it), `root-anchored` (live
  account read, recompute not finalized), or `demonstration` (a **real** Merkle inclusion proof
  over sample data — the exact mechanism, clearly labelled, never called on-chain-verified). The
  decision row links straight to the account on Solana Explorer.
- **Settlement can't flatter the strategy.** Simulated positions settle against the *true* pre-goal
  probability (`settleProb`), never the goal-inflated trade prob — so the goal strategy can't look
  fictitiously profitable. Live orders are **never** PRNG-settled; they resolve from the real Bankr
  job / Polymarket market. A failed live order opens no position and debits no bankroll.
- The goal edge is a documented in-play model (a verified goal closes ~25% of the scoring side's gap
  to certainty), not a hard-coded constant. Duplicate goal triggers on a held position are skipped.
- The risk math **and** the agent's own strategy/executor logic are unit-tested. Solana execution is
  via Bankr (cross-chain → Polymarket, USDC on Polygon) per the sponsor's architecture. Sample
  fixtures are clearly labelled; nothing is presented as real returns. Not financial advice.
