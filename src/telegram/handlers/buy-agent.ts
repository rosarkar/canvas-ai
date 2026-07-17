import type { Bot } from "grammy";

import { getAdvertiserByTgId } from "@/adapters/advertisers.adapter.js";
import { getTopBidForGroup, placeBid, type TopBid } from "@/adapters/bidding.js";
import { listActiveGroups, type GroupRow } from "@/adapters/groups.adapter.js";
import { createTemplate } from "@/adapters/templates.adapter.js";
import { config } from "@/config/index.js";
import {
  buildLiveContextMessage,
  buildTaskTemplate,
  emptyIntent,
  interpretAdvertiserMessage,
  mergeIntent,
  type BuyAgentIntent,
  type GroupContext,
  type TaskTemplateBrief,
} from "@/services/buy-assistant.js";
import type { KimiMessage } from "@/services/scoring.js";
import {
  ADVERTISER_TASK_TYPES,
  labelOptions,
  TaskType,
  type TaskOption,
  type TaskPayload,
} from "@/services/verification-tasks.js";
import { buildDepositMessage, buildPayloadFromDraft, FORMAT_LABELS, formatUsd, MIN_QUANTITY } from "@/telegram/handlers/buy.js";
import { fromMicroUnits, toMicroUnits } from "@/utils/usdc.js";
import { logger } from "@/utils/logger.js";

interface BuyAgentSession {
  messages: KimiMessage[];
  intent: BuyAgentIntent;
  groups: GroupRow[];
  lastActivityAt: number;
}

const sessions = new Map<number, BuyAgentSession>();

/** A stale session would otherwise suppress verification-reply routing for this user forever. */
const SESSION_IDLE_TTL_MS = 30 * 60_000;

/** Lazy expiry: a session idle past the TTL is deleted at lookup time — no background sweep. */
function getLiveSession(userId: number): BuyAgentSession | undefined {
  const session = sessions.get(userId);
  if (!session) return undefined;
  if (Date.now() - session.lastActivityAt > SESSION_IDLE_TTL_MS) {
    sessions.delete(userId);
    return undefined;
  }
  return session;
}

export function hasActiveBuyAgentSession(userId: number): boolean {
  return getLiveSession(userId) !== undefined;
}

interface ValidatedCampaign {
  groupId: number;
  groupTitle: string;
  quantity: number;
  bidMicroUnits: bigint;
  taskType: TaskType;
  payload: TaskPayload;
  templateName: string;
  taskTemplate: TaskTemplateBrief;
}

function deriveTemplateName(prompt: string | null): string {
  if (!prompt) return "Untitled campaign";
  return prompt.length > 40 ? `${prompt.slice(0, 40).trim()}…` : prompt;
}

function buildDraftFromIntentPayload(
  taskType: TaskType,
  payload: BuyAgentIntent["payload"],
): Record<string, unknown> {
  switch (taskType) {
    case TaskType.PREFERENCE_MC: {
      const draft: Record<string, unknown> = { prompt: payload.prompt ?? undefined };
      if (payload.options && payload.options.length > 0) {
        draft.options = labelOptions(payload.options);
      }
      if (payload.sponsorName) draft.sponsorName = payload.sponsorName;
      if (payload.agentOfferMessage) draft.agentOfferMessage = payload.agentOfferMessage;
      if (payload.agentOfferCtaLabel) draft.agentOfferCtaLabel = payload.agentOfferCtaLabel;
      if (payload.agentOfferCtaUrl) draft.agentOfferCtaUrl = payload.agentOfferCtaUrl;
      return draft;
    }
    case TaskType.RANK_REASONING: {
      const draft: Record<string, unknown> = { prompt: payload.prompt ?? undefined };
      if (payload.items && payload.items.length > 0) {
        draft.items = labelOptions(payload.items);
      }
      return draft;
    }
    case TaskType.BINARY_REASONING: {
      const draft: Record<string, unknown> = {
        prompt: payload.prompt ?? undefined,
        optionA: payload.optionA ?? undefined,
        optionB: payload.optionB ?? undefined,
      };
      if (payload.bonusUsd != null) {
        try {
          draft.bonus = toMicroUnits(payload.bonusUsd).toString();
        } catch {
          /* invalid bonus amount — treat as unset rather than fail the whole turn */
        }
      }
      return draft;
    }
    case TaskType.OPEN_TEXT:
    default:
      return { prompt: payload.prompt ?? undefined };
  }
}

function missingPayloadFields(taskType: TaskType, draft: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const prompt = draft.prompt as string | undefined;
  if (!prompt || prompt.trim().length < 5) issues.push("a question/prompt for the task");

  if (taskType === TaskType.PREFERENCE_MC) {
    const options = draft.options as TaskOption[] | undefined;
    if (!options || options.length < 2) issues.push("at least 2 answer options");
  } else if (taskType === TaskType.RANK_REASONING) {
    const items = draft.items as TaskOption[] | undefined;
    if (!items || items.length < 3) issues.push("at least 3 items to rank");
  } else if (taskType === TaskType.BINARY_REASONING) {
    if (!draft.optionA) issues.push("option A's text");
    if (!draft.optionB) issues.push("option B's text");
  }
  return issues;
}

type ValidationResult =
  | { campaign: ValidatedCampaign; topBidMicroUnits: bigint | null }
  | { issues: string[] };

async function validateIntent(intent: BuyAgentIntent, groups: GroupRow[]): Promise<ValidationResult> {
  const issues: string[] = [];

  const group = intent.groupId != null ? groups.find((g) => g.groupId === intent.groupId) : undefined;
  if (!group) issues.push("a target group");

  const quantity = intent.quantity;
  if (quantity == null || !Number.isFinite(quantity) || quantity < MIN_QUANTITY) {
    issues.push(`a quantity of at least ${MIN_QUANTITY}`);
  }

  let bidMicroUnits: bigint | null = null;
  if (intent.bidUsd == null) {
    issues.push("a bid amount per verification");
  } else {
    try {
      bidMicroUnits = toMicroUnits(intent.bidUsd);
      if (bidMicroUnits < config.constants.MIN_BID_MICROUNITS) {
        issues.push(`a bid of at least ${formatUsd(config.constants.MIN_BID_MICROUNITS)}`);
      }
    } catch {
      issues.push("a valid bid amount");
    }
  }

  let topBid: TopBid | null = null;
  if (group) {
    topBid = await getTopBidForGroup(group.groupId);
    if (topBid && bidMicroUnits != null && bidMicroUnits <= topBid.bidPerVerification) {
      issues.push(`a bid higher than the current top bid of ${formatUsd(topBid.bidPerVerification)}`);
    }
  }

  const taskType =
    intent.taskType && ADVERTISER_TASK_TYPES.includes(intent.taskType) ? intent.taskType : null;
  if (!taskType) issues.push("a verification format");

  let payload: TaskPayload | null = null;
  let draftPrompt: string | null = null;
  if (taskType) {
    const draft = buildDraftFromIntentPayload(taskType, intent.payload);
    draftPrompt = (draft.prompt as string | undefined) ?? null;
    const payloadIssues = missingPayloadFields(taskType, draft);
    if (payloadIssues.length > 0) {
      issues.push(...payloadIssues);
    } else {
      payload = buildPayloadFromDraft(taskType, draft);
    }
  }

  if (issues.length > 0 || !group || quantity == null || bidMicroUnits == null || !taskType || !payload) {
    return { issues };
  }

  return {
    campaign: {
      groupId: group.groupId,
      groupTitle: group.groupTitle ?? `Group #${group.groupId}`,
      quantity,
      bidMicroUnits,
      taskType,
      payload,
      templateName: intent.templateName?.trim() || deriveTemplateName(draftPrompt),
      taskTemplate: buildTaskTemplate(intent, draftPrompt ?? intent.templateName ?? "Verification task"),
    },
    topBidMicroUnits: topBid?.bidPerVerification ?? null,
  };
}

function buildConfirmSummary(campaign: ValidatedCampaign, topBidMicroUnits: bigint | null): string {
  const total = campaign.bidMicroUnits * BigInt(campaign.quantity);
  return (
    `**Ready to launch — here's the full spec:**\n\n` +
    `• Group: ${campaign.groupTitle}\n` +
    `• Format: ${FORMAT_LABELS[campaign.taskType]}\n` +
    `• Bid: ${formatUsd(campaign.bidMicroUnits)} / verification\n` +
    `• Quantity: ${campaign.quantity}\n` +
    `• Total: ${formatUsd(total)} USDC\n` +
    `• Current top bid in this group: ${topBidMicroUnits != null ? formatUsd(topBidMicroUnits) : "none yet"}\n\n` +
    `Type **confirm** to launch this campaign.`
  );
}

async function buildLiveContextForSession(groups: GroupRow[]): Promise<string> {
  const contexts: GroupContext[] = await Promise.all(
    groups.map(async (g) => {
      const topBid = await getTopBidForGroup(g.groupId);
      return {
        groupId: g.groupId,
        title: g.groupTitle ?? `Group #${g.groupId}`,
        topic: g.verificationTaskText ?? "",
        topBidUsd: topBid ? fromMicroUnits(topBid.bidPerVerification) : null,
      };
    }),
  );

  return buildLiveContextMessage(contexts, {
    minQuantity: MIN_QUANTITY,
    minBidUsd: fromMicroUnits(config.constants.MIN_BID_MICROUNITS),
  });
}

async function finalizeCampaign(
  ctx: { api: import("grammy").Bot["api"]; reply: (text: string, extra?: object) => Promise<unknown> },
  fromId: number,
  campaign: ValidatedCampaign,
): Promise<void> {
  try {
    const template = await createTemplate({
      advertiserTgId: BigInt(fromId),
      name: campaign.templateName,
      taskType: campaign.taskType,
      payload: campaign.payload,
    });

    const total = campaign.bidMicroUnits * BigInt(campaign.quantity);
    const result = await placeBid({
      groupId: campaign.groupId,
      advertiserTgId: BigInt(fromId),
      bidMicroUnits: campaign.bidMicroUnits,
      quantity: campaign.quantity,
      taskText: (campaign.payload as { prompt?: string }).prompt,
      taskTemplate: campaign.taskTemplate,
      templateId: template.templateId,
    });

    const taskText =
      (campaign.payload as { prompt?: string }).prompt ??
      campaign.templateName ??
      "Verification task";
    const { text, keyboard } = buildDepositMessage({
      advertiserId: result.advertiserId,
      expectedDepositMicro: result.expectedDepositMicro,
      bidMicroUnits: campaign.bidMicroUnits,
      quantity: campaign.quantity,
      groupTitle: campaign.groupTitle,
      taskText,
    });

    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });

    logger.info(
      {
        advertiserId: result.advertiserId,
        groupId: campaign.groupId,
        fromId,
        templateId: template.templateId,
        total: total.toString(),
      },
      "Advertiser campaign pending deposit via buy agent",
    );

    const linked = await getAdvertiserByTgId(BigInt(fromId));
    if (!linked) {
      await ctx.reply(
        "🔗 Link your Base wallet to track this campaign on the advertiser dashboard:\n`/link 0xYourAddress`",
        { parse_mode: "Markdown" },
      );
    }
  } catch (err) {
    logger.error({ err, fromId }, "buy agent: placeBid/createTemplate failed");
    await ctx.reply("Could not create campaign. Please try again.");
  } finally {
    sessions.delete(fromId);
  }
}

export function registerBuyAgentHandler(bot: Bot): void {
  bot.command("buy", async (ctx) => {
    const fromId = ctx.from?.id;
    if (!fromId || ctx.chat?.type !== "private") {
      await ctx.reply("Send /buy to me in a private chat to start a campaign.");
      return;
    }

    const groups = await listActiveGroups();
    if (groups.length === 0) {
      await ctx.reply("No active groups registered yet. Group owners must /register first.");
      return;
    }

    sessions.set(fromId, { messages: [], intent: emptyIntent(), groups, lastActivityAt: Date.now() });

    await ctx.reply(
      "👋 I'm the Canvas buy agent. Tell me what you're trying to achieve with this campaign — your goal, your " +
        "audience — and I'll help you pick the right verification format and fill it in. If you already know the " +
        "group, budget, or quantity, mention those too — I'll pick them up as we go.",
    );
  });

  bot.on("message:text", async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || ctx.chat?.type !== "private") {
      await next();
      return;
    }

    const session = getLiveSession(fromId);
    if (!session || ctx.message.text.startsWith("/")) {
      await next();
      return;
    }
    session.lastActivityAt = Date.now();

    const text = ctx.message.text.trim();

    if (text.toLowerCase() === "confirm") {
      const groups = await listActiveGroups();
      const validated = await validateIntent(session.intent, groups);
      if ("issues" in validated) {
        await ctx.reply(`Not quite ready yet — still need: ${validated.issues.join(", ")}.`);
        return;
      }
      await finalizeCampaign(ctx, fromId, validated.campaign);
      return;
    }

    session.messages.push({ role: "user", content: text });

    let interpreted;
    try {
      const liveContext = await buildLiveContextForSession(session.groups);
      interpreted = await interpretAdvertiserMessage(session.messages, liveContext);
    } catch (err) {
      logger.warn({ err, fromId }, "buy agent: Kimi turn failed");
      await ctx.reply("Sorry, I'm having trouble thinking right now — try sending that again in a moment.");
      return;
    }

    session.messages.push({
      role: "assistant",
      content: JSON.stringify({ reply: interpreted.reply, intent: interpreted.intent }),
    });
    session.intent = mergeIntent(session.intent, interpreted.intent);
    sessions.set(fromId, session);

    await ctx.reply(interpreted.reply);

    const validated = await validateIntent(session.intent, session.groups);
    if (!("issues" in validated)) {
      await ctx.reply(buildConfirmSummary(validated.campaign, validated.topBidMicroUnits), {
        parse_mode: "Markdown",
      });
    }
  });
}
