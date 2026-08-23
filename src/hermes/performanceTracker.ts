import { db } from "../db/client.js";
import type { Pipeline } from "../capture/snapshotter.js";
import type { BacktestSummary } from "../backtester/types.js";

const WIB_OFFSET_MS = 7 * 3600 * 1000;
const ONE_WEEK_MS = 7 * 24 * 3600 * 1000;
const DECLINE_THRESHOLD = 0.15; // >15pp drop in avgPnlPct triggers optimization

function getWeekStartMs(ms: number = Date.now()): number {
  const wib = new Date(ms + WIB_OFFSET_MS);
  const day = wib.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  const wibMondayUtc = Date.UTC(
    wib.getUTCFullYear(),
    wib.getUTCMonth(),
    wib.getUTCDate() - daysFromMonday,
    0, 0, 0,
  );
  return wibMondayUtc - WIB_OFFSET_MS;
}

export interface WeeklyStats {
  pipeline: Pipeline;
  weekStartMs: number;
  triggeredCount: number;
  winRate: number;
  avgPnlPct: number;
  totalRealizedSol: number;
  recordedAt: number;
}

export interface CompareResult {
  decline: boolean;
  reason: string;
  currentWeek: WeeklyStats | null;
  previousWeek: WeeklyStats | null;
  roiDropPct: number | null;
}

interface StatsRow {
  pipeline: string;
  week_start_ms: number;
  triggered_count: number;
  win_rate: number;
  avg_pnl_pct: number;
  total_realized_sol: number;
  recorded_at: number;
}

function rowToStats(pipeline: Pipeline, row: StatsRow): WeeklyStats {
  return {
    pipeline,
    weekStartMs: row.week_start_ms,
    triggeredCount: row.triggered_count,
    winRate: row.win_rate,
    avgPnlPct: row.avg_pnl_pct,
    totalRealizedSol: row.total_realized_sol,
    recordedAt: row.recorded_at,
  };
}

export class PerformanceTracker {
  record(pipeline: Pipeline, summary: BacktestSummary): void {
    const weekStartMs = getWeekStartMs();
    db.prepare(`
      INSERT INTO optimizer_weekly_stats
        (pipeline, week_start_ms, triggered_count, win_rate, avg_pnl_pct, total_realized_sol, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pipeline, week_start_ms) DO UPDATE SET
        triggered_count = excluded.triggered_count,
        win_rate        = excluded.win_rate,
        avg_pnl_pct     = excluded.avg_pnl_pct,
        total_realized_sol = excluded.total_realized_sol,
        recorded_at     = excluded.recorded_at
    `).run(
      pipeline,
      weekStartMs,
      summary.triggeredCount,
      summary.triggered.winRate,
      summary.triggered.avgPnlPct,
      summary.triggered.totalRealizedSol,
      Date.now(),
    );
  }

  compare(pipeline: Pipeline): CompareResult {
    const currentWeekStart = getWeekStartMs();
    const prevWeekStart = currentWeekStart - ONE_WEEK_MS;

    const curr = db.prepare(
      `SELECT * FROM optimizer_weekly_stats WHERE pipeline = ? AND week_start_ms = ?`,
    ).get(pipeline, currentWeekStart) as StatsRow | undefined;

    const prev = db.prepare(
      `SELECT * FROM optimizer_weekly_stats WHERE pipeline = ? AND week_start_ms = ?`,
    ).get(pipeline, prevWeekStart) as StatsRow | undefined;

    const current = curr ? rowToStats(pipeline, curr) : null;
    const previous = prev ? rowToStats(pipeline, prev) : null;

    if (!current || !previous) {
      return {
        decline: false,
        reason: "Tidak cukup data historis (butuh minimal 2 minggu)",
        currentWeek: current,
        previousWeek: previous,
        roiDropPct: null,
      };
    }

    const roiDropPct = current.avgPnlPct - previous.avgPnlPct;
    const decline = roiDropPct < -DECLINE_THRESHOLD;

    return {
      decline,
      reason: decline
        ? `ROI turun ${(roiDropPct * 100).toFixed(1)}pp dari minggu lalu ` +
          `(${(previous.avgPnlPct * 100).toFixed(1)}% → ${(current.avgPnlPct * 100).toFixed(1)}%)`
        : `Performa stabil — ROI ${(current.avgPnlPct * 100).toFixed(1)}%, delta ${(roiDropPct * 100).toFixed(1)}pp`,
      currentWeek: current,
      previousWeek: previous,
      roiDropPct,
    };
  }

  recentWeeks(pipeline: Pipeline, n = 4): WeeklyStats[] {
    const rows = db.prepare(
      `SELECT * FROM optimizer_weekly_stats WHERE pipeline = ? ORDER BY week_start_ms DESC LIMIT ?`,
    ).all(pipeline, n) as StatsRow[];
    return rows.map((r) => rowToStats(pipeline, r));
  }
}
