import { env } from "../config/env.js";
import { snapshotter } from "../capture/index.js";
import { alertsRepo, mutedRepo, tokensSeenRepo, watchlistRepo } from "../db/repos.js";
import { FilterEngine } from "../filter/engine.js";
import { buildMetrics } from "../filter/metricsAdapter.js";
import { loadTemplate } from "../filter/templates.js";
import { gmgnClient } from "../gmgn/client.js";
import { sendAlert } from "../telegram/dispatcher.js";
import { logger } from "../utils/logger.js";

const PIPELINE = "new_pair";

export class NewPairPipeline {
  private readonly engine: FilterEngine;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    const tpl = loadTemplate(env.TEMPLATE_NEW_PAIR);
    if (tpl.pipeline !== "new_pair") {
      throw new Error(`Template ${tpl.id} is not for new_pair pipeline`);
    }
    this.engine = new FilterEngine(tpl);
    logger.info({ template: tpl.id, threshold: tpl.score_threshold }, "new_pair pipeline ready");
  }

  start(): void {
    const tick = async () => {
      try {
        await this.runOnce();
      } catch (err) {
        logger.error({ err: String(err) }, "new_pair tick failed");
      } finally {
        this.timer = setTimeout(tick, env.NEW_PAIR_POLL_MS);
      }
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    const candidates = await gmgnClient.fetchNewPairs({ limit: 60 });
    if (candidates.length === 0) return;

    for (const shallow of candidates) {
      const ca = shallow.summary.ca;
      if (!ca) continue;
      if (mutedRepo.is(ca)) continue;
      if (tokensSeenRepo.has(ca, PIPELINE)) continue;

      // Register for periodic snapshot capture (backtester data) the moment
      // we first see this CA, regardless of whether it ends up alerting.
      snapshotter.register(ca, PIPELINE);

      const enriched = await gmgnClient.enrich(ca);
      if (!enriched) continue;
      const smartMoney = await gmgnClient.smartMoneyBuysLastHour(ca);
      const metrics = buildMetrics(enriched, { smartMoneyBuys: smartMoney });
      const decision = this.engine.evaluate(metrics);

      if (!decision.passed) {
        if (decision.reason === "hard_rule_failed") {
          tokensSeenRepo.mark(ca, PIPELINE);
        } else {
          logger.debug(
            { ca, score: decision.score, threshold: decision.threshold },
            "new_pair below threshold (will reconsider next tick)",
          );
        }
        continue;
      }

      tokensSeenRepo.mark(ca, PIPELINE);
      const result = await sendAlert("new_pair", enriched, decision);
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
        { ca, score: decision.score, mc: enriched.summary.marketCapUsd },
        "new_pair ALERT",
      );
    }
  }
}
