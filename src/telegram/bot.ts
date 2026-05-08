import { Telegraf } from "telegraf";
import { env } from "../config/env.js";
import { getBotState, setBotState } from "../db/client.js";
import { mutedRepo } from "../db/repos.js";
import { logger } from "../utils/logger.js";
import { runAndSendDigest } from "./digest.js";
import { review } from "../backtester/reviewer.js";
import { loadTemplate } from "../filter/templates.js";
import { StrategyOptimizer } from "../hermes/strategyOptimizer.js";
import type { StrategyReport, OptimizationLoopResult } from "../hermes/strategyOptimizer.js";
import { applyVariant, revertTemplate } from "../hermes/templateMutator.js";
import { escapeMarkdownV2 } from "../utils/format.js";
import type { Pipeline } from "../capture/snapshotter.js";

const TEMPLATE_PATH: Record<Pipeline, () => string> = {
  before_migrated: () => env.TEMPLATE_BEFORE_MIGRATED,
  after_migrated: () => env.TEMPLATE_AFTER_MIGRATED,
  sleeper: () => env.TEMPLATE_SLEEPER,
};

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

bot.command("optimize", async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const pipelineArg = (parts[0] ?? "all").toLowerCase();
  const windowArg = (parts[1] ?? "7d").toLowerCase();
  const windowMs = parseWindow(windowArg);
  if (!windowMs) {
    await ctx.reply("Usage: /optimize [before_migrated|after_migrated|sleeper|all] [24h|3d|7d|14d]");
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

  await ctx.reply(`Running strategy optimizer (${pipelines.join(", ")}, ${windowArg})…`);

  for (const p of pipelines) {
    try {
      if (env.HERMES_ENABLED) {
        const optimizer = new StrategyOptimizer();
        const loopResult = await optimizer.runOptimizationLoop(p, fromMs, toMs);
        const text = buildLoopReport(p, windowArg, loopResult);
        await ctx.reply(text, {
          parse_mode: "MarkdownV2",
          reply_parameters: { message_id: ctx.message.message_id },
        });
      } else {
        const tpl = loadTemplate(TEMPLATE_PATH[p]());
        const summary = review({ pipeline: p, fromMs, toMs });
        if (summary.triggeredCount === 0) {
          await ctx.reply(`No triggered calls for ${p} in ${windowArg}. Extend window.`);
          continue;
        }
        const optimizer = new StrategyOptimizer();
        const report = await optimizer.analyze(summary, [...tpl.scoring, ...tpl.boosters]);
        const text = buildOptimizeReport(p, windowArg, summary.triggeredCount, summary.triggered.winRate, report);
        await ctx.reply(text, {
          parse_mode: "MarkdownV2",
          reply_parameters: { message_id: ctx.message.message_id },
        });
      }
    } catch (err) {
      logger.error({ err: String(err), pipeline: p }, "optimize command failed");
      await ctx.reply(`Optimizer failed for ${p}: ${String(err).slice(0, 120)}`);
    }
  }
});

bot.command("approve", async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const pipelineArg = (parts[0] ?? "").toLowerCase();
  const resolved = PIPELINE_ALIASES[pipelineArg];
  if (!resolved || resolved === "all") {
    await ctx.reply("Usage: /approve [before_migrated|after_migrated|sleeper]");
    return;
  }
  const variantPath = getBotState(`optimizer_pending_variant_${resolved}`);
  if (!variantPath) {
    await ctx.reply(`No pending variant for ${resolved}. Run /optimize first.`);
    return;
  }
  try {
    applyVariant(resolved as Pipeline, variantPath);
    setBotState(`optimizer_pending_variant_${resolved}`, "");
    await ctx.reply(`✅ Variant applied for *${escapeMarkdownV2(resolved)}*\\.`, { parse_mode: "MarkdownV2" });
  } catch (err) {
    await ctx.reply(`Failed: ${String(err).slice(0, 120)}`);
  }
});

bot.command("revert", async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const pipelineArg = (parts[0] ?? "").toLowerCase();
  const resolved = PIPELINE_ALIASES[pipelineArg];
  if (!resolved || resolved === "all") {
    await ctx.reply("Usage: /revert [before_migrated|after_migrated|sleeper]");
    return;
  }
  try {
    const backup = revertTemplate(resolved as Pipeline);
    if (!backup) {
      await ctx.reply(`No backup found for ${resolved}.`);
      return;
    }
    await ctx.reply(`↩️ Template for *${escapeMarkdownV2(resolved)}* reverted from \`${escapeMarkdownV2(backup)}\`\\.`, { parse_mode: "MarkdownV2" });
  } catch (err) {
    await ctx.reply(`Failed: ${String(err).slice(0, 120)}`);
  }
});

function buildLoopReport(
  pipeline: Pipeline,
  window: string,
  result: OptimizationLoopResult,
): string {
  const lines: string[] = [
    `*🔧 STRATEGY OPTIMIZER LOOP*`,
    `Pipeline: \`${escapeMarkdownV2(pipeline)}\` · Window: ${escapeMarkdownV2(window)}`,
    "",
  ];

  if (!result.declined) {
    lines.push(`✅ ${escapeMarkdownV2(result.declineReason)}`);
    return lines.join("\n");
  }

  lines.push(`⚠️ *Decline:* ${escapeMarkdownV2(result.declineReason)}`);
  lines.push("");

  if (result.variants.length === 0) {
    lines.push("_Tidak ada variant yang berhasil_");
    return lines.join("\n");
  }

  lines.push("*Variant Comparison:*");
  lines.push(`\`${"Type".padEnd(12)}${"WR".padStart(6)}${"ROI".padStart(7)}${"n".padStart(5)}${"Scr".padStart(6)}\``);
  for (const v of result.variants) {
    const star = v === result.bestVariant ? "⭐" : "  ";
    lines.push(
      `${star}\`${v.type.padEnd(12)}${(v.winRate * 100).toFixed(1).padStart(5)}%${(v.avgPnlPct * 100).toFixed(1).padStart(6)}%${String(v.triggeredCount).padStart(5)} ${v.score.toFixed(2).padStart(5)}\``,
    );
  }

  lines.push("");
  lines.push(escapeMarkdownV2(result.recommendation));

  if (result.autoApplied) {
    lines.push("");
    lines.push("_Auto\\-applied \\(OPTIMIZER\\_AUTO\\_APPLY=true\\)_");
  }

  return lines.join("\n");
}

function buildOptimizeReport(
  pipeline: Pipeline,
  window: string,
  triggeredCount: number,
  winRate: number,
  report: StrategyReport,
): string {
  const lines: string[] = [];
  lines.push(`*🔧 STRATEGY OPTIMIZER*`);
  lines.push(
    `Pipeline: \`${escapeMarkdownV2(pipeline)}\` · Window: ${escapeMarkdownV2(window)} · n=${triggeredCount} · WR=${escapeMarkdownV2((winRate * 100).toFixed(1))}%`,
  );

  lines.push("");
  lines.push("*Recommendations:*");
  if (report.recommendations.length === 0) {
    lines.push("_Template sudah optimal_");
  } else {
    for (const r of report.recommendations) {
      const icon = r.recommendation === "raise" ? "⬆️" : r.recommendation === "remove" ? "❌" : "⬇️";
      const pts =
        r.suggestedPoints !== undefined
          ? `${r.currentPoints}→${r.suggestedPoints}pts`
          : `${r.currentPoints}pts`;
      lines.push(
        `${icon} \`${escapeMarkdownV2(r.metric)}\` ${escapeMarkdownV2(pts)}`,
      );
      lines.push(`   _${escapeMarkdownV2(r.reason)}_`);
    }
  }

  lines.push("");
  lines.push("*Summary:*");
  lines.push(escapeMarkdownV2(report.summary));

  if (report.geminiNotes) {
    lines.push("");
    lines.push("*Gemini Analysis:*");
    lines.push(escapeMarkdownV2(report.geminiNotes));
  }

  if (report.source === "rule_based") {
    lines.push("");
    lines.push("_\\(Rule\\-based analysis — set HERMES\\_ENABLED\\=true \\+ GEMINI\\_API\\_KEY for AI insights\\)_");
  }

  return lines.join("\n");
}

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
