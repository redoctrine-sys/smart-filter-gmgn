import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { StrategyOptimizer } from "./strategyOptimizer.js";
import { bot, target } from "../telegram/bot.js";
import { escapeMarkdownV2 } from "../utils/format.js";
import type { Pipeline } from "../capture/snapshotter.js";
import type { OptimizationLoopResult } from "./strategyOptimizer.js";

const TARGET_DAY_WIB = 1; // Monday
const TARGET_HOUR_WIB = 8;
const WIB_OFFSET_MS = 7 * 3600 * 1000;
const ONE_DAY_MS = 24 * 3600 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

function nextMondayRunMs(now = Date.now()): number {
  const nowWib = new Date(now + WIB_OFFSET_MS);
  const day = nowWib.getUTCDay();

  const todayWib8 =
    Date.UTC(nowWib.getUTCFullYear(), nowWib.getUTCMonth(), nowWib.getUTCDate(), TARGET_HOUR_WIB, 0, 0) -
    WIB_OFFSET_MS;

  if (day === TARGET_DAY_WIB && now < todayWib8) return todayWib8;

  const daysUntilMonday = (8 - day) % 7 || 7;
  return (
    Date.UTC(nowWib.getUTCFullYear(), nowWib.getUTCMonth(), nowWib.getUTCDate() + daysUntilMonday, TARGET_HOUR_WIB, 0, 0) -
    WIB_OFFSET_MS
  );
}

export function startWeeklyCron(): void {
  if (!env.HERMES_ENABLED) return;

  const schedule = () => {
    const next = nextMondayRunMs();
    const waitMs = next - Date.now();
    logger.info({ runAt: new Date(next).toISOString(), waitMs }, "weekly optimizer cron scheduled");
    setTimeout(async () => {
      try {
        await runWeeklyOptimization();
      } catch (err) {
        logger.error({ err: String(err) }, "weekly optimizer run failed");
      } finally {
        schedule();
      }
    }, waitMs);
  };

  schedule();
}

async function runWeeklyOptimization(): Promise<void> {
  logger.info("weekly optimizer starting");
  const toMs = Date.now();
  const fromMs = toMs - ONE_WEEK_MS;
  const pipelines: Pipeline[] = ["before_migrated", "after_migrated", "sleeper"];
  const optimizer = new StrategyOptimizer();

  for (const pipeline of pipelines) {
    try {
      const result = await optimizer.runOptimizationLoop(pipeline, fromMs, toMs);
      if (!result.declined) {
        logger.info({ pipeline, reason: result.declineReason }, "weekly optimizer: no decline, skipping");
        continue;
      }
      if (target.chatId) {
        const text = buildWeeklyReport(pipeline, result);
        await bot.telegram.sendMessage(target.chatId, text, { parse_mode: "MarkdownV2" });
      }
    } catch (err) {
      logger.error({ err: String(err), pipeline }, "weekly optimizer pipeline failed");
    }
  }
}

function buildWeeklyReport(pipeline: Pipeline, result: OptimizationLoopResult): string {
  const lines: string[] = [
    `*🔧 WEEKLY OPTIMIZER — ${escapeMarkdownV2(pipeline.toUpperCase())}*`,
    `⚠️ Decline detected: ${escapeMarkdownV2(result.declineReason)}`,
    "",
  ];

  if (result.variants.length === 0) {
    lines.push("_Tidak ada variant yang berhasil di\\-backtest_");
    return lines.join("\n");
  }

  lines.push("*Variant Comparison:*");
  lines.push(`\`${"Type".padEnd(12)} ${"WR%".padStart(6)} ${"ROI%".padStart(7)} ${"n".padStart(4)} ${"Score".padStart(7)}\``);
  lines.push(`\`${"─".repeat(40)}\``);

  for (const v of result.variants) {
    const isBest = v === result.bestVariant;
    const tag = isBest ? " ⭐" : "";
    lines.push(
      `\`${v.type.padEnd(12)} ${(v.winRate * 100).toFixed(1).padStart(5)}% ${(v.avgPnlPct * 100).toFixed(1).padStart(6)}% ${String(v.triggeredCount).padStart(4)} ${v.score.toFixed(3).padStart(7)}\`${tag}`,
    );
  }

  lines.push("");
  lines.push(escapeMarkdownV2(result.recommendation));

  if (result.autoApplied) {
    lines.push("");
    lines.push("✅ _Auto\\-applied \\(OPTIMIZER\\_AUTO\\_APPLY=true\\)_");
  } else {
    lines.push("");
    lines.push(`_Gunakan /approve ${escapeMarkdownV2(pipeline)} untuk apply variant terbaik_`);
  }

  return lines.join("\n");
}
