import { env } from "../config/env.js";
import { snapshotter } from "../capture/index.js";
import {
  alertsRepo,
  mutedRepo,
  recentTokenMetaRepo,
  tokensSeenRepo,
  watchlistRepo,
} from "../db/repos.js";
import { FilterEngine } from "../filter/engine.js";
import { buildMetrics } from "../filter/metricsAdapter.js";
import { loadTemplate } from "../filter/templates.js";
import { gmgnClient } from "../gmgn/client.js";
import { detectCluster, detectCopycat } from "../narrative/copycat.js";
import { sendAlert } from "../telegram/dispatcher.js";
import { logger } from "../utils/logger.js";

const PIPELINE = "after_migrated";

/**
 * Post-migration sweet spot — token already migrated to Raydium and the
 * sniper/insider exit dump is well underway (drop_from_ath_pct <= -0.5).
 *
 * This is where TA actually works (per Ponyin/Badidoyo/Andri/Pradono),
 * so the template balances on-chain integrity with TA confirmation:
 * 3 candle confirm, Fib 0.786, Stoch RSI safe.
 */
export class AfterMigratedPipeline {
  private readonly engine: FilterEngine;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    const tpl = loadTemplate(env.TEMPLATE_AFTER_MIGRATED);
    if (tpl.pipeline !== "after_migrated") {
      throw new Error(`Template ${tpl.id} is not for after_migrated pipeline`);
    }
    this.engine = new FilterEngine(tpl);
    logger.info(
      { template: tpl.id, threshold: tpl.score_threshold },
      "after_migrated pipeline ready",
    );
  }

  start(): void {
    const tick = async () => {
      try {
        await this.runOnce();
      } catch (err) {
        logger.error({ err: String(err) }, "after_migrated tick failed");
      } finally {
        this.timer = setTimeout(tick, env.AFTER_MIGRATED_POLL_MS);
      }
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    const candidates = await gmgnClient.fetchRecentlyMigrated({
      limit: 80,
      maxAgeHours: env.AFTER_MIGRATED_MAX_AGE_HOURS,
    });
    if (candidates.length === 0) return;

    for (const shallow of candidates) {
      const ca = shallow.summary.ca;
      if (!ca) continue;
      if (mutedRepo.is(ca)) continue;
      if (tokensSeenRepo.has(ca, PIPELINE)) continue;

      snapshotter.register(ca, PIPELINE);

      const enriched = await gmgnClient.enrich(ca);
      if (!enriched) continue;
      if (enriched.summary.migrationStatus !== "migrated") continue;

      const smartMoney = await gmgnClient.smartMoneyBuysLastHour(ca);
      const firstSeenAt = Date.now();
      recentTokenMetaRepo.upsert({
        ca,
        symbol: enriched.summary.symbol || null,
        name: enriched.summary.name || null,
        description: enriched.summary.description ?? null,
        pipeline: PIPELINE,
        firstSeenAt,
      });

      const candidate = {
        name: enriched.summary.name,
        symbol: enriched.summary.symbol,
        description: enriched.summary.description ?? null,
      };
      const cluster = detectCluster({ ca, candidate, firstSeenAt });
      const copycat = detectCopycat(candidate);

      const metrics = buildMetrics(enriched, {
        smartMoneyBuys: smartMoney,
        isOldestInCluster: cluster.isOldestInCluster,
        clusterSize: cluster.clusterSize,
        earlierSimilarCount: cluster.earlierSimilarCount,
        isCopycatOfRunner: copycat.isCopycatOfRunner,
        copycatSimilarity: copycat.similarity,
        copycatRunnerSymbol: copycat.matchedRunner?.symbol ?? undefined,
      });
      const decision = this.engine.evaluate(metrics);

      if (!decision.passed) {
        if (decision.reason === "hard_rule_failed") tokensSeenRepo.mark(ca, PIPELINE);
        continue;
      }

      tokensSeenRepo.mark(ca, PIPELINE);
      const result = await sendAlert("after_migrated", enriched, decision, {
        isOldestInCluster: cluster.isOldestInCluster,
        clusterSize: cluster.clusterSize,
        isCopycatOfRunner: copycat.isCopycatOfRunner,
        copycatRunnerSymbol: copycat.matchedRunner?.symbol,
        copycatSimilarity: copycat.similarity,
      });
      const alertId = alertsRepo.insert({
        ca,
        pipeline: PIPELINE,
        templateId: decision.templateId,
        score: decision.score,
        payload: { snapshot: enriched, decision },
        messageId: result.messageId,
      });
      watchlistRepo.add({
        ca,
        pipeline: PIPELINE,
        alertId,
        entryPriceUsd: enriched.summary.priceUsd,
        entryMcUsd: enriched.summary.marketCapUsd,
        threadMessageId: result.messageId,
      });
      logger.info(
        {
          ca,
          score: decision.score,
          mc: enriched.summary.marketCapUsd,
          drop: enriched.candles.dropFromAthPct,
          stochK1m: enriched.candles.stochRsi1m.k,
        },
        "after_migrated ALERT",
      );
    }
  }
}
