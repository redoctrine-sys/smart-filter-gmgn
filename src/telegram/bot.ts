import { Telegraf } from "telegraf";
import { env } from "../config/env.js";
import { getBotState, setBotState } from "../db/client.js";
import { mutedRepo } from "../db/repos.js";
import { logger } from "../utils/logger.js";
import { runAndSendDigest } from "./digest.js";

export const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

/**
 * Auto-detected target chat + topics. Hydrated from .env on boot, but the
 * `/setup` command (run inside the supergroup) overrides them and persists to
 * the bot_state table so restarts pick them up automatically.
 */
export const target = {
  chatId: env.TELEGRAM_CHAT_ID || getBotState("chat_id") || "",
  topics: {
    new_pair: env.TELEGRAM_TOPIC_NEW_PAIR || getBotState("topic_new_pair") || "",
    sleeper: env.TELEGRAM_TOPIC_SLEEPER || getBotState("topic_sleeper") || "",
    post_alert: env.TELEGRAM_TOPIC_POST_ALERT || getBotState("topic_post_alert") || "",
  },
};

function persistTarget(): void {
  if (target.chatId) setBotState("chat_id", target.chatId);
  if (target.topics.new_pair) setBotState("topic_new_pair", target.topics.new_pair);
  if (target.topics.sleeper) setBotState("topic_sleeper", target.topics.sleeper);
  if (target.topics.post_alert) setBotState("topic_post_alert", target.topics.post_alert);
}

bot.command("setup", async (ctx) => {
  const chatId = String(ctx.chat.id);
  target.chatId = chatId;

  const arg = (ctx.message.text.split(/\s+/)[1] ?? "").toLowerCase();
  const threadId = ctx.message.message_thread_id;

  if (!arg) {
    await ctx.reply(
      [
        `Chat ID detected: ${chatId}`,
        "",
        "Inside each topic, run one of:",
        "  /setup new_pair",
        "  /setup sleeper",
        "  /setup post_alert",
      ].join("\n"),
    );
    persistTarget();
    return;
  }
  if (!threadId) {
    await ctx.reply("Run /setup <kind> *inside* the topic thread, not in General.");
    return;
  }
  const tid = String(threadId);
  if (arg === "new_pair") target.topics.new_pair = tid;
  else if (arg === "sleeper") target.topics.sleeper = tid;
  else if (arg === "post_alert") target.topics.post_alert = tid;
  else {
    await ctx.reply("Unknown kind. Use new_pair | sleeper | post_alert.");
    return;
  }
  persistTarget();
  await ctx.reply(
    [
      `Saved: ${arg} → thread ${tid}`,
      "",
      "Current config:",
      `  chat_id        = ${target.chatId}`,
      `  new_pair       = ${target.topics.new_pair || "(unset)"}`,
      `  sleeper        = ${target.topics.sleeper || "(unset)"}`,
      `  post_alert     = ${target.topics.post_alert || "(unset)"}`,
    ].join("\n"),
  );
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    [
      "smart-filter-gmgn status",
      `chat:        ${target.chatId || "(not set — run /setup)"}`,
      `new_pair:    ${target.topics.new_pair || "(not set)"}`,
      `sleeper:     ${target.topics.sleeper || "(not set)"}`,
      `post_alert:  ${target.topics.post_alert || "(not set)"}`,
    ].join("\n"),
  );
});

bot.command(["backtest", "review"], async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const pipelineArg = (parts[0] ?? "all").toLowerCase();
  const windowArg = (parts[1] ?? "24h").toLowerCase();
  const windowMs = parseWindow(windowArg);
  if (!windowMs) {
    await ctx.reply("Usage: /backtest [new_pair|sleeper|all] [24h|3d|7d|14d]");
    return;
  }
  const toMs = Date.now();
  const fromMs = toMs - windowMs;
  await ctx.reply(`Running backtest (${pipelineArg}, ${windowArg})…`);
  const pipelines: ("new_pair" | "sleeper")[] =
    pipelineArg === "all"
      ? ["new_pair", "sleeper"]
      : pipelineArg === "new_pair" || pipelineArg === "sleeper"
        ? [pipelineArg]
        : [];
  if (pipelines.length === 0) {
    await ctx.reply("Unknown pipeline. Use new_pair | sleeper | all.");
    return;
  }
  for (const p of pipelines) {
    await runAndSendDigest({ pipeline: p, fromMs, toMs }, ctx.message.message_id);
  }
});

function parseWindow(arg: string): number | null {
  const m = arg.match(/^(\d+)([hd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === "h") return n * 3600 * 1000;
  if (unit === "d") return n * 24 * 3600 * 1000;
  return null;
}

bot.action(/mute:(.+)/, async (ctx) => {
  const ca = ctx.match[1];
  if (!ca) {
    await ctx.answerCbQuery("No CA");
    return;
  }
  mutedRepo.mute(ca);
  await ctx.answerCbQuery(`Muted ${ca.slice(0, 4)}…${ca.slice(-4)}`);
});

bot.action(/watch:(.+)/, async (ctx) => {
  // Watchlist add via Telegraf is owned by the post-alert watcher;
  // here we only acknowledge so the button doesn't hang.
  await ctx.answerCbQuery("Already on the alert pipeline");
});

bot.catch((err) => {
  logger.error({ err: String(err) }, "telegraf error");
});

export async function startBot(): Promise<void> {
  await bot.launch({ dropPendingUpdates: true });
  logger.info(
    {
      chatId: target.chatId || "(none)",
      topics: target.topics,
    },
    "telegram bot launched",
  );
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
