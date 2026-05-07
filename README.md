# smart-filter-gmgn

Real-time Solana meme coin smart filter built on top of the **GMGN Agent API**, with two parallel pipelines (**New Pair** and **Sleeper**), a hybrid filter engine (hard rules + weighted scoring), and a post-alert watcher (TP / SL / anti-rug). Alerts are pushed to Telegram with one-click links to **Trojan** and **Jupiter**.

The filter thresholds are derived from a synthesis of strategies from four Indonesian degen Solana traders (@ELPonyin, @badidoyo, @Andri_Snnn, @PradonoNovaldo). See `templates/*.yaml`.

> **Disclaimer.** Not financial advice. Solana trenches are PvP. Trade with cold money. DYOR.

---

## Architecture

```
GMGN Agent API
      │
      ├─ New Pair pipeline   (poll 3-5s)  ─┐
      ├─ Sleeper pipeline    (poll 60s)   ─┼─▶ Filter engine ─▶ Telegram alert
      └─ Post-alert watcher  (poll 5s→60s) ┘                       │
                                                                   ▼
                                                        TP / SL / Anti-rug
```

- **Stack**: Node.js 20 + TypeScript, Telegraf, better-sqlite3, Gemini (narrative).
- **Storage**: SQLite (`data/state.db`).
- **Rate limit**: adaptive token-bucket (auto back-off on 429/5xx, auto recover).
- **Templates**: YAML, hot-loadable from `templates/`.

---

## Setup

### 1. Prerequisites
- Node.js ≥ 20
- pnpm / npm / yarn

### 2. GMGN API key (free, ~2 minutes)
Follow the official guide: <https://docs.gmgn.ai/index/gmgn-agent-api>

```
1. Generate Ed25519 keypair locally (tool in the GMGN docs).
2. Open https://gmgn.ai/ai → upload public key.
3. Copy the API key into .env (GMGN_API_KEY).
```

There is also a public read-only test key: `gmgn_solbscbaseethmonadtron` — useful for smoke tests.

### 3. Telegram bot
1. Create a bot via [@BotFather](https://t.me/BotFather) → copy the token to `TELEGRAM_BOT_TOKEN`.
2. Create a **supergroup** with **topics enabled**, and add the bot as admin (with permission to send messages in topics).
3. Create three topics: `🆕 New Pair Alerts`, `😴 Sleeper Alerts`, `📡 Post-Alert (TP/SL/Rug)`.
4. Run the bot once (`pnpm dev`) and inside the supergroup type `/setup` (in General). The bot replies with the chat id.
5. Inside each topic thread, type `/setup new_pair`, `/setup sleeper`, `/setup post_alert` respectively. The bot persists IDs in SQLite so subsequent restarts auto-detect them.

### 4. Gemini API (Sleeper narrative scoring)
- Free key: <https://aistudio.google.com/apikey>
- Drop into `GEMINI_API_KEY`. Default model is `gemini-2.0-flash`.
- If left empty, narrative score falls back to a fixed `7/10`.

### 5. Trojan refcode (optional)
- Set `TROJAN_REFCODE` so alert buttons deep-link via your refcode.
- Output URL format: `https://t.me/solana_trojanbot?start=r-<refcode>-<CA>`.

### 6. Smart money wallets (optional)
- Copy `data/smart_money_wallets.example.csv` → `data/smart_money_wallets.csv`.
- Add wallets (GMGN tagged smart money + your KOL whitelist).
- Run `pnpm import-smart-money`.

---

## Run

```bash
pnpm install
cp .env.example .env       # then fill in keys
pnpm dev                   # ts-node watch mode
# or
pnpm build && pnpm start   # production
```

### First-run sanity check
- Look for `telegram bot launched` in logs.
- In your supergroup type `/status` — bot should reply with config.
- Both pipelines log `pipeline ready` and start polling.
- Alerts only fire after `/setup` has been completed.

---

## Templates

Templates live in `templates/`:

| File | Pipeline | Threshold | Notes |
|---|---|---|---|
| `new_pair_irisan.yaml` | new_pair | 70 | Hard: mint/freeze revoked, top10 < 25%, dev = 0%, socials ≥ 1, 3 candle confirm |
| `sleeper_irisan.yaml`  | sleeper  | 65 | Hard: MC 7K-25K, age > 24h, mint/freeze revoked, socials ≥ 1 |

Edit YAML → restart bot. To swap templates without code changes, point `TEMPLATE_NEW_PAIR` / `TEMPLATE_SLEEPER` at a different file.

### Adding a custom template

```yaml
id: my_aggressive_new_pair
name: "Aggressive (sub-4% bundler)"
pipeline: new_pair         # must be new_pair or sleeper
score_threshold: 80
hard_rules:
  - { metric: mint_authority, op: equals, value: revoked }
  ...
scoring:
  - { metric: bundler_pct, op: lt, value: 4, points: 30 }
  ...
boosters:
  - { metric: smart_money_buys, op: gte, value: 2, points: 10 }
```

Available operators: `equals | lt | lte | gt | gte | between | in`.

Available metrics (see `src/filter/metricsAdapter.ts` for the full list):
`market_cap_usd, age_hours, socials_count, mint_authority, freeze_authority,
honeypot, top_10_holder_pct, top_1_holder_pct, dev_holding_pct,
insider_holder_pct, bundler_pct, top1_holder_balance_sol, global_fee_sol,
global_fee_status, dex_paid_status, candle_confirm_3_green, near_fib_786,
holder_stacked, volume_spike_ratio, smart_money_buys, narrative_score,
launchpad`.

---

## Post-alert lifecycle

When a token alerts, it enters the watchlist for **24 h**:
- First **6 h**: poll every 5 s.
- After 6 h: poll every 60 s.
- TP ladder: **2× / 5× / 10×** (suggested partials 30% / 30% / 20%).
- SL ladder: **−30% (warning) / −50% (hard, closes watch)**.
- Anti-rug: dev sells > 5% supply, bundler cluster sells > 20%, LP unlocked, top10 distribution shift > 30%.

All post-alert events are pushed to the `post_alert` topic, replying to the original alert message when possible.

---

## Deployment (Railway / Fly.io / Render)

1. Add the env vars from `.env.example`.
2. Mount a persistent volume at `./data` so SQLite survives restarts.
3. Start command: `pnpm start` (or `node dist/index.js`).
4. Optional Health-check path: any HTTP endpoint you add — current build is pure worker.

---

## Project layout

```
smart-filter-gmgn/
├── src/
│   ├── config/env.ts         # zod-validated env schema
│   ├── db/                   # SQLite client + repos
│   ├── filter/               # engine, types, template loader, metric adapter
│   ├── gmgn/                 # client + adaptive rate limiter + types
│   ├── narrative/gemini.ts   # narrative score for Sleeper
│   ├── pipelines/
│   │   ├── newPair.ts
│   │   └── sleeper.ts
│   ├── postAlert/watcher.ts  # TP / SL / anti-rug
│   ├── scripts/importSmartMoney.ts
│   ├── telegram/             # bot.ts + dispatcher.ts (topics)
│   ├── utils/                # logger, format, links
│   └── index.ts              # entrypoint wiring everything
├── templates/
│   ├── new_pair_irisan.yaml
│   └── sleeper_irisan.yaml
├── data/                     # SQLite + smart money CSV (gitignored)
├── .env.example
└── README.md
```

---

## Backtester / daily review

The bot continuously captures snapshots of every token its pipelines see (whether or not it alerts) into `historical_snapshots`. The backtester replays those snapshots through the active template to simulate calls, runs the post-alert ladder against subsequent snapshots to compute exits, and posts a digest with summary stats plus a CSV attachment.

### Capture schedule
For each token, snapshots are taken at:
- every **1 minute** for the first hour (60 captures)
- every **5 minutes** for the next hour (12 captures)
- every **1 hour** until 24 hours from first sight

Old snapshots are pruned daily based on `BACKTEST_RETENTION_DAYS` (default 30).

### Daily digest
Fires at **08:00 Asia/Jakarta** (WIB) covering the trailing 24 hours, both pipelines, sent to the `post_alert` topic.

### On-demand
```
/backtest                 # all pipelines, last 24h
/backtest new_pair 7d     # new pair pipeline, last 7 days
/backtest sleeper 3d      # sleeper pipeline, last 3 days
/review all 14h           # alias of /backtest
```

Window grammar: `Nh` (hours) or `Nd` (days), e.g. `12h`, `3d`, `7d`.

### What's in the digest
- **Triggered** — calls where score ≥ threshold.
- **Almost** — hard rules passed but score within `BACKTEST_ALMOST_BAND` (default ±15) of the threshold; useful to gauge whether the threshold is too strict.
- For each bucket: `n`, win-rate, simple avg PnL%, weighted avg PnL%, total realized SOL, outcome distribution, avg time-to-TP.
- **Metric lift** — for each scoring rule, win rate of triggered calls that passed the rule vs failed (sorted by lift). Tells you which rules actually predict winners.
- **Top winners / losers** — top 5 each by realized SOL.
- **CSV attachment** — one row per call with entry/exit details for offline analysis.

### Exit simulator
For each simulated entry, the simulator walks forward through that token's subsequent snapshots (up to 24h) and applies the same TP / SL / anti-rug ladder used in production:

| Outcome | Trigger |
|---|---|
| `tp_2x` / `tp_5x` / `tp_10x` | price hits 2× / 5× / 10× of entry (highest reached counts) |
| `sl_warning` | price drops 30% from entry |
| `sl_hard` | price drops 50% from entry — closes the position |
| `rug_lp_unlocked` | LP burn pct drops below 50% (heuristic) |
| `expired` | none of the above hit within 24h — last seen price marks the exit |

### Position sizing (score-weighted)
```
size_sol = clamp(score / threshold, 0.5, 2.5) * BACKTEST_BASE_SIZE_SOL
```
So a call at threshold = base size; a perfect-100 call (threshold 70) ≈ 1.43× base; below ~½ threshold is floored at 0.5× base. Realized SOL = `size_sol * pnl_pct`.

---

## Roadmap (v2+)

- Multi-template per pipeline (run several in parallel; tag alerts by template).
- Telegram inline override for narrative score (LLM auto + manual confirm).
- Auto-buy via Trojan callback handler (with kill-switch).
- Multi-user mode with per-user templates.
- Richer rug detection in the exit simulator (use real `rug_signals` snapshot instead of LP heuristic).
