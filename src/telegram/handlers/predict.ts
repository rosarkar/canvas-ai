/**
 * /predict — Canvas Cup in Telegram (Canvas's home turf).
 *
 * Fans pick a World Cup match → an outcome → stake points, all via inline
 * keyboards. Predictions share the same provably-fair store as the web app, so
 * settlement (on-chain-verified via TxLINE) and the leaderboard are unified.
 */
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { resolveOddsFeed } from "@/services/odds-feed.js";
import { addPrediction, getOrCreatePlayer, leaderboard, listPredictions } from "@/services/fan/store.js";
import type { MatchOdds } from "@/services/txodds.client.js";
import { logger } from "@/utils/logger.js";

const STAKE_CHOICES = [50, 100, 250];

function handleOf(ctx: { from?: { username?: string; first_name?: string; id?: number } }): string {
  return ctx.from?.username ?? ctx.from?.first_name ?? `tg${ctx.from?.id ?? "?"}`;
}

function oneX2(m: MatchOdds) {
  return m.markets.find((k) => k.key === "1X2") ?? m.markets[0];
}

export function registerPredictHandler(bot: Bot): void {
  bot.command("predict", async (ctx) => {
    try {
      const matches = await (await resolveOddsFeed()).getMatches();
      const kb = new InlineKeyboard();
      matches.slice(0, 8).forEach((m) => kb.text(`${m.home} v ${m.away}`, `pred:m:${m.id}`).row());
      await ctx.reply("⚽ *Canvas Cup* — pick a World Cup match to predict:", {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
    } catch (err) {
      logger.error({ err }, "/predict failed");
      await ctx.reply("Couldn't load matches right now — try again shortly.");
    }
  });

  bot.command("leaderboard", async (ctx) => {
    const rows = leaderboard(10)
      .map((p, i) => `${["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`} ${p.handle} — *${p.points}* pts (${p.bestStreak}🔥)`)
      .join("\n");
    await ctx.reply(`🏆 *Canvas Cup leaderboard*\n\n${rows || "No predictions yet — be first!"}`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("mypicks", async (ctx) => {
    const me = getOrCreatePlayer(handleOf(ctx));
    const picks = listPredictions(me.handle)
      .slice(0, 8)
      .map((p) => `• ${p.selectionLabel} (${p.stakePoints}p) — ${p.status}`)
      .join("\n");
    await ctx.reply(
      `🎯 *${me.handle}* — ${me.points} pts · ${me.wins}–${me.losses} · ${me.streak}🔥\n\n${picks || "No predictions yet. Send /predict."}`,
      { parse_mode: "Markdown" },
    );
  });

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("pred:")) {
      await next();
      return;
    }
    const parts = data.split(":");
    const feed = await resolveOddsFeed();

    // pred:m:<matchId> — chose a match, show outcomes
    if (parts[1] === "m") {
      const match = await feed.getMatch(parts[2]);
      if (!match) {
        await ctx.answerCallbackQuery({ text: "Match not found", show_alert: true });
        return;
      }
      const kb = new InlineKeyboard();
      (oneX2(match)?.outcomes ?? []).forEach((o) =>
        kb.text(`${o.label} @ ${o.decimalOdds.toFixed(2)}`, `pred:o:${match.id}:${o.key}`).row(),
      );
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`*${match.home} v ${match.away}* — who wins?`, {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
      return;
    }

    // pred:o:<matchId>:<outcome> — chose an outcome, ask stake
    if (parts[1] === "o") {
      const kb = new InlineKeyboard();
      STAKE_CHOICES.forEach((s) => kb.text(`${s} pts`, `pred:s:${parts[2]}:${parts[3]}:${s}`));
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("How many points?", { reply_markup: kb });
      return;
    }

    // pred:s:<matchId>:<outcome>:<stake> — record the prediction
    if (parts[1] === "s") {
      const match = await feed.getMatch(parts[2]);
      const o = match ? oneX2(match)?.outcomes.find((x) => x.key === parts[3]) : undefined;
      if (!match || !o) {
        await ctx.answerCallbackQuery({ text: "Selection expired", show_alert: true });
        return;
      }
      const { prediction, player } = addPrediction({
        player: handleOf(ctx),
        matchId: match.id,
        matchLabel: `${match.home} v ${match.away}`,
        outcome: o.key,
        selectionLabel: o.label,
        decimalOdds: o.decimalOdds,
        stakePoints: Number(parts[4]),
      });
      await ctx.answerCallbackQuery({ text: "Prediction locked in!" });
      await ctx.editMessageText(
        `✅ *${prediction.selectionLabel}* for *${prediction.stakePoints} pts* @ ${o.decimalOdds.toFixed(2)}\n` +
          `Win → ${Math.round(prediction.stakePoints * o.decimalOdds)} pts. Settled provably-fairly against TxLINE's on-chain Merkle root.\n\n` +
          `Balance: *${player.points}* pts · /leaderboard · /mypicks`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    await ctx.answerCallbackQuery();
  });
}
