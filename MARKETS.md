# Canvas Markets — World Cup Risk Desk

**Superteam "World Cup" Hackathon · Track: Prediction Markets & Settlement · TxODDS × Solana**

A risk-managed prediction-market copilot for the World Cup. TxODDS gives the sharp
fair price; our engine sizes the bet with the **Kelly criterion**, stress-tests your
bankroll with a **Monte-Carlo ruin simulation**, and proposes a **hedge** so you take
*two trades instead of one* — then settles the position on-chain through **Bankr's**
natural-language agent. The risk + visualization layer on top of Bankr is the product.

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
TxODDS live odds ──▶ de-vig ──▶ fair probability p
                                    │
        tradeable on-chain price ───┤──▶ edge = p·o − 1
                                    ▼
   Kelly stake · Sharpe · Monte-Carlo P(ruin) · lock-in hedge   (pure, unit-tested)
                                    ▼
        risk copilot narrates the exact numbers (never invents them)
                                    ▼
      Bankr Agent API  "Bet $39 on Argentina …" (+ hedge order)  ──▶ on-chain
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

- **Default = `simulated`**: the exact order text is shown, no funds move.
- **Live**: set `MARKETS_LIVE_SETTLEMENT=true` with a `BANKR_API_KEY` and each leg is
  submitted to Bankr for on-chain execution. Bankr provisions wallets across 9 chains
  (incl. Base and Solana), so settlement is chain-flexible.

## Going live on real TxODDS data

`src/services/txodds.client.ts` defines one `OddsFeed` interface with two
implementations. Today it serves **clearly-labelled sample World Cup fixtures**; the
moment hackathon credentials land, set `TXODDS_API_KEY` and map the real response in
`LiveFeed` — a single, reviewable change. Nothing else in the app changes.

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

- **Real:** all risk math, the Bankr settlement integration, the whole desk + charts.
- **Sample:** odds are placeholder World Cup fixtures until the live TxODDS key is wired
  (clearly badged "Sample fixtures" in the UI).
- **Framing:** settlement executes via Bankr (Solana through Bankr's wallet), not a
  bespoke Solana program — an honest, deliberate scoping choice for the hackathon window.

## Suggested 90-second demo

1. Open `/markets/#demo` → the desk lands on the best available edge (Argentina, +6.7%).
2. Read the stat cards + the copilot's one-line rationale.
3. Point at the **ruin gauge** (≈0% at half-Kelly) — then drag the slider to `3×` and
   watch it jump to ~37%. "Same edge. This is why we default to half-Kelly."
4. Scroll to the **hedge** — two extra trades flatten every outcome into a locked result.
5. Hit **Settle via Bankr** → the exact on-chain orders appear (simulated by default).

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
