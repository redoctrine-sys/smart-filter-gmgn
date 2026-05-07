import { env } from "../config/env.js";
import { alertsRepo, mutedRepo, tokensSeenRepo, watchlistRepo } from "../db/repos.js";
import { FilterEngine } from "../filter/engine.js";
import { buildMetrics } from "../filter/metricsAdapter.js";
import { loadTemplate } from "../filter/templates.js";
import { gmgnClient } from "../gmgn/client.js";
import { narrativeScore } from "../narrative/gemini.js";
import { sendAlert } from "../telegram/dispatcher.js";
import { logger } from "../utils/logger.js";

const PIPELINE = "sleeper";

export class SleeperPipeline {
  private readonly engine: FilterEngine;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    const tpl = loadTemplate(env.TEMPLATE_SLEEPER);
    if (tpl.pipeline !== "sleeper") {
      throw new Error(`Template ${tpl.id} is not for sleeper pipeline`);
    }
    this.engine = new FilterEngine(tpl);
    logger.info({ template: tpl.id, threshold: tpl.score_threshold }, "sleeper pipeline ready");
  }

  start(): void {
    const tick = async () => {
      try {
        await this.runOnce();
      } catch (err) {
        logger.error({ err: String(err) }, "sleeper tick failed");
      } finally {
        this.timer = setTimeout(tick, env.SLEEPER_POLL_MS);
      }
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    const candidates = await gmgnClient.fetchSleeperCandidates({
      minMcUsd: 7000,
      maxMcUsd: 25000,
      minAgeHours: 24,
      limit: 80,
    });
    if (candidates.length === 0) return;

    for (const shallow of candidates) {
      const ca = shallow.summary.ca;
      if (!ca) continue;
      if (mutedRepo.is(ca)) continue;

      const enriched = await gmgnClient.enrich(ca);
      if (!enriched) continue;
      const smartMoney = await gmgnClient.smartMoneyBuysLastHour(ca);
      const narrative = await narrativeScore(enriched.summary);
      const metrics = buildMetrics(enriched, {
        smartMoneyBuys: smartMoney,
        narrativeScore: narrative.score,
      });
      const decision = this.engine.evaluate(metrics);

      if (!decision.passed) {
        logger.debug(
          { ca, reason: decision.reason, score: decision.score },
          "sleeper below threshold or hard-rule fail",
        );
        continue;
      }
      // Sleeper can re-fire if condition reappears — only dedup within 24h.
      if (tokensSeenRepo.has(ca, PIPELINE)) continue;
      tokensSeenRepo.mark(ca, PIPELINE);

      const result = await sendAlert("sleeper", enriched, decision, {
        narrative: narrative.score,
      });
      const alertId = alertsRepo.insert({
        ca,
        pipeline: PIPELINE,
        templateId: decision.templateId,
        score: decision.score,
        payload: { snapshot: enriched, decision, narrative },
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
          narrative: narrative.score,
          mc: enriched.summary.marketCapUsd,
        },
        "sleeper ALERT",
      );
    }
  }
}
