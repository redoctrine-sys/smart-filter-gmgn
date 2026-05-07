import "dotenv/config";
import { z } from "zod";

const numStr = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().finite());

const envSchema = z.object({
  // GMGN
  GMGN_API_KEY: z.string().min(1, "GMGN_API_KEY is required"),
  GMGN_PRIVATE_KEY: z.string().optional().default(""),
  GMGN_BASE_URL: z.string().url().default("https://gmgn.ai/api"),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  TELEGRAM_TOPIC_NEW_PAIR: z.string().optional().default(""),
  TELEGRAM_TOPIC_SLEEPER: z.string().optional().default(""),
  TELEGRAM_TOPIC_POST_ALERT: z.string().optional().default(""),

  // Trojan + Jupiter
  TROJAN_REFCODE: z.string().optional().default(""),
  JUPITER_BASE_URL: z.string().url().default("https://jup.ag/swap/SOL-"),

  // Gemini
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),

  // Polling
  NEW_PAIR_POLL_MS: numStr(4000),
  SLEEPER_POLL_MS: numStr(60000),
  POST_ALERT_POLL_MS: numStr(5000),
  POST_ALERT_ESCALATE_AFTER_HOURS: numStr(6),
  POST_ALERT_ESCALATED_POLL_MS: numStr(60000),
  POST_ALERT_LIFECYCLE_HOURS: numStr(24),

  // Rate limiter
  GMGN_INITIAL_RPS: numStr(4),
  GMGN_MIN_RPS: numStr(0.5),
  GMGN_MAX_RPS: numStr(10),
  GMGN_BACKOFF_FACTOR: numStr(0.5),
  GMGN_RECOVER_FACTOR: numStr(1.1),

  // Backtester
  BACKTEST_ALMOST_BAND: numStr(15),
  BACKTEST_BASE_SIZE_SOL: numStr(1.0),
  BACKTEST_RETENTION_DAYS: numStr(30),

  // Narrative cluster + copycat detection (New Pair)
  CLUSTER_LOOKBACK_HOURS: numStr(6),
  RUNNER_LOOKBACK_HOURS: numStr(24),
  RUNNER_MIN_MULTIPLIER: numStr(3.0),
  COPYCAT_SIMILARITY_THRESHOLD: numStr(0.5),

  // Misc
  LOG_LEVEL: z.string().default("info"),
  DB_PATH: z.string().default("./data/state.db"),
  TEMPLATE_NEW_PAIR: z.string().default("./templates/new_pair_irisan.yaml"),
  TEMPLATE_SLEEPER: z.string().default("./templates/sleeper_irisan.yaml"),
  SMART_MONEY_CSV: z.string().default("./data/smart_money_wallets.csv"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
