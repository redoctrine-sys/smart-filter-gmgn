import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { startBot, target } from "./telegram/bot.js";
import { NewPairPipeline } from "./pipelines/newPair.js";
import { SleeperPipeline } from "./pipelines/sleeper.js";
import { PostAlertWatcher } from "./postAlert/watcher.js";
import { limiter } from "./gmgn/rateLimiter.js";
import { snapshotter } from "./capture/index.js";
import { startDailyCron } from "./backtester/dailyCron.js";

async function main(): Promise<void> {
  logger.info(
    {
      newPairPollMs: env.NEW_PAIR_POLL_MS,
      sleeperPollMs: env.SLEEPER_POLL_MS,
      postAlertPollMs: env.POST_ALERT_POLL_MS,
      gmgnInitialRps: env.GMGN_INITIAL_RPS,
    },
    "smart-filter-gmgn starting",
  );

  await startBot();

  const newPair = new NewPairPipeline();
  const sleeper = new SleeperPipeline();
  const postAlert = new PostAlertWatcher();

  if (!target.chatId) {
    logger.warn(
      "No Telegram chat id configured. Pipelines will run, but alerts will be dropped until you run /setup in your supergroup.",
    );
  }

  newPair.start();
  sleeper.start();
  postAlert.start();
  snapshotter.start();
  startDailyCron();

  // Periodic health log so deployment platforms see something useful.
  setInterval(() => {
    logger.info(
      { rps: limiter.currentRps().toFixed(2) },
      "heartbeat",
    );
  }, 60_000);

  // Daily snapshot retention prune (default 30 days).
  setInterval(
    async () => {
      try {
        const { snapshotsRepo } = await import("./db/repos.js");
        const cutoff = Date.now() - env.BACKTEST_RETENTION_DAYS * 24 * 3600 * 1000;
        const removed = snapshotsRepo.pruneOlderThan(cutoff);
        if (removed > 0) logger.info({ removed }, "snapshots pruned");
      } catch (err) {
        logger.error({ err: String(err) }, "snapshot prune failed");
      }
    },
    24 * 3600 * 1000,
  );
}

main().catch((err) => {
  logger.error({ err: String(err) }, "fatal");
  process.exit(1);
});
