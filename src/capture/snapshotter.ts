import { env } from "../config/env.js";
import { captureScheduleRepo, snapshotsRepo } from "../db/repos.js";
import { FilterEngine } from "../filter/engine.js";
import { buildMetrics } from "../filter/metricsAdapter.js";
import { loadTemplate } from "../filter/templates.js";
import type { FilterTemplate } from "../filter/types.js";
import { gmgnClient } from "../gmgn/client.js";
import { narrativeScore } from "../narrative/gemini.js";
import { logger } from "../utils/logger.js";

/**
 * Periodic snapshot capture for backtesting.
 *
 * Schedule per token (relative to first sight):
 *   0 — 60 min:  every 1 minute   ( 60 captures)
 *   60 — 120 min: every 5 minutes (12 captures)
 *   120 min — 24 h: every 1 hour  (≈22 captures)
 *
 * After ~24h the schedule is marked 'done'. Each capture stores the full
 * snapshot + the filter decision evaluated against the corresponding
 * template, so the backtester can replay decisions later (and re-evaluate
 * with a different template if needed).
 */

export type Pipeline = "before_migrated" | "after_migrated" | "sleeper";

interface PipelineCfg {
  pipeline: Pipeline;
  template: FilterTemplate;
}

const SCHEDULE_BUCKETS = [
  { untilMin: 60, intervalMin: 1 },
  { untilMin: 120, intervalMin: 5 },
  { untilMin: 24 * 60, intervalMin: 60 },
] as const;

function nextCaptureAt(firstSeenAt: number, ageMin: number): number | null {
  for (const bucket of SCHEDULE_BUCKETS) {
    if (ageMin < bucket.untilMin) {
      return firstSeenAt + (ageMin + bucket.intervalMin) * 60_000;
    }
  }
  return null;
}

export class Snapshotter {
  private timer: NodeJS.Timeout | null = null;
  private readonly pipelines: Record<Pipeline, PipelineCfg>;

  constructor() {
    const before = loadTemplate(env.TEMPLATE_BEFORE_MIGRATED);
    const after = loadTemplate(env.TEMPLATE_AFTER_MIGRATED);
    const sleeper = loadTemplate(env.TEMPLATE_SLEEPER);
    this.pipelines = {
      before_migrated: { pipeline: "before_migrated", template: before },
      after_migrated: { pipeline: "after_migrated", template: after },
      sleeper: { pipeline: "sleeper", template: sleeper },
    };
  }

  /** Called by pipelines on first sighting of a token. */
  register(ca: string, pipeline: Pipeline): void {
    const now = Date.now();
    const firstNext = now + SCHEDULE_BUCKETS[0]!.intervalMin * 60_000;
    captureScheduleRepo.upsert(ca, pipeline, now, firstNext);
  }

  start(): void {
    const tick = async () => {
      try {
        await this.runOnce();
      } catch (err) {
        logger.error({ err: String(err) }, "snapshotter tick failed");
      } finally {
        this.timer = setTimeout(tick, 30_000);
      }
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    const due = captureScheduleRepo.due(Date.now(), 25);
    if (due.length === 0) return;

    for (const row of due) {
      const cfg = this.pipelines[row.pipeline as Pipeline];
      if (!cfg) {
        captureScheduleRepo.finish(row.ca, row.pipeline);
        continue;
      }
      try {
        const snap = await gmgnClient.enrich(row.ca);
        if (!snap) {
          this.advance(row.ca, row.pipeline, row.first_seen_at, Date.now());
          continue;
        }
        const smartMoney = await gmgnClient.smartMoneyBuysLastHour(row.ca);
        const narrative =
          row.pipeline === "sleeper" ? await narrativeScore(snap.summary) : undefined;
        const metrics = buildMetrics(snap, {
          smartMoneyBuys: smartMoney,
          narrativeScore: narrative?.score,
        });
        const decision = new FilterEngine(cfg.template).evaluate(metrics);
        const ageMin = (Date.now() - row.first_seen_at) / 60_000;
        snapshotsRepo.insert({
          ca: row.ca,
          pipeline: row.pipeline,
          templateId: cfg.template.id,
          capturedAt: Date.now(),
          ageMinutes: ageMin,
          priceUsd: snap.summary.priceUsd,
          marketCapUsd: snap.summary.marketCapUsd,
          score: decision.score,
          hardPass: decision.reason !== "hard_rule_failed",
          triggered: decision.passed,
          snapshot: snap,
          decision,
          narrativeScore: narrative?.score ?? null,
        });
      } catch (err) {
        logger.warn({ ca: row.ca, err: String(err) }, "snapshotter: enrich failed");
      } finally {
        this.advance(row.ca, row.pipeline, row.first_seen_at, Date.now());
      }
    }
  }

  private advance(ca: string, pipeline: string, firstSeenAt: number, now: number): void {
    const ageMin = (now - firstSeenAt) / 60_000;
    const next = nextCaptureAt(firstSeenAt, ageMin);
    if (next === null) {
      captureScheduleRepo.finish(ca, pipeline);
      return;
    }
    captureScheduleRepo.advance(ca, pipeline, next);
  }
}
