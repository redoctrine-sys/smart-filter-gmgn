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
import type { Pipeline } from "../capture/snapshotter.js";

type DispatchTopic = Pipeline | "post_alert";

function topicId(t: DispatchTopic): number | undefined {
  const raw =
    t === "before_migrated"
      ? target.topics.before_migrated
      : t === "after_migrated"
        ? target.topics.after_migrated
        : t === "sleeper"
          ? target.topics.sleeper
          : target.topics.post_alert;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

interface AlertExtras {
  narrative?: number;
  isOldestInCluster?: boolean;
  clusterSize?: number;
  isCopycatOfRunner?: boolean;
  copycatRunnerSymbol?: string;
  copycatSimilarity?: number;
}

function pipelineHeading(pipeline: Pipeline): string {
  switch (pipeline) {
    case "before_migrated":
      return "🌱 *BEFORE MIGRATED*";
    case "after_migrated":
      return "🚀 *AFTER MIGRATED*";
    case "sleeper":
      return "😴 *SLEEPER*";
  }
}

function buildBody(snap: TokenSnapshot, decision: FilterDecision, extras: AlertExtras): string {
  const s = snap.summary;
  const sec = snap.security;
  const c = snap.candles;
  const lines: string[] = [];
  lines.push(`${pipelineHeading(decision.pipeline)} — *${escapeMarkdownV2(s.symbol || "?")}*  \`${escapeMarkdownV2(s.name)}\``);
  lines.push(`CA: \`${s.ca}\``);
  lines.push("");
  lines.push(
    `MC: ${escapeMarkdownV2(formatUsd(s.marketCapUsd))} · LP: ${escapeMarkdownV2(formatUsd(s.liquidityUsd))} · Age: ${escapeMarkdownV2(s.ageHours ? s.ageHours.toFixed(1) + "h" : "—")}`,
  );
  lines.push(
    `Vol 5m/1h/24h: ${escapeMarkdownV2(formatUsd(s.volume5mUsd))} / ${escapeMarkdownV2(formatUsd(s.volume1hUsd))} / ${escapeMarkdownV2(formatUsd(s.volume24hUsd))}`,
  );
  lines.push(
    `Bundler: ${escapeMarkdownV2(formatPct(sec.bundlerPct))} · Top10: ${escapeMarkdownV2(formatPct(sec.top10HolderPct))} · Dev: ${escapeMarkdownV2(formatPct(sec.devHoldingPct))}`,
  );
  lines.push(
    `Fee: ${escapeMarkdownV2(formatSol(sec.globalFeeSol))} \\(${escapeMarkdownV2(sec.globalFeeStatus)}\\) · DexPaid: ${escapeMarkdownV2(sec.dexPaidStatus)}`,
  );

  // TA strip — pipeline-aware Stoch RSI TF (1m for new pair, 5m for sleeper)
  const taParts: string[] = [];
  if (c.dropFromAthPct !== null) {
    taParts.push(`Drop from ATH: ${escapeMarkdownV2((c.dropFromAthPct * 100).toFixed(1))}%`);
  }
  const stoch = decision.pipeline === "sleeper" ? c.stochRsi5m : c.stochRsi1m;
  const stochTf = decision.pipeline === "sleeper" ? "5m" : "1m";
  if (stoch.k !== null) {
    const sig = stoch.signal ?? "neutral";
    const flag = stoch.safe ? "✅" : "⚠️";
    taParts.push(
      `StochRSI \\(${escapeMarkdownV2(stochTf)}\\): ${escapeMarkdownV2(stoch.k.toFixed(0))} ${flag} \\(${escapeMarkdownV2(sig)}\\)`,
    );
  }
  if (c.last3GreenInARow) taParts.push("3🟢 candle confirm");
  if (c.nearFib786) taParts.push("Fib 0\\.786 zone");
  if (taParts.length > 0) lines.push(taParts.join(" · "));

  if (extras.narrative !== undefined) {
    lines.push(`Narrative: ${escapeMarkdownV2(extras.narrative.toFixed(1))}/10`);
  }

  if (decision.pipeline !== "sleeper") {
    const verdicts: string[] = [];
    if (extras.clusterSize !== undefined) {
      if (extras.isOldestInCluster) {
        verdicts.push(
          extras.clusterSize > 1
            ? `🥇 OLDEST in cluster of ${extras.clusterSize}`
            : "🌱 Unique narrative",
        );
      } else if (extras.clusterSize > 1) {
        verdicts.push(`👥 Copycat \\(cluster=${extras.clusterSize}\\)`);
      }
    }
    if (extras.isCopycatOfRunner && extras.copycatRunnerSymbol) {
      const sim = extras.copycatSimilarity ? (extras.copycatSimilarity * 100).toFixed(0) : "?";
      verdicts.push(
        `⚠️ Runner copycat: \`${escapeMarkdownV2(extras.copycatRunnerSymbol)}\` ${escapeMarkdownV2(sim)}%`,
      );
    }
    if (verdicts.length > 0) lines.push(verdicts.join(" · "));
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
  lines.push(`Score: *${decision.score}* \\(threshold ${decision.threshold}\\)`);
  const passing = decision.scoreEvals.concat(decision.boosterEvals).filter((e) => e.passed);
  if (passing.length > 0) {
    lines.push(
      "Hits: " +
        passing.map((e) => `${escapeMarkdownV2(e.metric)}\\+${e.pointsAwarded}`).join(", "),
    );
  }
  lines.push("");
  lines.push(
    `[GMGN](${gmgnTokenLink(s.ca)}) · [Dex](${dexscreenerLink(s.ca)}) · [Solscan](${solscanLink(s.ca)})`,
  );
  return lines.join("\n");
}

export interface DispatchResult {
  messageId: number | null;
  threadId: number | null;
}

export async function sendAlert(
  pipeline: Pipeline,
  snap: TokenSnapshot,
  decision: FilterDecision,
  extras: AlertExtras = {},
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
    logger.error({ err: String(err), ca: snap.summary.ca, pipeline }, "sendAlert failed");
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
