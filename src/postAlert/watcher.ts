import { env } from "../config/env.js";
import { watchlistRepo } from "../db/repos.js";
import { gmgnClient } from "../gmgn/client.js";
import { sendPostAlert } from "../telegram/dispatcher.js";
import { logger } from "../utils/logger.js";

const TP_LADDER = [
  { label: "2x", multiplier: 2, sellHint: "30%" },
  { label: "5x", multiplier: 5, sellHint: "30%" },
  { label: "10x", multiplier: 10, sellHint: "20% (rest moonbag)" },
];

const SL_LADDER = [
  { label: "-30%", drop: -0.3, severity: "warning" },
  { label: "-50%", drop: -0.5, severity: "hard" },
];

export class PostAlertWatcher {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    const tick = async () => {
      try {
        await this.runOnce();
      } catch (err) {
        logger.error({ err: String(err) }, "post-alert tick failed");
      } finally {
        this.timer = setTimeout(tick, env.POST_ALERT_POLL_MS);
      }
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    const active = watchlistRepo.active();
    if (active.length === 0) return;

    const lifecycleMs = env.POST_ALERT_LIFECYCLE_HOURS * 3600 * 1000;
    const escalateMs = env.POST_ALERT_ESCALATE_AFTER_HOURS * 3600 * 1000;
    const slowMs = env.POST_ALERT_ESCALATED_POLL_MS;

    for (const w of active) {
      const ageMs = Date.now() - w.entry_at;
      if (ageMs > lifecycleMs) {
        watchlistRepo.close(w.ca, "closed");
        logger.info({ ca: w.ca }, "watchlist: lifecycle expired, dropped");
        continue;
      }

      // After escalate threshold, only poll once every slowMs based on last poll.
      if (
        ageMs > escalateMs &&
        w.last_polled_at &&
        Date.now() - w.last_polled_at < slowMs
      ) {
        continue;
      }

      const [price, rug] = await Promise.all([
        gmgnClient.priceUsd(w.ca),
        gmgnClient.rugSignals(w.ca),
      ]);
      watchlistRepo.updatePolled(w.ca);

      // Anti-rug evaluations
      if (rug.devSoldPct > 5) {
        if (watchlistRepo.recordHit(w.ca, "rug", "dev_sold_5pct")) {
          await sendPostAlert(
            w.ca,
            "rug",
            "DEV DUMP",
            `Dev wallet sold ${rug.devSoldPct.toFixed(2)}% of supply.`,
            w.thread_message_id,
          );
          watchlistRepo.close(w.ca, "rugged");
          continue;
        }
      }
      if (rug.bundlerSoldCombinedPct > 20) {
        if (watchlistRepo.recordHit(w.ca, "rug", "bundler_sold_20pct")) {
          await sendPostAlert(
            w.ca,
            "rug",
            "BUNDLER EXIT",
            `Bundler cluster sold combined ${rug.bundlerSoldCombinedPct.toFixed(2)}%.`,
            w.thread_message_id,
          );
          watchlistRepo.close(w.ca, "rugged");
          continue;
        }
      }
      if (rug.lpUnlocked) {
        if (watchlistRepo.recordHit(w.ca, "rug", "lp_unlocked")) {
          await sendPostAlert(
            w.ca,
            "rug",
            "LP UNLOCKED",
            "Liquidity unlocked / pulled — verify on-chain immediately.",
            w.thread_message_id,
          );
          watchlistRepo.close(w.ca, "rugged");
          continue;
        }
      }
      if (rug.top10DistributionShiftPct > 30) {
        if (watchlistRepo.recordHit(w.ca, "rug", "top10_shift_30pct")) {
          await sendPostAlert(
            w.ca,
            "rug",
            "DISTRIBUTION SHIFT",
            `Top10 distribution shifted ${rug.top10DistributionShiftPct.toFixed(2)}% — heavy reshuffle.`,
            w.thread_message_id,
          );
        }
      }

      // TP / SL evaluations require entry price
      if (!price || !w.entry_price_usd || w.entry_price_usd <= 0) continue;
      const change = (price - w.entry_price_usd) / w.entry_price_usd;

      for (const tp of TP_LADDER) {
        if (price >= w.entry_price_usd * tp.multiplier) {
          if (watchlistRepo.recordHit(w.ca, "tp", tp.label)) {
            await sendPostAlert(
              w.ca,
              "tp",
              `${tp.label} hit`,
              `Price ${price} (entry ${w.entry_price_usd}). Suggest partial sell ${tp.sellHint}.`,
              w.thread_message_id,
            );
          }
        }
      }
      for (const sl of SL_LADDER) {
        if (change <= sl.drop) {
          if (watchlistRepo.recordHit(w.ca, "sl", sl.label)) {
            await sendPostAlert(
              w.ca,
              "sl",
              `${sl.label} (${sl.severity})`,
              `Price ${price} (entry ${w.entry_price_usd}). Drop ${(change * 100).toFixed(1)}%.`,
              w.thread_message_id,
            );
            if (sl.severity === "hard") {
              watchlistRepo.close(w.ca, "closed");
            }
          }
        }
      }
    }
  }
}
