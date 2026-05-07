import { Markup } from "telegraf";
import { bot, target } from "./bot.js";
import { logger } from "../utils/logger.js";
import {
  dexscreenerLink,
  gmgnTokenLink,
  jupiterLink,
  solscanLink,
  trojanLink,
} from "../utils/links.js";
import {
  escapeMarkdownV2,
  formatPct,
  formatSol,
  formatSolPair,
  formatUsd,
  shortAddr,
} from "../utils/format.js";
import type { TokenSnapshot } from "../gmgn/types.js";
import type { FilterDecision } from "../filter/types.js";

type Pipeline = "new_pair" | "sleeper" | "post_alert";

function topicId(pipeline: Pipeline): number | undefined {
  const raw =
    pipeline === "new_pair"
      ? target.topics.new_pair
      : pipeline === "sleeper"
        ? target.topics.sleeper
        : target.topics.post_alert;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function buildBody(snap: TokenSnapshot, decision: FilterDecision, extras: { narrative?: number }): string {
  const s = snap.summary;
  const sec = snap.security;
  const lines: string[] = [];
  const head = decision.pipeline === "new_pair" ? "🆕 *NEW PAIR*" : "😴 *SLEEPER*";
  lines.push(`${head} — *${escapeMarkdownV2(s.symbol || "?")}*  \`${escapeMarkdownV2(s.name)}\``);
  lines.push(`CA: \`${s.ca}\``);
  lines.push("");
  lines.push(`MC: ${escapeMarkdownV2(formatUsd(s.marketCapUsd))} · LP: ${escapeMarkdownV2(formatUsd(s.liquidityUsd))} · Age: ${escapeMarkdownV2(s.ageHours ? s.ageHours.toFixed(1) + "h" : "—")}`);
  lines.push(
    `Bundler: ${escapeMarkdownV2(formatPct(sec.bundlerPct))} · Top10: ${escapeMarkdownV2(formatPct(sec.top10HolderPct))} · Dev: ${escapeMarkdownV2(formatPct(sec.devHoldingPct))}`,
  );
  lines.push(
    `Fee: ${escapeMarkdownV2(formatSol(sec.globalFeeSol))} \\(${escapeMarkdownV2(sec.globalFeeStatus)}\\) · DexPaid: ${escapeMarkdownV2(sec.dexPaidStatus)}`,
  );
  if (extras.narrative !== undefined) {
    lines.push(`Narrative: ${escapeMarkdownV2(extras.narrative.toFixed(1))}/10`);
  }
  const wc = snap.walletComposition;
  if (wc.top10.n > 0 || wc.top100.n > 0) {
    lines.push(
      `Top10  buy/sell: ${escapeMarkdownV2(formatSolPair(wc.top10.avgBuySol, wc.top10.avgSellSol))} · ` +
        `bal avg/max: ${escapeMarkdownV2(formatSolPair(wc.top10.avgSolBalance, wc.top10.maxSolBalance))}`,
    );
    lines.push(
      `Top100 buy/sell: ${escapeMarkdownV2(formatSolPair(wc.top100.avgBuySol, wc.top100.avgSellSol))} · ` +
        `bal avg/max: ${escapeMarkdownV2(formatSolPair(wc.top100.avgSolBalance, wc.top100.maxSolBalance))}`,
    );
  }
  lines.push("");
  lines.push(`Score: *${decision.score}/100* \\(threshold ${decision.threshold}\\)`);
  const passing = decision.scoreEvals.concat(decision.boosterEvals).filter((e) => e.passed);
  if (passing.length > 0) {
    lines.push(
      "Hits: " +
        passing.map((e) => `${escapeMarkdownV2(e.metric)}\\+${e.pointsAwarded}`).join(", "),
    );
  }
  lines.push("");
  lines.push(`[GMGN](${gmgnTokenLink(s.ca)}) · [Dex](${dexscreenerLink(s.ca)}) · [Solscan](${solscanLink(s.ca)})`);
  return lines.join("\n");
}

export interface DispatchResult {
  messageId: number | null;
  threadId: number | null;
}

export async function sendAlert(
  pipeline: "new_pair" | "sleeper",
  snap: TokenSnapshot,
  decision: FilterDecision,
  extras: { narrative?: number } = {},
): Promise<DispatchResult> {
  if (!target.chatId) {
    logger.warn("No TELEGRAM_CHAT_ID set — alert dropped. Run /setup in the group.");
    return { messageId: null, threadId: null };
  }
  const thread = topicId(pipeline);
  const body = buildBody(snap, decision, extras);
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.url("⚡ Trojan", trojanLink(snap.summary.ca)),
      Markup.button.url("🪐 Jupiter", jupiterLink(snap.summary.ca)),
    ],
    [
      Markup.button.callback("👁  Watch", `watch:${snap.summary.ca}`),
      Markup.button.callback("🔇 Mute", `mute:${snap.summary.ca}`),
    ],
  ]);
  try {
    const msg = await bot.telegram.sendMessage(target.chatId, body, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      message_thread_id: thread,
      ...kb,
    });
    return { messageId: msg.message_id, threadId: thread ?? null };
  } catch (err) {
    logger.error(
      { err: String(err), ca: snap.summary.ca, pipeline },
      "sendAlert failed",
    );
    return { messageId: null, threadId: null };
  }
}

export async function sendPostAlert(
  ca: string,
  kind: "tp" | "sl" | "rug",
  label: string,
  detail: string,
  replyTo?: number | null,
): Promise<void> {
  if (!target.chatId) return;
  const thread = topicId("post_alert");
  const emoji = kind === "tp" ? "🟢" : kind === "sl" ? "🔻" : "🚨";
  const head = kind === "tp" ? "TAKE PROFIT" : kind === "sl" ? "STOP LOSS" : "ANTI-RUG";
  const body = [
    `${emoji} *${head}* — ${escapeMarkdownV2(label)}`,
    `CA: \`${ca}\` \\(${shortAddr(ca)}\\)`,
    "",
    escapeMarkdownV2(detail),
    "",
    `[GMGN](${gmgnTokenLink(ca)}) · [Dex](${dexscreenerLink(ca)})`,
  ].join("\n");
  try {
    await bot.telegram.sendMessage(target.chatId, body, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      message_thread_id: thread,
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
    });
  } catch (err) {
    logger.error({ err: String(err), ca, kind }, "sendPostAlert failed");
  }
}
