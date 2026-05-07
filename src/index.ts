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

  // Daily snapshot retention prune (default 30 days). Recent_token_meta
  // gets pruned more aggressively (24h is enough for cluster/runner queries).
  setInterval(
    async () => {
      try {
        const { snapshotsRepo, recentTokenMetaRepo } = await import("./db/repos.js");
        const snapCutoff = Date.now() - env.BACKTEST_RETENTION_DAYS * 24 * 3600 * 1000;
        const removed = snapshotsRepo.pruneOlderThan(snapCutoff);
        const metaCutoff = Date.now() - env.RUNNER_LOOKBACK_HOURS * 3600 * 1000 * 2;
        const removedMeta = recentTokenMetaRepo.pruneOlderThan(metaCutoff);
        if (removed > 0 || removedMeta > 0) {
          logger.info({ snapshots: removed, recentMeta: removedMeta }, "pruned");
        }
      } catch (err) {
        logger.error({ err: String(err) }, "prune failed");
      }
    },
    24 * 3600 * 1000,
  );
}

main().catch((err) => {
  logger.error({ err: String(err) }, "fatal");
  process.exit(1);
});
