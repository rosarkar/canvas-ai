import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";

import { getTopBidForGroup } from "@/adapters/bidding.js";
import type { GroupRow } from "@/adapters/groups.adapter.js";
import { getTemplateById } from "@/adapters/templates.adapter.js";
import {
  appendConversationMessage,
  createVerification,
  getVerificationByToken,
  type VerificationEntryType,
  type VerificationRow,
  transitionState,
} from "@/adapters/verification.adapter.js";
import { getNextAgentTurn } from "@/services/captcha-agent.js";
import { getCaptchaById } from "@/services/captcha-questions.js";
import {
  resolveVerificationTask,
  TaskType,
  type ResolvedVerificationTask,
} from "@/services/verification-tasks.js";
import { VerificationState } from "@/services/verification-states.js";
import { sendVerificationTaskDm } from "@/telegram/services/captcha-dm.js";
import { sendWelcomeGateMessage } from "@/telegram/services/welcome-gate.js";
import { restrictUserForCaptcha } from "@/telegram/verification-actions.js";
import { logger } from "@/utils/logger.js";

export interface BeginVerificationResult {
  verification: VerificationRow;
  captchaSentInDm: boolean;
}

function taskToTransitionExtra(task: ResolvedVerificationTask) {
  return {
    taskType: task.taskType,
    taskPayload: task.payload,
    captchaQuestionId: task.captchaQuestionId,
    captchaCorrectOption: task.captchaCorrectOption,
  };
}

function rebuildTaskFromVerification(verification: VerificationRow): ResolvedVerificationTask | null {
  if (!verification.taskType || !verification.taskPayload) return null;
  return {
    taskType: verification.taskType as TaskType,
    payload: verification.taskPayload as ResolvedVerificationTask["payload"],
    captchaQuestionId: verification.captchaQuestionId ?? undefined,
    captchaCorrectOption: verification.captchaCorrectOption ?? undefined,
  };
}

export async function beginVerification(
  api: Api,
  user: { id: number; first_name: string },
  group: GroupRow,
  groupTitle: string,
  entryType: VerificationEntryType,
): Promise<BeginVerificationResult> {
  const topBid = await getTopBidForGroup(group.groupId);
  const template = topBid?.templateId ? await getTemplateById(topBid.templateId) : null;

  // Conversational captcha: the dialogue agent generates a natural opening question
  // from the advertiser's brief (enriched task_template → template prompt → campaign
  // task_text → group topic). If the agent fails, fall back to the legacy static task
  // DM. The enriched brief travels serialized — captcha-agent parses it internally.
  const humanPrompt =
    (topBid?.taskTemplate as { openingPrompt?: string } | null)?.openingPrompt?.trim() ||
    (template?.payload as { prompt?: string } | null)?.prompt?.trim() ||
    topBid?.taskText?.trim() ||
    group.verificationTaskText?.trim() ||
    `the topic of the group "${groupTitle}"`;
  const advertiserBrief =
    topBid?.taskTemplate != null ? JSON.stringify(topBid.taskTemplate) : humanPrompt;
  const groupContext = [groupTitle, group.verificationTaskText ?? ""].filter(Boolean).join(" — ");
  const opening = await getNextAgentTurn({
    advertiserBrief,
    groupContext,
    conversationHistory: [],
    isFirstTurn: true,
  });
  const conversational = opening.message.length > 0 && !opening.shouldClose;

  // prompt stays human-readable (it feeds the scorer and the resend-DM fallback);
  // brief carries the serialized enriched context for the agent's later turns.
  const task: ResolvedVerificationTask = conversational
    ? { taskType: TaskType.OPEN_TEXT, payload: { prompt: humanPrompt, brief: advertiserBrief } }
    : resolveVerificationTask(group, topBid, template);

  const verification = await createVerification({
    tgUserId: BigInt(user.id),
    groupId: group.groupId,
    advertiserId: topBid?.advertiserId ?? null,
    entryType,
  });

  await transitionState(verification.verificationId, VerificationState.TASK_SENT, {
    lockedBidPrice: topBid?.bidPerVerification ?? undefined,
    ...taskToTransitionExtra(task),
  });

  if (conversational) {
    // conversation_turn = 1: the agent's opening message counts as the first turn.
    await appendConversationMessage(
      verification.verificationId,
      { role: "assistant", content: opening.message },
      { incrementTurn: true },
    );
  }

  const sendTaskDm = async (): Promise<boolean> => {
    if (conversational) {
      try {
        await api.sendMessage(
          user.id,
          `👋 Hey! You just requested to join **${groupTitle}**.\n\n` +
            `This group uses Canvas to verify new members before letting anyone in — just answer in your own words.\n\n` +
            `${opening.message}`,
          { parse_mode: "Markdown" },
        );
        return true;
      } catch {
        return false;
      }
    }
    return sendVerificationTaskDm(api, user.id, verification.verificationId, task, groupTitle);
  };

  const me = await api.getMe();
  const botUsername = me.username ?? "CanvasVerificationBot";
  let captchaSentInDm = false;

  if (entryType === "open_join") {
    await restrictUserForCaptcha(api, group.tgGroupId, user.id);
    captchaSentInDm = await sendTaskDm();
    if (!captchaSentInDm) {
      // Only post in the group when the DM failed — a successful DM needs no
      // public notice, and the gate message just added chat noise on every join.
      await sendWelcomeGateMessage(api, Number(group.tgGroupId), group.groupId);
      await transitionState(verification.verificationId, VerificationState.DEEP_LINK_SENT);
      // The user has DMs disabled (or never started the bot) and is muted — without
      // this button in the group they would have no path to verification at all.
      const deepLink = `https://t.me/${botUsername}?start=verify_${verification.verificationId}`;
      try {
        await api.sendMessage(
          Number(group.tgGroupId),
          `${user.first_name}, I couldn't message you — tap below to verify and unlock the chat.`,
          { reply_markup: new InlineKeyboard().url("Verify to join →", deepLink) },
        );
      } catch {
        /* group post is best-effort; the TTL sweep still cleans up unverified users */
      }
    }
  } else {
    captchaSentInDm = await sendTaskDm();
    if (!captchaSentInDm) {
      await transitionState(verification.verificationId, VerificationState.DEEP_LINK_SENT);
      const deepLink = `https://t.me/${botUsername}?start=verify_${verification.verificationId}`;
      const keyboard = new InlineKeyboard().url("Verify to join →", deepLink);
      try {
        await api.sendMessage(
          user.id,
          `👋 You requested to join **${groupTitle}**.\n\nTap below to complete your verification — it only takes 30 seconds.`,
          { reply_markup: keyboard, parse_mode: "Markdown" },
        );
      } catch {
        /* cannot reach user */
      }
    }
  }

  logger.info(
    {
      verificationId: verification.verificationId,
      groupId: group.groupId,
      tgUserId: user.id,
      entryType,
      taskType: task.taskType,
      captchaSentInDm,
    },
    "Verification started",
  );

  return { verification, captchaSentInDm };
}

export async function resendVerificationDm(
  api: Api,
  userId: number,
  verificationId: string,
  groupTitle: string,
): Promise<boolean> {
  const verification = await getVerificationByToken(verificationId);
  if (!verification) return false;

  let task = rebuildTaskFromVerification(verification);
  if (!task && verification.captchaQuestionId) {
    const captcha = getCaptchaById(verification.captchaQuestionId);
    if (!captcha) return false;
    task = {
      taskType: TaskType.TRIVIA_MC,
      payload: {
        prompt: captcha.prompt,
        options: captcha.options,
        correctOptionId: captcha.correctOptionId,
        questionId: captcha.id,
      },
      captchaQuestionId: captcha.id,
      captchaCorrectOption: captcha.correctOptionId,
    };
  }
  if (!task) return false;

  return sendVerificationTaskDm(api, userId, verificationId, task, groupTitle);
}

/** @deprecated Use resendVerificationDm */
export async function resendCaptchaDm(
  api: Api,
  userId: number,
  verificationId: string,
  groupTitle: string,
): Promise<boolean> {
  return resendVerificationDm(api, userId, verificationId, groupTitle);
}
