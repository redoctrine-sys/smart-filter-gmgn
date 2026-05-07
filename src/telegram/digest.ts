import { Input } from "telegraf";
import { bot, target } from "./bot.js";
import { callsToCsv } from "../backtester/csvExport.js";
import { review } from "../backtester/reviewer.js";
import { simulateExit } from "../backtester/exitSim.js";
import { findSimulatedCalls } from "../backtester/engine.js";
import { loadTemplate } from "../filter/templates.js";
import { env } from "../config/env.js";
import { escapeMarkdownV2 } from "../utils/format.js";
import type { BacktestSummary, Outcome, ReviewedCall } from "../backtester/types.js";
import { logger } from "../utils/logger.js";

interface DigestArgs {
  pipeline: "new_pair" | "sleeper";
  fromMs: number;
  toMs: number;
  almostBand?: number;
}

const POST_ALERT_TOPIC = () => target.topics.post_alert;

export async function runAndSendDigest(args: DigestArgs, replyTo?: number): Promise<void> {
  if (!target.chatId) {
    logger.warn("digest skipped — no chat configured");
    return;
  }
  const summary = review(args);

  // Build full call list (re-run cheap path) so we can attach the CSV.
  const tplPath = args.pipeline === "new_pair" ? env.TEMPLATE_NEW_PAIR : env.TEMPLATE_SLEEPER;
  const tpl = loadTemplate(tplPath);
  const calls = findSimulatedCalls({
    pipeline: args.pipeline,
    fromMs: args.fromMs,
    toMs: args.toMs,
    threshold: tpl.score_threshold,
    almostBand: args.almostBand ?? 15,
  });
  const reviewed: ReviewedCall[] = calls.map((c) => ({ ...c, exit: simulateExit(c) }));
  const csv = callsToCsv(summary, reviewed);

  const text = formatDigest(summary);
  const thread = POST_ALERT_TOPIC() ? Number(POST_ALERT_TOPIC()) : undefined;

  try {
    await bot.telegram.sendMessage(target.chatId, text, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      message_thread_id: thread,
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
    });
    if (reviewed.length > 0) {
      const fname = `digest_${args.pipeline}_${new Date(args.fromMs).toISOString().slice(0, 10)}.csv`;
      await bot.telegram.sendDocument(
        target.chatId,
        Input.fromBuffer(Buffer.from(csv, "utf-8"), fname),
        { message_thread_id: thread, caption: `${reviewed.length} calls` },
      );
    }
  } catch (err) {
    logger.error({ err: String(err) }, "digest send failed");
  }
}

function formatDigest(s: BacktestSummary): string {
  const head = s.pipeline === "new_pair" ? "🆕 *NEW PAIR DIGEST*" : "😴 *SLEEPER DIGEST*";
  const fromIso = new Date(s.windowFrom).toISOString().slice(0, 16).replace("T", " ");
  const toIso = new Date(s.windowTo).toISOString().slice(0, 16).replace("T", " ");
  const lines: string[] = [];
  lines.push(`${head}  \`${escapeMarkdownV2(s.templateId)}\``);
  lines.push(`Window: ${escapeMarkdownV2(fromIso)} → ${escapeMarkdownV2(toIso)} \\(UTC\\)`);
  lines.push("");
  lines.push("*Triggered*");
  lines.push(formatStats(s.triggered));
  lines.push("");
  lines.push("*Almost*  \\(score within band of threshold\\)");
  lines.push(formatStats(s.almost));

  if (s.metricCorrelation.length > 0) {
    lines.push("");
    lines.push("*Metric lift* \\(triggered only\\)");
    for (const m of s.metricCorrelation.slice(0, 6)) {
      const lift = (m.lift * 100).toFixed(1);
      const pw = (m.passingWinRate * 100).toFixed(1);
      const fw = (m.failingWinRate * 100).toFixed(1);
      lines.push(
        `• \`${escapeMarkdownV2(m.metric)}\`: ${escapeMarkdownV2(pw)}% vs ${escapeMarkdownV2(fw)}% ` +
          `\\(lift ${escapeMarkdownV2(lift)}pp, n=${m.passingCount}/${m.failingCount}\\)`,
      );
    }
  }

  if (s.topWinners.length > 0) {
    lines.push("");
    lines.push("*Top winners*");
    for (const w of s.topWinners) {
      const pnl = (w.exit.pnlPct * 100).toFixed(1);
      lines.push(
        `• \`${escapeMarkdownV2(w.symbol)}\` ${escapeMarkdownV2(shortCa(w.ca))}  ${escapeMarkdownV2(pnl)}%  ${w.exit.outcome}`,
      );
    }
  }
  if (s.topLosers.length > 0) {
    lines.push("");
    lines.push("*Top losers*");
    for (const l of s.topLosers) {
      const pnl = (l.exit.pnlPct * 100).toFixed(1);
      lines.push(
        `• \`${escapeMarkdownV2(l.symbol)}\` ${escapeMarkdownV2(shortCa(l.ca))}  ${escapeMarkdownV2(pnl)}%  ${l.exit.outcome}`,
      );
    }
  }
  return lines.join("\n");
}

function formatStats(s: ReturnType<typeof review> extends BacktestSummary ? BacktestSummary["triggered"] : never): string {
  if (s.count === 0) return "_no calls_";
  const wr = (s.winRate * 100).toFixed(1);
  const avg = (s.avgPnlPct * 100).toFixed(1);
  const wAvg = (s.weightedAvgPnlPct * 100).toFixed(1);
  const total = s.totalRealizedSol.toFixed(3);
  const dist = formatDistribution(s.outcomeDistribution);
  const tt = s.avgTimeToTpMin === null ? "—" : `${s.avgTimeToTpMin.toFixed(1)}m`;
  return [
    `n=${s.count} · win=${escapeMarkdownV2(wr)}% · avg=${escapeMarkdownV2(avg)}% · w\\.avg=${escapeMarkdownV2(wAvg)}%`,
    `realized=${escapeMarkdownV2(total)} SOL · avg time\\-to\\-TP=${escapeMarkdownV2(tt)}`,
    dist,
  ].join("\n");
}

function formatDistribution(d: Record<Outcome, number>): string {
  const entries = (Object.entries(d) as [Outcome, number][]).filter(([, v]) => v > 0);
  if (entries.length === 0) return "_no exits_";
  return entries
    .map(([k, v]) => `\`${escapeMarkdownV2(k)}\`=${v}`)
    .join(" · ");
}

function shortCa(ca: string): string {
  return ca.length <= 10 ? ca : `${ca.slice(0, 4)}…${ca.slice(-4)}`;
}
