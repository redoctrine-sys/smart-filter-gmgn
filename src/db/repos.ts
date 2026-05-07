import { db } from "./client.js";

export interface AlertRow {
  id: number;
  ca: string;
  pipeline: string;
  template_id: string;
  score: number;
  payload_json: string;
  sent_at: number;
  message_id: number | null;
}

export interface WatchlistRow {
  ca: string;
  pipeline: string;
  alert_id: number;
  entry_price_usd: number | null;
  entry_mc_usd: number | null;
  entry_at: number;
  last_polled_at: number | null;
  status: "active" | "closed" | "rugged";
  tp_hits: string;
  sl_hits: string;
  rug_hits: string;
  thread_message_id: number | null;
}

export const tokensSeenRepo = {
  has(ca: string, pipeline: string): boolean {
    const row = db
      .prepare(`SELECT 1 FROM tokens_seen WHERE ca = ? AND pipeline = ?`)
      .get(ca, pipeline);
    return !!row;
  },
  mark(ca: string, pipeline: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO tokens_seen(ca, pipeline, first_seen_at) VALUES(?, ?, ?)`,
    ).run(ca, pipeline, Date.now());
  },
};

export const alertsRepo = {
  insert(args: {
    ca: string;
    pipeline: string;
    templateId: string;
    score: number;
    payload: unknown;
    messageId: number | null;
  }): number {
    const stmt = db.prepare(
      `INSERT INTO alerts(ca, pipeline, template_id, score, payload_json, sent_at, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      args.ca,
      args.pipeline,
      args.templateId,
      args.score,
      JSON.stringify(args.payload),
      Date.now(),
      args.messageId,
    );
    return Number(info.lastInsertRowid);
  },
  byId(id: number): AlertRow | undefined {
    return db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id) as AlertRow | undefined;
  },
};

export const watchlistRepo = {
  add(args: {
    ca: string;
    pipeline: string;
    alertId: number;
    entryPriceUsd: number | null;
    entryMcUsd: number | null;
    threadMessageId: number | null;
  }): void {
    db.prepare(
      `INSERT OR REPLACE INTO watchlist
       (ca, pipeline, alert_id, entry_price_usd, entry_mc_usd, entry_at, status, thread_message_id)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      args.ca,
      args.pipeline,
      args.alertId,
      args.entryPriceUsd,
      args.entryMcUsd,
      Date.now(),
      args.threadMessageId,
    );
  },
  active(): WatchlistRow[] {
    return db
      .prepare(`SELECT * FROM watchlist WHERE status = 'active' ORDER BY entry_at ASC`)
      .all() as WatchlistRow[];
  },
  get(ca: string): WatchlistRow | undefined {
    return db.prepare(`SELECT * FROM watchlist WHERE ca = ?`).get(ca) as WatchlistRow | undefined;
  },
  updatePolled(ca: string): void {
    db.prepare(`UPDATE watchlist SET last_polled_at = ? WHERE ca = ?`).run(Date.now(), ca);
  },
  recordHit(ca: string, kind: "tp" | "sl" | "rug", label: string): boolean {
    const col = kind === "tp" ? "tp_hits" : kind === "sl" ? "sl_hits" : "rug_hits";
    const row = db.prepare(`SELECT ${col} as v FROM watchlist WHERE ca = ?`).get(ca) as
      | { v: string }
      | undefined;
    if (!row) return false;
    const arr = JSON.parse(row.v) as string[];
    if (arr.includes(label)) return false;
    arr.push(label);
    db.prepare(`UPDATE watchlist SET ${col} = ? WHERE ca = ?`).run(JSON.stringify(arr), ca);
    return true;
  },
  close(ca: string, status: "closed" | "rugged"): void {
    db.prepare(`UPDATE watchlist SET status = ? WHERE ca = ?`).run(status, ca);
  },
};

export const narrativeCacheRepo = {
  get(ca: string, ttlMs: number): { score: number; reasoning: string } | undefined {
    const row = db
      .prepare(`SELECT score, reasoning, created_at FROM narrative_cache WHERE ca = ?`)
      .get(ca) as { score: number; reasoning: string; created_at: number } | undefined;
    if (!row) return undefined;
    if (Date.now() - row.created_at > ttlMs) return undefined;
    return { score: row.score, reasoning: row.reasoning };
  },
  set(ca: string, score: number, reasoning: string): void {
    db.prepare(
      `INSERT OR REPLACE INTO narrative_cache(ca, score, reasoning, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(ca, score, reasoning, Date.now());
  },
};

export const smartMoneyRepo = {
  upsert(address: string, source: string, label: string | null): void {
    db.prepare(
      `INSERT OR REPLACE INTO smart_money_wallets(address, source, label, imported_at)
       VALUES(?, ?, ?, ?)`,
    ).run(address, source, label, Date.now());
  },
  has(address: string): boolean {
    return !!db
      .prepare(`SELECT 1 FROM smart_money_wallets WHERE address = ?`)
      .get(address);
  },
  count(): number {
    const row = db.prepare(`SELECT COUNT(*) as c FROM smart_money_wallets`).get() as {
      c: number;
    };
    return row.c;
  },
  all(): string[] {
    return (
      db.prepare(`SELECT address FROM smart_money_wallets`).all() as { address: string }[]
    ).map((r) => r.address);
  },
};

export const mutedRepo = {
  is(ca: string): boolean {
    return !!db.prepare(`SELECT 1 FROM muted_tokens WHERE ca = ?`).get(ca);
  },
  mute(ca: string): void {
    db.prepare(`INSERT OR IGNORE INTO muted_tokens(ca, muted_at) VALUES(?, ?)`).run(
      ca,
      Date.now(),
    );
  },
};
