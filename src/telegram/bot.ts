import { autoRetry } from "@grammyjs/auto-retry";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bot, webhookCallback } from "grammy";

import { config } from "@/config/index.js";
import { registerAdmissionCallbackHandler } from "@/telegram/handlers/admission-callback.js";
import { registerBotMembershipHandler } from "@/telegram/handlers/bot-membership.js";
import { registerBuyHandler } from "@/telegram/handlers/buy.js";
import { registerCampaignApprovalHandler } from "@/telegram/handlers/campaign-approval.js";
import { registerCampaignHandlers } from "@/telegram/handlers/campaigns.js";
import { registerCaptchaCallbackHandler } from "@/telegram/handlers/captcha-callback.js";
import { registerJoinHandler } from "@/telegram/handlers/join.js";
import { registerJoinRequestHandler } from "@/telegram/handlers/join-request.js";
import { registerLinkHandler } from "@/telegram/handlers/link.js";
import { registerMenuHandler } from "@/telegram/handlers/menu.js";
import { registerMessageHandler } from "@/telegram/handlers/message.js";
import { registerRegisterHandler } from "@/telegram/handlers/register.js";
import { registerStartHandler } from "@/telegram/handlers/start.js";
import { registerAgentOfferSkipHandler } from "@/telegram/services/captcha-dm.js";
import { registerPredictHandler } from "@/telegram/handlers/predict.js";
import { advertiserRouter } from "@/api/advertiser.js";
import { dashboardRouter } from "@/api/dashboard.js";
import { depositRouter } from "@/api/deposit.js";
import { groupOwnerRouter } from "@/api/group-owner.js";
import { groupsRouter } from "@/api/groups.js";
import { marketsRouter } from "@/api/markets.js";
import { fanRouter } from "@/api/fan.js";
import { logger } from "@/utils/logger.js";

let bot: Bot | null = null;

export function getBot(): Bot {
  if (!bot) throw new Error("Telegram bot not started");
  return bot;
}

export function startTelegramBot(): void {
  bot = new Bot(config.telegram.botToken);
  bot.api.config.use(autoRetry());

  registerStartHandler(bot);
  registerRegisterHandler(bot);
  registerBuyHandler(bot);
  registerCampaignHandlers(bot);
  registerCampaignApprovalHandler(bot);
  registerLinkHandler(bot);
  registerJoinHandler(bot);
  registerJoinRequestHandler(bot);
  registerBotMembershipHandler(bot);
  registerCaptchaCallbackHandler(bot);
  registerAgentOfferSkipHandler(bot);
  registerAdmissionCallbackHandler(bot);
  registerMenuHandler(bot);
  registerPredictHandler(bot);
  registerMessageHandler(bot);

  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx.update }, "Telegram bot error");
  });

  const app = express();
  app.use(express.json());

  // Telegram's in-app browser sets COOP same-origin, which severs window.opener and
  // breaks the Coinbase smart wallet SDK's popup flow on the deposit page
  // ("This app doesn't support smart wallets" from keys.coinbase.com).
  // same-origin-allow-popups keeps our pages isolated but lets the wallet popup
  // hold its opener reference. Applied to all responses — harmless for the API routes.
  app.use((_req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    next();
  });

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  app.use("/mini-app", express.static(path.join(repoRoot, "public/mini-app")));
  app.use("/advertiser", express.static(path.join(repoRoot, "public/advertiser")));
  app.use("/group-owner", express.static(path.join(repoRoot, "public/group-owner")));
  app.use("/dashboard", express.static(path.join(repoRoot, "public/dashboard")));
  app.use("/markets", express.static(path.join(repoRoot, "public/markets")));
  app.use("/fan", express.static(path.join(repoRoot, "public/fan")));
  app.use(advertiserRouter);
  app.use(dashboardRouter);
  app.use(depositRouter);
  app.use(groupOwnerRouter);
  app.use(groupsRouter);
  app.use(marketsRouter);
  app.use(fanRouter);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "canvas-ai" });
  });

  app.post("/telegram/webhook", (req, res) => {
    const secret = config.telegram.webhookSecret;
    if (secret) {
      const header = req.headers["x-telegram-bot-api-secret-token"];
      if (header !== secret) {
        res.status(403).json({ error: "invalid webhook secret" });
        return;
      }
    }
    return webhookCallback(bot!, "express")(req, res);
  });

  app.listen(config.telegram.webhookPort, "0.0.0.0", () => {
    logger.info(`Canvas AI webhook listening on port ${config.telegram.webhookPort}`);
  });

  bot.api
    .setWebhook(config.telegram.webhookUrl, {
      secret_token: config.telegram.webhookSecret || undefined,
      allowed_updates: [
        "message",
        "chat_member",
        "chat_join_request",
        "my_chat_member",
        "callback_query",
      ],
    })
    .then(() => logger.info(`Webhook registered → ${config.telegram.webhookUrl}`))
    .catch((err) => {
      logger.error({ err }, "Failed to set Telegram webhook");
      process.exit(1);
    });
}
