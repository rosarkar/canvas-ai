/**
 * Sample World Cup 2026 fixtures + odds, standing in for the live TxODDS feed
 * until hackathon credentials land. Every quote is clearly labelled `source:
 * "fixture"` in the API so nothing here is passed off as live data.
 *
 * Each outcome carries two prices:
 *  - `txodds`:  the sharp TxODDS line we de-vig into a fair probability.
 *  - `market`:  the price actually available to bet on-chain (Polymarket / perp
 *               via Bankr). The gap between fair prob and this price is the edge.
 */

export interface FixtureOutcome {
  key: string;
  label: string;
  /** Sharp TxODDS decimal odds (source of the fair probability). */
  txodds: number;
  /** Tradeable decimal odds on the settlement venue. */
  market: number;
}

export interface FixtureMarket {
  key: string;
  label: string;
  outcomes: FixtureOutcome[];
}

export interface FixtureMatch {
  id: string;
  competition: string;
  stage: string;
  home: string;
  away: string;
  kickoff: string;
  status: "scheduled" | "live" | "finished";
  markets: FixtureMarket[];
}

/** 1X2 + Over/Under 2.5 goals for one match. */
function match(
  id: string,
  stage: string,
  home: string,
  away: string,
  kickoff: string,
  oneXtwo: [number, number, number, number, number, number], // txH,mkH, txD,mkD, txA,mkA
  overUnder: [number, number, number, number], // txO,mkO, txU,mkU
  status: "scheduled" | "live" | "finished" = "scheduled",
): FixtureMatch {
  const [txH, mkH, txD, mkD, txA, mkA] = oneXtwo;
  const [txO, mkO, txU, mkU] = overUnder;
  return {
    id,
    competition: "FIFA World Cup 2026",
    stage,
    home,
    away,
    kickoff,
    status,
    markets: [
      {
        key: "1X2",
        label: "Match Result",
        outcomes: [
          { key: "HOME", label: home, txodds: txH, market: mkH },
          { key: "DRAW", label: "Draw", txodds: txD, market: mkD },
          { key: "AWAY", label: away, txodds: txA, market: mkA },
        ],
      },
      {
        key: "OU_2_5",
        label: "Total Goals O/U 2.5",
        outcomes: [
          { key: "OVER_2_5", label: "Over 2.5", txodds: txO, market: mkO },
          { key: "UNDER_2_5", label: "Under 2.5", txodds: txU, market: mkU },
        ],
      },
    ],
  };
}

export const FIXTURE_MATCHES: FixtureMatch[] = [
  // Some outcomes are priced softer than the sharp line (positive edge), others not.
  match("wc26-arg-mex", "Group C", "Argentina", "Mexico", "2026-07-18T19:00:00Z",
    [1.65, 1.85, 3.8, 3.75, 5.5, 5.4], // Argentina softly priced → value
    [1.95, 2.05, 1.9, 1.85], "live"),
  match("wc26-fra-usa", "Group D", "France", "USA", "2026-07-18T23:00:00Z",
    [1.5, 1.55, 4.2, 4.1, 6.5, 7.2], // USA overpriced longshot → small value
    [1.8, 1.82, 2.05, 2.0]),
  match("wc26-bra-ger", "Round of 16", "Brazil", "Germany", "2026-07-19T19:00:00Z",
    [2.3, 2.45, 3.4, 3.35, 3.1, 3.05], // Brazil value
    [1.75, 1.9, 2.1, 2.0]),
  match("wc26-eng-ned", "Round of 16", "England", "Netherlands", "2026-07-19T23:00:00Z",
    [2.5, 2.5, 3.2, 3.2, 2.9, 2.85],
    [2.0, 2.0, 1.85, 1.85]),
  match("wc26-esp-por", "Quarter-final", "Spain", "Portugal", "2026-07-20T19:00:00Z",
    [2.15, 2.3, 3.3, 3.25, 3.5, 3.4], // Spain value
    [1.85, 1.95, 2.0, 1.9]),
  match("wc26-arg-bra", "Quarter-final", "Argentina", "Brazil", "2026-07-21T23:00:00Z",
    [2.6, 2.75, 3.25, 3.2, 2.75, 2.7], // Argentina value in the clásico
    [1.9, 2.0, 1.95, 1.85]),
  match("wc26-fra-eng", "Semi-final", "France", "England", "2026-07-22T23:00:00Z",
    [2.2, 2.25, 3.3, 3.25, 3.4, 3.35],
    [1.95, 1.98, 1.9, 1.87]),
  match("wc26-final", "Final", "Argentina", "France", "2026-07-26T19:00:00Z",
    [2.7, 2.95, 3.2, 3.15, 2.65, 2.6], // Argentina softly priced in the final → value
    [2.05, 2.15, 1.8, 1.75]),
];
