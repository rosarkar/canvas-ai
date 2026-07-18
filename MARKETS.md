# Canvas Markets — World Cup Risk Desk

**Superteam "World Cup" Hackathon · Track: Prediction Markets & Settlement · TxODDS × Solana**

A risk-managed prediction-market copilot for the World Cup. The desk runs on the
shared **on-chain TxLINE (Solana)** foundation: TxLINE StablePrice gives the sharp,
already-de-margined fair price, anchored to a `daily_scores_merkle_roots` account on
Solana. Our engine de-vigs, sizes the bet with the **Kelly criterion**, stress-tests
your bankroll with a **Monte-Carlo ruin simulation**, and proposes a **hedge** so you
take *two trades instead of one* — then settles the position cross-chain through
**Bankr's** natural-language agent. The risk + visualization layer on top of Bankr is
the product.

**The precise settlement route:** `TxLINE StablePrice (Solana) → de-vig → Kelly-sized
→ Bankr executes cross-chain → Polymarket (USDC on Polygon)`. The Solana leg is TxLINE
data + on-chain verification; **Bankr is the cross-chain execution rail** — its
Polymarket path settles USDC on **Polygon**, not Solana-native. We say this precisely
so no one mistakes it for a Solana-native bet.

> Most betting UIs help you lose faster. Canvas Markets is built to keep you in the
> game: it will happily tell you an edge is real *and* that betting it at full Kelly
> gives you a 37% chance of busting first.

---

## Why it's different

Bankr already lets an agent "search prediction markets, check odds, place bets on
outcomes." That's the *settlement rail*. The hard part — and where players actually
blow up — is **sizing and risk**. Canvas Markets adds the missing layer:

- **Sharp pricing** — de-vig the TxODDS line (multiplicative + Shin) into a fair
  probability, and measure the **edge** against the tradeable on-chain price.
- **Right-sized stakes** — **Kelly** (with a fractional default and a hard cap),
  plus per-bet **Sharpe** as an edge-quality score.
- **Probability of ruin** — a **Monte-Carlo** bankroll simulation over a betting
  horizon: percentile fan, ruin gauge, terminal-outcome histogram, and a
  strategy table showing ruin/growth from flat staking up through over-Kelly.
- **The second trade** — a **lock-in hedge** that flattens payoff across every
  outcome (arb when the book allows it), plus a two-asset **min-variance** combiner
  for correlated markets.
- **On-chain settlement** — one tap composes the primary + hedge as Bankr orders.

## How it works

```
TxLINE StablePrice (Solana) ─▶ de-vig ─▶ fair probability p
   (anchored: daily_scores_merkle_roots)   │
        tradeable on-chain price ───────────┤──▶ edge = p·o − 1
                                            ▼
   Kelly stake · Sharpe · Monte-Carlo P(ruin) · lock-in hedge   (pure, unit-tested)
                                            ▼
        risk copilot narrates the exact numbers (never invents them)
                                            ▼
   Bankr Agent API  "Bet $39 on Argentina …" (+ hedge)  ──▶ Polymarket · USDC on Polygon
```

## Run it in 60 seconds

The risk desk needs **no database and no Telegram bot** — just odds, math, and (optionally)
a Bankr key. A standalone server boots it:

```bash
npm install
npm run markets          # → http://localhost:4000/markets/
```

Open **http://localhost:4000/markets/** and pick a side, or jump straight to a
populated desk at **/markets/#demo**. Drag the Kelly slider past `1×` to watch the
probability of ruin climb.

Run the math test-suite:

```bash
npm test                 # 27 risk-engine tests (Kelly, de-vig, Monte-Carlo, hedge) + existing suite
```

## The math (all exact, all tested — `src/services/risk/`)

| Module | What it computes |
|---|---|
| `devig.ts` | Fair probabilities from marginated odds — multiplicative + **Shin** (favourite–longshot correction) |
| `kelly.ts` | Binary Kelly `f* = (p·o−1)/(o−1)`, fractional Kelly, capped stake |
| `metrics.ts` | Edge `p·o−1`, per-bet **Sharpe** `= edge / (o·√(p(1−p)))` |
| `montecarlo.ts` | Seeded bankroll simulation → **P(ruin)**, percentile fan, drawdown, histogram, strategy comparison |
| `hedge.ts` | **Lock-in hedge** (equalise payoff across outcomes) + two-asset min-variance combiner |

The LLM copilot only **parses intent** and **narrates** these figures. It never
produces a number — every stat on screen comes from the tested engine.

## Settlement via Bankr

`src/services/markets-settle.ts` composes the natural-language order(s) and hands
them to Bankr's async Agent API (`src/services/bankr.client.ts`, already in the repo).

- **Default = `simulated`**: the exact order text is shown, no funds move, no bet is
  placed. The response also carries the precise cross-chain `route` and a Solana
  `anchor` — the `daily_scores_merkle_roots` account the position priced against,
  honestly labelled as the **data anchor** (not a receipt that a bet executed).
- **Live**: set `MARKETS_LIVE_SETTLEMENT=true` with a `BANKR_API_KEY` and each leg is
  submitted to Bankr for cross-chain execution. Via Bankr's Polymarket integration the
  bet settles in **USDC on Polygon** — the Solana leg remains the TxLINE data +
  verification, not the settlement chain.

## Going live on real TxODDS / TxLINE data

The odds source is chosen by `resolveOddsFeed()` (`src/services/odds-feed.ts`), which
every surface — markets, agent, and the fan app — shares:

- **On-chain (real):** with `USE_TXLINE=true` and a funded devnet wallet, `TxLineFeed`
  (`src/services/txline/feed.ts`) runs the real on-chain flow — `subscribe` +
  `activate` on Solana, then reads **StablePrice** (already de-margined → `fairProb`)
  and tradeable `Prices[]` over the TxLINE REST/SSE API. Settled scores are verifiable
  against the `daily_scores_merkle_roots` Merkle root on Solana
  (`src/services/txline/verify.ts`).
- **Sample fallback:** if `USE_TXLINE` is off, or the subscription can't be established
  (e.g. no devnet SOL), it falls back to **clearly-labelled sample World Cup fixtures**
  in TxLINE StablePrice format. The UI badges the source honestly and never calls
  sample data on-chain-verified.

`GET /api/markets` returns a `provenance` object (`network`, `source`, `rootPda`,
`rootExplorerUrl`) so the desk can surface — and link to — the exact
`daily_scores_merkle_roots` account the prices anchor to on Solana Explorer.

## API

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/api/markets` | World Cup matches with de-vigged odds + edges |
| `GET`  | `/api/markets/match/:id` | One match |
| `POST` | `/api/markets/risk` | Kelly stake + Sharpe + Monte-Carlo ruin for a selection |
| `POST` | `/api/markets/hedge` | Lock-in hedge (the second trade) for a position |
| `POST` | `/api/markets/intent` | Parse a free-text bet request (Kimi, else heuristic) |
| `POST` | `/api/markets/settle` | Compose / execute the Bankr order(s) |

## What's real vs. sample (honesty)

- **Real:** all risk math, the Bankr settlement integration, the whole desk + charts,
  and the **on-chain TxLINE (Solana) foundation** — real `subscribe`/`activate`,
  StablePrice ingestion, and Merkle-root score verification against Solana
  (`src/services/txline/*`). The `provenance` chip links to the live
  `daily_scores_merkle_roots` account on Solana Explorer.
- **Sample (until wired):** odds are **labelled sample World Cup fixtures in TxLINE
  StablePrice format** until `USE_TXLINE=true` **and** a funded devnet wallet are set;
  the desk then reads live StablePrice. Sample data is badged "sample fixtures" in the
  UI and is **never** labelled on-chain-verified.
- **Settlement framing (precise):** the Solana leg is **TxLINE data + on-chain
  verification**. Execution is **cross-chain via Bankr** — Bankr's Polymarket path
  settles **USDC on Polygon**, not Solana-native. Default mode is **simulated**: the
  exact orders are composed and shown, but **no bet executes and no funds move**. We do
  not claim any live Bankr or on-chain execution occurred.

## Suggested 90-second demo

1. Open `/markets/#demo` → the desk lands on the best available edge (Argentina, +6.7%).
2. Read the stat cards + the copilot's one-line rationale.
3. Point at the **ruin gauge** (≈0% at half-Kelly) — then drag the slider to `3×` and
   watch it jump to ~37%. "Same edge. This is why we default to half-Kelly."
4. Scroll to the **hedge** — two extra trades flatten every outcome into a locked result.
5. Hit **Settle via Bankr** → the exact orders appear (simulated by default), with the
   precise cross-chain **route** and a clickable **Solana data anchor** (the day-root
   account on Explorer) — honestly labelled, no bet actually placed.

## Files

```
src/services/risk/            # the pure, tested risk engine (+ risk.test.ts)
src/services/txodds.client.ts # swappable OddsFeed (fixtures → live)
src/services/txodds.fixtures.ts
src/services/markets-agent.ts # intent parse + number-faithful narration
src/services/markets-settle.ts# Bankr order composition (sim/live)
src/api/markets.ts            # /api/markets router
src/markets-server.ts         # standalone demo server (npm run markets)
public/markets/index.html     # the World Cup Risk Desk (self-contained)
```
