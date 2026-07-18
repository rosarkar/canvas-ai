/**
 * Markets agent — the conversational risk copilot.
 *
 * Two jobs, both kept honest by construction:
 *  1. parseBetIntent: turn free text ("bet on Argentina, I've got $500") into a
 *     structured selection. Uses Kimi when a key is present, else a deterministic
 *     heuristic — so the desk works with zero API spend.
 *  2. explainAssessment: narrate the risk numbers the engine already computed.
 *     Purely templated from the exact figures — the LLM never invents numbers.
 */
import { callKimi, type KimiMessage } from "@/services/scoring.js";
import { config } from "@/config/index.js";
import { logger } from "@/utils/logger.js";
import type { MatchOdds } from "@/services/txodds.client.js";
import type { SelectionAssessment } from "@/services/risk/index.js";

export interface ParsedIntent {
  matchId: string | null;
  outcome: string | null;
  bankroll: number | null;
  kellyFraction: number;
  reply: string;
  source: "llm" | "heuristic";
}

const OUTCOME_HINTS: { re: RegExp; outcome: string }[] = [
  { re: /\bdraw\b|\btie\b/i, outcome: "DRAW" },
  { re: /\bover\b/i, outcome: "OVER_2_5" },
  { re: /\bunder\b/i, outcome: "UNDER_2_5" },
];

function parseKellyFraction(text: string): number {
  if (/\bfull kelly\b|\baggressive\b/i.test(text)) return 1;
  if (/\bquarter kelly\b|\bconservative\b|\bcautious\b/i.test(text)) return 0.25;
  return 0.5; // half-Kelly default
}

function parseBankroll(text: string): number | null {
  // First $-amount, or a bare number near "bankroll/have/roll/stake".
  const dollar = text.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  const near = text.match(/(?:bankroll|have|roll|budget|balance)\D{0,12}([\d,]+(?:\.\d+)?)/i);
  const raw = dollar?.[1] ?? near?.[1];
  if (!raw) return null;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Deterministic fallback parser — no LLM required. */
export function heuristicIntent(text: string, matches: MatchOdds[]): ParsedIntent {
  const lower = text.toLowerCase();
  const bankroll = parseBankroll(text);
  const kellyFraction = parseKellyFraction(text);

  let matchId: string | null = null;
  let outcome: string | null = null;

  for (const m of matches) {
    const home = m.home.toLowerCase();
    const away = m.away.toLowerCase();
    if (lower.includes(home) || lower.includes(away)) {
      matchId = m.id;
      const hint = OUTCOME_HINTS.find((h) => h.re.test(text));
      if (hint) outcome = hint.outcome;
      else outcome = lower.includes(away) && !lower.includes(home) ? "AWAY" : "HOME";
      break;
    }
  }

  const reply = matchId
    ? `Reading a ${outcome} position; running Kelly + Monte-Carlo now.`
    : `Tell me which World Cup match and side you want, plus your bankroll.`;

  return { matchId, outcome, bankroll, kellyFraction, reply, source: "heuristic" };
}

const SYSTEM_PROMPT =
  "You are Canvas Markets' risk copilot. Convert the user's betting request into a JSON selection. " +
  'Respond ONLY with JSON: {"matchId": string|null, "outcome": "HOME"|"DRAW"|"AWAY"|"OVER_2_5"|"UNDER_2_5"|null, ' +
  '"bankroll": number|null, "kellyFraction": number, "reply": string}. ' +
  "kellyFraction defaults to 0.5 (half-Kelly) unless the user asks for full (1) or quarter (0.25). " +
  "Pick matchId only from the provided list. Keep reply to one short sentence. Never invent odds or numbers.";

/** Parse a free-text bet request. Uses Kimi if configured, else the heuristic. */
export async function parseBetIntent(text: string, matches: MatchOdds[]): Promise<ParsedIntent> {
  const heuristic = heuristicIntent(text, matches);
  if (!config.kimi.apiKey) return heuristic;

  const catalogue = matches
    .map((m) => `${m.id}: ${m.home} vs ${m.away} (${m.stage})`)
    .join("\n");
  const messages: KimiMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: `Available matches:\n${catalogue}` },
    { role: "user", content: text },
  ];

  try {
    const content = await callKimi(messages, { temperature: 0.2, timeoutMs: 6000 });
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const raw = JSON.parse(cleaned) as Partial<ParsedIntent>;
    const validMatch = matches.some((m) => m.id === raw.matchId);
    return {
      matchId: validMatch ? (raw.matchId as string) : heuristic.matchId,
      outcome: typeof raw.outcome === "string" ? raw.outcome : heuristic.outcome,
      bankroll: typeof raw.bankroll === "number" ? raw.bankroll : heuristic.bankroll,
      kellyFraction:
        typeof raw.kellyFraction === "number" && raw.kellyFraction > 0 && raw.kellyFraction <= 1
          ? raw.kellyFraction
          : heuristic.kellyFraction,
      reply: typeof raw.reply === "string" && raw.reply ? raw.reply : heuristic.reply,
      source: "llm",
    };
  } catch (err) {
    logger.warn({ err }, "Kimi intent parse failed — using heuristic");
    return heuristic;
  }
}

/** Templated, number-faithful narration of a completed risk assessment. */
export function explainAssessment(
  a: SelectionAssessment,
  matchLabel: string,
  selectionLabel: string,
): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const usd = (x: number) => `$${x.toFixed(2)}`;

  if (!a.stake.bet) {
    return (
      `No edge on ${selectionLabel} (${matchLabel}): our fair price is ${pct(a.fairProb)} but the ` +
      `market only pays ${pct(a.metrics.impliedProb)} implied, so expected value is negative. Skip it.`
    );
  }

  const ruin = a.simulation.ruinProbability;
  const ruinNote =
    ruin > 0.2
      ? ` That's a ${pct(ruin)} chance of ruin over ${a.horizonBets} bets — consider quarter-Kelly to stay in the game.`
      : ` Projected ruin risk over ${a.horizonBets} bets is only ${pct(ruin)}.`;

  return (
    `${selectionLabel} is +EV: fair ${pct(a.fairProb)} vs ${pct(a.metrics.impliedProb)} implied — ` +
    `a ${pct(a.metrics.probEdge)} probability edge (Sharpe ${a.metrics.sharpe.toFixed(2)}). ` +
    `At ${(a.kellyFraction * 100).toFixed(0)}%-Kelly, stake ${usd(a.stake.stake)} ` +
    `(${pct(a.stake.appliedFraction)} of bankroll).${ruinNote}`
  );
}
