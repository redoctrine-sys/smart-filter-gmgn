import { runAndSendDigest } from "../telegram/digest.js";
import { logger } from "../utils/logger.js";

/**
 * Daily digest at 08:00 Asia/Jakarta (WIB, UTC+7).
 *
 * Window covered: previous 24h (yesterday 08:00 WIB → today 08:00 WIB).
 * Runs both pipelines sequentially.
 */

const TARGET_HOUR_WIB = 8;
const WIB_OFFSET_MS = 7 * 3600 * 1000;
const ONE_DAY_MS = 24 * 3600 * 1000;

function nextRunAt(now = Date.now()): number {
  // Convert "now" into WIB by adding offset, snap to today 08:00 WIB,
  // then convert back to UTC.
  const nowWib = new Date(now + WIB_OFFSET_MS);
  const todayWib = Date.UTC(
    nowWib.getUTCFullYear(),
    nowWib.getUTCMonth(),
    nowWib.getUTCDate(),
    TARGET_HOUR_WIB,
  );
  let target = todayWib - WIB_OFFSET_MS;
  if (target <= now) target += ONE_DAY_MS;
  return target;
}

export function startDailyCron(): void {
  const schedule = () => {
    const next = nextRunAt();
    const wait = next - Date.now();
    logger.info(
      { runAt: new Date(next).toISOString(), waitMs: wait },
      "daily digest cron scheduled",
    );
    setTimeout(async () => {
      try {
        const toMs = Date.now();
        const fromMs = toMs - ONE_DAY_MS;
        for (const p of ["before_migrated", "after_migrated", "sleeper"] as const) {
          await runAndSendDigest({ pipeline: p, fromMs, toMs });
        }
      } catch (err) {
        logger.error({ err: String(err) }, "daily digest run failed");
      } finally {
        schedule();
      }
    }, wait);
  };
  schedule();
}
