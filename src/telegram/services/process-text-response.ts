import type { Api } from "grammy";

import { getGroupById } from "@/adapters/groups.adapter.js";
import {
  appendConversationMessage,
  bumpAttemptCount,
  transitionState,
  type ConversationMessage,
  type VerificationRow,
} from "@/adapters/verification.adapter.js";
import { getNextAgentTurn } from "@/services/captcha-agent.js";
import { scoreWithKimi, passesThreshold, type ScoreResult } from "@/services/scoring.js";
import {
  TaskType,
  parseTaskPayload,
  type BinaryReasoningPayload,
  type OpenTextPayload,
  type RankReasoningPayload,
} from "@/services/verification-tasks.js";
import {
  extractOptionAndReasoning,
  extractRankingAndReasoning,
  isThinResponse,
} from "@/services/text-response-parser.js";
import { VerificationState } from "@/services/verification-states.js";
import { getBot } from "@/telegram/bot.js";
import {
  completeVerificationFail,
  completeVerificationPass,
} from "@/telegram/services/verification-complete.js";
import { logger } from "@/utils/logger.js";

export type TextVerificationOutcome =
  | { outcome: "passed"; score: number }
  | { outcome: "failed"; score: number }
  | { outcome: "re_prompted" }
  /** A concurrent update already claimed this verification — do nothing, send nothing. */
  | { outcome: "already_processed" }
  /** Kimi errored — row parked in SCORING for the retry sweep; user was told to wait. */
  | { outcome: "scoring_deferred" };

const BACK_FOOTER = "\n\nType /start to return to the main menu.";
const DEFAULT_OPEN_TEXT_REPROMPT = "Can you say a bit more? A specific detail or two helps." + BACK_FOOTER;
const DEFAULT_RANK_REPROMPT =
  "Almost there. Can you add one sentence on why you ranked your top pick first?" + BACK_FOOTER;
const DEFAULT_BINARY_REPROMPT = "Got it — can you add one sentence on why? Just a few words is fine." + BACK_FOOTER;
const DEFAULT_BINARY_NO_OPTION_REPROMPT =
  'Start your reply with the letter of the option you\'re picking (e.g. "A — ...").' + BACK_FOOTER;

async function sendRePrompt(api: Api, verification: VerificationRow, text: string): Promise<void> {
  await bumpAttemptCount(verification.verificationId);
  try {
    await api.sendMessage(Number(verification.tgUserId), text);
  } catch {
    /* user may have blocked the bot — they simply won't see the re-prompt */
  }
}

async function finalize(
  api: Api,
  verification: VerificationRow,
  scoringPrompt: string,
  responseText: string,
  bonusMicroUnits?: bigint,
): Promise<TextVerificationOutcome> {
  // Compare-and-swap: claim the verification for this update. If another concurrent
  // webhook update already moved it past TASK_SENT/DEEP_LINK_SENT, bail — otherwise
  // both would score, pass, and accrue payout for the same verification.
  const claimed = await transitionState(
    verification.verificationId,
    VerificationState.RESPONSE_RECEIVED,
    {
      responseText,
      expectedState: [VerificationState.TASK_SENT, VerificationState.DEEP_LINK_SENT],
    },
  );
  if (!claimed) return { outcome: "already_processed" };

  // If anything below throws (Kimi, the DB, a Telegram send), the TTL sweep picks the
  // row up out of SCORING/RESPONSE_RECEIVED (expireStaleVerifications) and times it out.
  await transitionState(verification.verificationId, VerificationState.SCORING, {
    expectedState: VerificationState.RESPONSE_RECEIVED,
  });

  // No active advertiser — admit on any non-empty response without calling Kimi.
  const noAdvertiser = verification.advertiserId == null;
  // failClosed: this Kimi call only runs for advertiser-funded verifications (see the
  // bypass above) — on Kimi errors, fail the verification instead of falling back to
  // the gameable keyword scorer, since a pass moves real USDC.
  const result = noAdvertiser
    ? { score: 100, method: "manual" as const }
    : await scoreWithKimi(scoringPrompt, responseText, { failClosed: true });

  if (result.method === "fail_closed") {
    // Kimi errored (not a genuine low score) — don't burn the user's attempt. Park the
    // row in SCORING for the retry sweep (scoring-retry.ts, runs every 60s, max 4
    // tries) and push expires_at out so the stranded-row sweep leaves it alone.
    await transitionState(verification.verificationId, VerificationState.SCORING, {
      expiresAt: new Date(Date.now() + 15 * 60_000),
      expectedState: VerificationState.SCORING,
    });
    try {
      await api.sendMessage(
        Number(verification.tgUserId),
        "⏳ Scoring is taking a moment longer than usual — no action needed, we'll finish up shortly.",
      );
    } catch {
      /* DM failure must not affect the deferral */
    }
    return { outcome: "scoring_deferred" };
  }

  return completeScoredVerification(api, verification, result, bonusMicroUnits);
}

/**
 * Final transitions + user-facing completion for a scored verification. Shared by the
 * immediate path (finalize) and the scoring-retry sweep. CAS on SCORING makes it safe
 * against a concurrent completion.
 *
 * Note: bonusMicroUnits only applies on immediate scoring — deferred completions pay
 * the base rate (the bonus context isn't persisted with the row).
 */
export async function completeScoredVerification(
  api: Api,
  verification: VerificationRow,
  result: ScoreResult,
  bonusMicroUnits?: bigint,
): Promise<TextVerificationOutcome> {
  const passed = result.method === "manual" || passesThreshold(result);

  const group = await getGroupById(verification.groupId);
  if (!group) throw new Error("Group not found");
  // No Telegram round trips here: title comes from the group row, username from
  // grammY's startup cache.
  const groupTitle = group.groupTitle ?? "the group";
  const botUsername = getBot().botInfo.username;

  if (passed) {
    const marked = await transitionState(verification.verificationId, VerificationState.PASSED, {
      kimiScore: result.score,
      bonusMicroUnits,
      expectedState: VerificationState.SCORING,
    });
    if (!marked) return { outcome: "already_processed" };
    await completeVerificationPass(api, verification.verificationId, group, groupTitle, botUsername);
    logger.info(
      { verificationId: verification.verificationId, score: result.score, method: result.method },
      "User passed text verification",
    );
  } else {
    const marked = await transitionState(verification.verificationId, VerificationState.KIMI_FAILED, {
      kimiScore: result.score,
      expectedState: VerificationState.SCORING,
    });
    if (!marked) return { outcome: "already_processed" };
    await transitionState(verification.verificationId, VerificationState.FAILED);
    await completeVerificationFail(api, verification, group);
    logger.info(
      { verificationId: verification.verificationId, score: result.score, method: result.method },
      "User failed text verification",
    );
  }

  return passed
    ? { outcome: "passed", score: result.score }
    : { outcome: "failed", score: result.score };
}

/** Rebuild the scoring prompt from the stored row — used by the retry sweep. */
export async function buildScoringPrompt(verification: VerificationRow): Promise<string> {
  const taskType = (verification.taskType as TaskType) ?? TaskType.OPEN_TEXT;
  if (taskType === TaskType.RANK_REASONING) {
    const payload = parseTaskPayload(taskType, verification.taskPayload) as RankReasoningPayload | null;
    return payload?.prompt ?? "Rank these items.";
  }
  if (taskType === TaskType.BINARY_REASONING) {
    const payload = parseTaskPayload(taskType, verification.taskPayload) as BinaryReasoningPayload | null;
    return payload?.prompt ?? "Pick an option.";
  }
  const payload = parseTaskPayload(TaskType.OPEN_TEXT, verification.taskPayload) as OpenTextPayload | null;
  if (payload?.prompt) return payload.prompt;
  const group = await getGroupById(verification.groupId);
  return group?.verificationTaskText ?? "Tell us about yourself.";
}

/**
 * Handles a DM text reply for open_text, rank_reasoning, and binary_reasoning tasks.
 * Each type gets exactly one re-prompt if the first reply is too thin/incomplete
 * (gated by attempt_count) before falling through to Kimi scoring.
 */
export async function processTextVerificationResponse(
  api: Api,
  verification: VerificationRow,
  responseText: string,
): Promise<TextVerificationOutcome> {
  const taskType = (verification.taskType as TaskType) ?? TaskType.OPEN_TEXT;
  const canRePrompt = verification.attemptCount < 2;

  if (taskType === TaskType.RANK_REASONING) {
    const payload = parseTaskPayload(taskType, verification.taskPayload) as RankReasoningPayload | null;
    const { ranking, reasoning } = extractRankingAndReasoning(responseText);

    if (canRePrompt && (!ranking || isThinResponse(reasoning, 10, 2))) {
      await sendRePrompt(api, verification, payload?.rePromptText ?? DEFAULT_RANK_REPROMPT);
      return { outcome: "re_prompted" };
    }

    return finalize(api, verification, payload?.prompt ?? "Rank these items.", responseText);
  }

  if (taskType === TaskType.BINARY_REASONING) {
    const payload = parseTaskPayload(taskType, verification.taskPayload) as BinaryReasoningPayload | null;
    const options = payload?.options ?? [];
    const { optionId, reasoning } = extractOptionAndReasoning(responseText, options);

    if (canRePrompt && !optionId) {
      await sendRePrompt(api, verification, DEFAULT_BINARY_NO_OPTION_REPROMPT);
      return { outcome: "re_prompted" };
    }
    if (canRePrompt && isThinResponse(reasoning, 10, 2)) {
      await sendRePrompt(api, verification, DEFAULT_BINARY_REPROMPT);
      return { outcome: "re_prompted" };
    }

    const hasReasoning = !isThinResponse(reasoning, 10, 2);
    const bonus = hasReasoning && payload?.bonusMicroUnits ? BigInt(payload.bonusMicroUnits) : undefined;
    return finalize(api, verification, payload?.prompt ?? "Pick an option.", responseText, bonus);
  }

  // OPEN_TEXT, and legacy verifications created before task_type existed.
  const payload = parseTaskPayload(TaskType.OPEN_TEXT, verification.taskPayload) as OpenTextPayload | null;
  let prompt = payload?.prompt;
  if (!prompt) {
    const group = await getGroupById(verification.groupId);
    prompt = group?.verificationTaskText ?? "Tell us about yourself.";
  }

  // Conversational captcha: rows started by the dialogue agent (turn > 0) go through
  // the multi-turn flow — the agent decides whether to probe or close, and the Kimi
  // quality gate scores the full transcript at the end.
  if (verification.conversationTurn > 0) {
    // The serialized enriched brief (if the campaign has one) drives the agent;
    // the human-readable prompt still anchors the scoring call.
    return processConversationalResponse(api, verification, payload?.brief ?? prompt, responseText, prompt);
  }

  if (canRePrompt && isThinResponse(responseText)) {
    await sendRePrompt(api, verification, payload?.rePromptText ?? DEFAULT_OPEN_TEXT_REPROMPT);
    return { outcome: "re_prompted" };
  }

  return finalize(api, verification, prompt, responseText);
}

/** Render the dialogue log as a transcript for the Kimi quality scorer. */
function formatTranscript(history: ConversationMessage[]): string {
  return history
    .map((m) => `${m.role === "assistant" ? "Agent" : "User"}: ${m.content}`)
    .join("\n");
}

/**
 * Multi-turn conversational captcha. Each user reply is appended to
 * conversation_history and bumps conversation_turn; the row stays in
 * TASK_SENT/DEEP_LINK_SENT between agent probes. The conversation closes when the
 * agent says so or after 4 turns (agent opening + 3 user replies), at which point
 * the full transcript goes through the unchanged Kimi scoring gate in finalize().
 */
async function processConversationalResponse(
  api: Api,
  verification: VerificationRow,
  advertiserBrief: string,
  responseText: string,
  scoringPrompt: string = advertiserBrief,
): Promise<TextVerificationOutcome> {
  await appendConversationMessage(
    verification.verificationId,
    { role: "user", content: responseText },
    { incrementTurn: true },
  );
  const history: ConversationMessage[] = [
    ...verification.conversationHistory,
    { role: "user", content: responseText },
  ];
  const turn = verification.conversationTurn + 1;

  let shouldClose = turn >= 4;
  let agentMessage = "";

  if (!shouldClose) {
    const group = await getGroupById(verification.groupId);
    const groupContext = [group?.groupTitle ?? "the group", group?.verificationTaskText ?? ""]
      .filter(Boolean)
      .join(" — ");
    const next = await getNextAgentTurn({
      advertiserBrief,
      groupContext,
      conversationHistory: history,
      isFirstTurn: false,
    });
    shouldClose = next.shouldClose;
    agentMessage = next.message;
  }

  if (!shouldClose && agentMessage) {
    await appendConversationMessage(verification.verificationId, {
      role: "assistant",
      content: agentMessage,
    });
    try {
      await api.sendMessage(Number(verification.tgUserId), agentMessage);
    } catch {
      /* user may have blocked the bot — the row stays open until the TTL sweep */
    }
    // No state transition — the row stays in TASK_SENT/DEEP_LINK_SENT awaiting the next reply.
    return { outcome: "re_prompted" };
  }

  // Close: send the agent's closing line (or a neutral fallback) so the user isn't
  // left hanging while the quality gate scores the whole transcript.
  try {
    await api.sendMessage(
      Number(verification.tgUserId),
      agentMessage || "Thanks — one moment while we verify your response.",
    );
  } catch {
    /* DM failure must not block scoring */
  }
  return finalize(api, verification, scoringPrompt, formatTranscript(history));
}
