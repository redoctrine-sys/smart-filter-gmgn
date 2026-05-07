import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { startBot, target } from "./telegram/bot.js";
import { NewPairPipeline } from "./pipelines/newPair.js";
import { SleeperPipeline } from "./pipelines/sleeper.js";
import { PostAlertWatcher } from "./postAlert/watcher.js";
import { limiter } from "./gmgn/rateLimiter.js";

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

  // Periodic health log so deployment platforms see something useful.
  setInterval(() => {
    logger.info(
      { rps: limiter.currentRps().toFixed(2) },
      "heartbeat",
    );
  }, 60_000);
}

main().catch((err) => {
  logger.error({ err: String(err) }, "fatal");
  process.exit(1);
});
