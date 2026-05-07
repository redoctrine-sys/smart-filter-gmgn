import { env } from "../config/env.js";
import { snapshotsRepo } from "../db/repos.js";
import type { TokenSnapshot } from "../gmgn/types.js";
import type { Outcome, SimulatedCall, SimulatedExit } from "./types.js";

/**
 * Walk forward through the captured snapshots after entry and apply the
 * post-alert ladder + anti-rug triggers exactly like production. Returns the
 * first decisive outcome (TP / SL / rug) within the lifecycle window, or
 * "expired" if none triggered.
 *
 * Position sizing (score-weighted): size_sol = clamp(score/threshold, 0.5, 2.5).
 * realized_sol = size_sol * pnlPct.
 */

const TP_LADDER: { outcome: Outcome; multiplier: number }[] = [
  { outcome: "tp_2x", multiplier: 2 },
  { outcome: "tp_5x", multiplier: 5 },
  { outcome: "tp_10x", multiplier: 10 },
];

const SL_LADDER: { outcome: Outcome; drop: number; severity: "warning" | "hard" }[] = [
  { outcome: "sl_warning", drop: -0.3, severity: "warning" },
  { outcome: "sl_hard", drop: -0.5, severity: "hard" },
];

const LIFECYCLE_HOURS = 24;

interface SimOptions {
  baseSizeSol: number;
  minSizeMultiplier: number; // 0.5
  maxSizeMultiplier: number; // 2.5
  lifecycleHours?: number;
}

const DEFAULT_OPTIONS: SimOptions = {
  baseSizeSol: env.BACKTEST_BASE_SIZE_SOL,
  minSizeMultiplier: 0.5,
  maxSizeMultiplier: 2.5,
  lifecycleHours: LIFECYCLE_HOURS,
};

export function simulateExit(call: SimulatedCall, opts: Partial<SimOptions> = {}): SimulatedExit {
  const cfg = { ...DEFAULT_OPTIONS, ...opts };
  const lifecycleMs = (cfg.lifecycleHours ?? LIFECYCLE_HOURS) * 3600 * 1000;
  const sizeSol = computeSize(call, cfg);

  if (call.entryPriceUsd === null || call.entryPriceUsd <= 0) {
    return emptyExit(sizeSol, "expired", null);
  }

  const fromMs = call.entryAt;
  const toMs = call.entryAt + lifecycleMs;
  const forward = snapshotsRepo.forwardForToken(call.ca, fromMs, toMs);

  if (forward.length === 0) {
    return emptyExit(sizeSol, "expired", null);
  }

  let maxGainPct = 0;
  let maxDrawdownPct = 0;
  let firstOutcome: { outcome: Outcome; price: number; at: number } | null = null;
  let lastSeenPrice: number | null = null;

  for (const row of forward) {
    if (row.captured_at <= call.entryAt) continue;
    const price = row.price_usd;
    if (price !== null) {
      lastSeenPrice = price;
      const change = (price - call.entryPriceUsd) / call.entryPriceUsd;
      if (change > maxGainPct) maxGainPct = change;
      if (change < maxDrawdownPct) maxDrawdownPct = change;

      // TP — pick the highest TP that already hit at this price; pricing the
      // entire position at the highest hit gives an optimistic-but-bounded
      // estimate (production sells partials, but for review we mark the call
      // resolved at the highest TP reached).
      let tpHit: { outcome: Outcome; multiplier: number } | null = null;
      for (const tp of TP_LADDER) {
        if (price >= call.entryPriceUsd * tp.multiplier) tpHit = tp;
      }
      if (tpHit && (firstOutcome === null || isBetterTp(tpHit.outcome, firstOutcome.outcome))) {
        firstOutcome = { outcome: tpHit.outcome, price, at: row.captured_at };
      }

      // SL — only set if no TP has resolved yet (TP wins ties on the same row).
      if (!firstOutcome) {
        for (const sl of SL_LADDER) {
          if (change <= sl.drop) {
            firstOutcome = { outcome: sl.outcome, price, at: row.captured_at };
            if (sl.severity === "hard") break;
          }
        }
      }
    }

    // Anti-rug from snapshot
    const snapshot = JSON.parse(row.snapshot_json) as TokenSnapshot;
    const sec = snapshot.security;
    if (!firstOutcome && sec) {
      // Heuristic: massive top10 shift or LP burn flag flipping bad means rug.
      if (sec.lpBurnedPct !== null && sec.lpBurnedPct < 50) {
        firstOutcome = {
          outcome: "rug_lp_unlocked",
          price: lastSeenPrice ?? call.entryPriceUsd,
          at: row.captured_at,
        };
      }
    }

    if (firstOutcome && firstOutcome.outcome === "sl_hard") break;
    if (firstOutcome && firstOutcome.outcome === "tp_10x") break;
  }

  if (!firstOutcome) {
    const exitPrice = lastSeenPrice;
    const pnl = exitPrice ? (exitPrice - call.entryPriceUsd) / call.entryPriceUsd : 0;
    return {
      outcome: "expired",
      exitAt: forward[forward.length - 1]?.captured_at ?? null,
      exitPriceUsd: exitPrice,
      pnlPct: pnl,
      maxGainPct,
      maxDrawdownPct,
      timeToOutcomeMin: null,
      sizeSol,
      realizedSol: sizeSol * pnl,
    };
  }

  const pnlPct = (firstOutcome.price - call.entryPriceUsd) / call.entryPriceUsd;
  return {
    outcome: firstOutcome.outcome,
    exitAt: firstOutcome.at,
    exitPriceUsd: firstOutcome.price,
    pnlPct,
    maxGainPct,
    maxDrawdownPct,
    timeToOutcomeMin: (firstOutcome.at - call.entryAt) / 60_000,
    sizeSol,
    realizedSol: sizeSol * pnlPct,
  };
}

function computeSize(call: SimulatedCall, cfg: SimOptions): number {
  const ratio = call.score / Math.max(1, call.threshold);
  const clamped = Math.max(cfg.minSizeMultiplier, Math.min(cfg.maxSizeMultiplier, ratio));
  return Math.round(cfg.baseSizeSol * clamped * 1000) / 1000;
}

function emptyExit(sizeSol: number, outcome: Outcome, exitAt: number | null): SimulatedExit {
  return {
    outcome,
    exitAt,
    exitPriceUsd: null,
    pnlPct: 0,
    maxGainPct: 0,
    maxDrawdownPct: 0,
    timeToOutcomeMin: null,
    sizeSol,
    realizedSol: 0,
  };
}

function isBetterTp(a: Outcome, b: Outcome): boolean {
  const order: Outcome[] = ["tp_2x", "tp_5x", "tp_10x"];
  return order.indexOf(a) > order.indexOf(b);
}
