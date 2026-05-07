import { Telegraf } from "telegraf";
import { env } from "../config/env.js";
import { getBotState, setBotState } from "../db/client.js";
import { mutedRepo } from "../db/repos.js";
import { logger } from "../utils/logger.js";
import { runAndSendDigest } from "./digest.js";
import type { Pipeline } from "../capture/snapshotter.js";

export const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

/**
 * Auto-detected target chat + topics. Hydrated from .env on boot, but the
 * `/setup` command (run inside the supergroup) overrides them and persists to
 * the bot_state table so restarts pick them up automatically.
 */
export const target = {
  chatId: env.TELEGRAM_CHAT_ID || getBotState("chat_id") || "",
  topics: {
    before_migrated:
      env.TELEGRAM_TOPIC_BEFORE_MIGRATED || getBotState("topic_before_migrated") || "",
    after_migrated:
      env.TELEGRAM_TOPIC_AFTER_MIGRATED || getBotState("topic_after_migrated") || "",
    sleeper: env.TELEGRAM_TOPIC_SLEEPER || getBotState("topic_sleeper") || "",
    post_alert: env.TELEGRAM_TOPIC_POST_ALERT || getBotState("topic_post_alert") || "",
  },
};

const TOPIC_KINDS = ["before_migrated", "after_migrated", "sleeper", "post_alert"] as const;
type TopicKind = (typeof TOPIC_KINDS)[number];

function persistTarget(): void {
  if (target.chatId) setBotState("chat_id", target.chatId);
  for (const k of TOPIC_KINDS) {
    if (target.topics[k]) setBotState(`topic_${k}`, target.topics[k]);
  }
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
        "  /setup before_migrated",
        "  /setup after_migrated",
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
  if (!TOPIC_KINDS.includes(arg as TopicKind)) {
    await ctx.reply(`Unknown kind. Use ${TOPIC_KINDS.join(" | ")}.`);
    return;
  }
  const tid = String(threadId);
  target.topics[arg as TopicKind] = tid;
  persistTarget();
  await ctx.reply(
    [
      `Saved: ${arg} → thread ${tid}`,
      "",
      "Current config:",
      `  chat_id          = ${target.chatId}`,
      `  before_migrated  = ${target.topics.before_migrated || "(unset)"}`,
      `  after_migrated   = ${target.topics.after_migrated || "(unset)"}`,
      `  sleeper          = ${target.topics.sleeper || "(unset)"}`,
      `  post_alert       = ${target.topics.post_alert || "(unset)"}`,
    ].join("\n"),
  );
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    [
      "smart-filter-gmgn status",
      `chat:             ${target.chatId || "(not set — run /setup)"}`,
      `before_migrated:  ${target.topics.before_migrated || "(not set)"}`,
      `after_migrated:   ${target.topics.after_migrated || "(not set)"}`,
      `sleeper:          ${target.topics.sleeper || "(not set)"}`,
      `post_alert:       ${target.topics.post_alert || "(not set)"}`,
    ].join("\n"),
  );
});

const ALL_PIPELINES: Pipeline[] = ["before_migrated", "after_migrated", "sleeper"];
const PIPELINE_ALIASES: Record<string, Pipeline | "all"> = {
  before: "before_migrated",
  before_migrated: "before_migrated",
  pre: "before_migrated",
  pre_migrated: "before_migrated",
  after: "after_migrated",
  after_migrated: "after_migrated",
  post: "after_migrated",
  post_migrated: "after_migrated",
  sleeper: "sleeper",
  all: "all",
};

bot.command(["backtest", "review"], async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const pipelineArg = (parts[0] ?? "all").toLowerCase();
  const windowArg = (parts[1] ?? "24h").toLowerCase();
  const windowMs = parseWindow(windowArg);
  if (!windowMs) {
    await ctx.reply(
      "Usage: /backtest [before_migrated|after_migrated|sleeper|all] [24h|3d|7d|14d]",
    );
    return;
  }
  const resolved = PIPELINE_ALIASES[pipelineArg];
  if (!resolved) {
    await ctx.reply(`Unknown pipeline '${pipelineArg}'. Try: ${Object.keys(PIPELINE_ALIASES).join(", ")}.`);
    return;
  }
  const toMs = Date.now();
  const fromMs = toMs - windowMs;
  const pipelines: Pipeline[] = resolved === "all" ? [...ALL_PIPELINES] : [resolved];
  await ctx.reply(`Running backtest (${pipelines.join(", ")}, ${windowArg})…`);
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
