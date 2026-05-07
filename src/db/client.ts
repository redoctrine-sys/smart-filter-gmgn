import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

mkdirSync(dirname(env.DB_PATH), { recursive: true });

export const db = new Database(env.DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens_seen (
  ca TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (ca, pipeline)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ca TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  template_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  message_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_ca ON alerts(ca);
CREATE INDEX IF NOT EXISTS idx_alerts_sent_at ON alerts(sent_at);

CREATE TABLE IF NOT EXISTS watchlist (
  ca TEXT PRIMARY KEY,
  pipeline TEXT NOT NULL,
  alert_id INTEGER NOT NULL,
  entry_price_usd REAL,
  entry_mc_usd REAL,
  entry_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  tp_hits TEXT NOT NULL DEFAULT '[]',
  sl_hits TEXT NOT NULL DEFAULT '[]',
  rug_hits TEXT NOT NULL DEFAULT '[]',
  thread_message_id INTEGER,
  FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_watchlist_status ON watchlist(status);

CREATE TABLE IF NOT EXISTS narrative_cache (
  ca TEXT PRIMARY KEY,
  score REAL NOT NULL,
  reasoning TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS smart_money_wallets (
  address TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  label TEXT,
  imported_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS muted_tokens (
  ca TEXT PRIMARY KEY,
  muted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS historical_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ca TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  template_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  age_minutes_since_first_sight REAL NOT NULL,
  price_usd REAL,
  market_cap_usd REAL,
  score INTEGER NOT NULL,
  hard_pass INTEGER NOT NULL,
  triggered INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  narrative_score REAL
);
CREATE INDEX IF NOT EXISTS idx_hs_ca ON historical_snapshots(ca);
CREATE INDEX IF NOT EXISTS idx_hs_captured_at ON historical_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_hs_pipeline_captured ON historical_snapshots(pipeline, captured_at);

CREATE TABLE IF NOT EXISTS capture_schedule (
  ca TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  next_capture_at INTEGER NOT NULL,
  captures_done INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (ca, pipeline)
);
CREATE INDEX IF NOT EXISTS idx_cs_status_next ON capture_schedule(status, next_capture_at);
`;

db.exec(SCHEMA);

logger.info({ path: env.DB_PATH }, "SQLite ready");

export function setBotState(key: string, value: string): void {
  db.prepare(
    `INSERT INTO bot_state(key, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, value, Date.now());
}

export function getBotState(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM bot_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}
