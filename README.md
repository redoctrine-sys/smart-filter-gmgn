# smart-filter-gmgn

Real-time Solana meme coin smart filter built on top of the **GMGN Agent API**, with **three parallel pipelines** keyed off the migration phase, a hybrid filter engine (hard rules + weighted scoring), and a post-alert watcher (TP / SL / anti-rug). Alerts are pushed to Telegram with one-click links to **Trojan** and **Jupiter**.

| Pipeline | Phase | Source | Default poll | Default threshold |
|---|---|---|---|---|
| `before_migrated` | Pump.fun bonding curve (chaos PvP) | `v1/sol/tokens/new_pair` | 4 s | 75 |
| `after_migrated` | Just migrated to Raydium (post-dump reversal sweet spot) | `v1/sol/tokens/migrated` (fallback `scanner`) | 8 s | 80 |
| `sleeper` | Low-cap slowcook (MC 7K-25K, narrative play) | `v1/sol/tokens/scanner` | 60 s | 70 |

The filter weights are derived from a synthesis of strategies from four Indonesian degen Solana traders (@ELPonyin, @badidoyo, @Andri_Snnn, @PradonoNovaldo). See `templates/*.yaml`.

> **Disclaimer.** Not financial advice. Solana trenches are PvP. Trade with cold money. DYOR.

---

## Architecture

```
GMGN Agent API
      │
      ├─ before_migrated  (poll 4s)   ─┐
      ├─ after_migrated   (poll 8s)   ─┤
      ├─ sleeper          (poll 60s)  ─┼─▶ Filter engine ─▶ Telegram alert
      └─ post_alert       (poll 5s→60s)┘                      │
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
3. Create four topics: `🌱 Before Migrated`, `🚀 After Migrated`, `😴 Sleeper`, `📡 Post-Alert (TP/SL/Rug)`.
4. Run the bot once (`npm run dev`) and inside the supergroup type `/setup` (in General). The bot replies with the chat id.
5. Inside each topic thread, type `/setup before_migrated`, `/setup after_migrated`, `/setup sleeper`, `/setup post_alert`. The bot persists IDs in SQLite so subsequent restarts auto-detect them.

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

| File | Pipeline | Threshold | Highlights |
|---|---|---|---|
| `before_migrated_irisan.yaml` | `before_migrated` | 75 | Hard: bonding + mint/freeze revoked + dev=0% + top10<25%. Score-heavy on-chain (bundler<5%=+30, fee>1 SOL=+25, age<30min=+15). TA minimal. |
| `after_migrated_irisan.yaml`  | `after_migrated`  | 80 | Hard: migrated + drop_from_ath ≤-50%. Balanced: drop ≤-70%=+25, 3-candle=+20, Fib 0.786=+20, Stoch RSI safe=+15. |
| `sleeper_irisan.yaml`         | `sleeper`         | 70 | Hard: MC 7K-25K + age>24h. Narrative=+25, volume spike 3×=+20, holder stacked=+15, Fib=+15. |

### Re-weighting summary (Mei 2026 update)

The weights reflect what each phase rewards in practice:

- **Before Migrated**: TA is unreliable here ("gambarnya belum selesai" — Ponyin). Score is dominated by on-chain integrity and freshness, plus the badidoyo "TOKEN AGE = OLDEST" booster.
- **After Migrated**: TA actually works — combines Ponyin's 3-candle confirm, badidoyo's Fib 0.786, and Andri's "RSI atas tunggu turun" (Stoch RSI dropping from overbought) on top of post-dump entry zone (drop_from_ath ≤-70%).
- **Sleeper**: Narrative + volume spike + meme dominate, with TA as confirmation.

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

Plus **wallet composition** metrics (lifetime since launch, captured for top 10 and top 100 holders — see "Wallet composition" section below):
`top10_n, top10_avg_buy_sol, top10_avg_sell_sol, top10_avg_sol_balance,
top10_max_sol_balance, top10_buy_sell_ratio, top100_n, top100_avg_buy_sol,
top100_avg_sell_sol, top100_avg_sol_balance, top100_max_sol_balance,
top100_buy_sell_ratio`.

Plus **volume** metrics (raw USD turnover, useful for "organic volume + global fee" checks):
`volume_5m_usd, volume_1h_usd, volume_24h_usd`.

Plus **narrative cluster + copycat** metrics (see "Narrative cluster + copycat" below):
`is_oldest_in_cluster, cluster_size, earlier_similar_count,
is_copycat_of_runner, copycat_similarity, copycat_runner_symbol`.

Plus **migration + technical analysis** metrics (mostly used by `after_migrated` and `sleeper`):

| Metric | Source |
|---|---|
| `migration_status` | `bonding` / `migrated` / `unknown` derived from launchpad + `migrated_at` flag |
| `age_minutes` | `age_hours * 60`, used by `before_migrated` for "very fresh" rules |
| `ath_price_usd`, `drop_from_ath_pct` | computed on the 5m kline (8h window). `drop_from_ath_pct` is negative when below ATH; `≤ -0.7` = 70%+ dump zone. |
| `candle_confirm_3_green` | last 3 closes > opens on the 1m TF (Ponyin) |
| `near_fib_786` | last close within ±5% of `high - (high-low)*0.786` on 5m TF (badidoyo) |
| `stoch_rsi_k`, `stoch_rsi_signal` | Stochastic RSI %K (0-100) on 5m closes; signal ∈ {`overbought`, `oversold`, `dropping_from_overbought`, `rising_from_oversold`, `neutral`} |
| `stoch_rsi_safe` | true when `k < 80` OR signal === `dropping_from_overbought` (Andri "RSI atas tunggu turun") |
| `stoch_rsi_overbought`, `stoch_rsi_oversold` | convenience booleans for sharper rules |

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

## Narrative cluster + copycat (New Pair)

Two cooperating signals derived from @badidoyo's "TOKEN AGE = OLDEST" rule and the broader "copycat of today's runners" heuristic:

### Cluster — "OLDEST in batch"
For every new candidate, the bot scans the last `CLUSTER_LOOKBACK_HOURS` (default 6h) of tokens it has previously seen. Using a Jaccard similarity over name + symbol + description tokens (with an exact-symbol bonus), it clusters the candidate with anything that resembles it.

| Verdict | Meaning |
|---|---|
| `cluster_size = 1` | unique narrative — no recent siblings |
| `is_oldest_in_cluster = true` (and `cluster_size > 1`) | candidate appeared first within its cluster — strongest "OLDEST" signal |
| `is_oldest_in_cluster = false` | another similar token was seen earlier — likely a copycat of a recent batch |

### Runner copycat
A "runner of the day" is any token whose captured snapshots over the last `RUNNER_LOOKBACK_HOURS` (default 24h) show `max(price)/min(price) >= RUNNER_MIN_MULTIPLIER` (default 3×). Runner detection is cached for 10 minutes.

| Verdict | Meaning |
|---|---|
| `is_copycat_of_runner = true` | candidate is highly similar (Jaccard ≥ `COPYCAT_SIMILARITY_THRESHOLD`) to a 3×+ runner — penalize / skip |
| `copycat_runner_symbol` | the runner's symbol the candidate matched (shown in the alert card) |

### Default rules in `templates/new_pair_irisan.yaml`
The default template gives boosters for healthy narrative behavior:

```yaml
- { metric: volume_1h_usd,         op: gte,    value: 5000, points: 10 }
- { metric: is_oldest_in_cluster,  op: equals, value: true, points: 10 }
- { metric: is_copycat_of_runner,  op: equals, value: false, points: 10 }
```

Tune via env: `CLUSTER_LOOKBACK_HOURS`, `RUNNER_LOOKBACK_HOURS`, `RUNNER_MIN_MULTIPLIER`, `COPYCAT_SIMILARITY_THRESHOLD`.

> Cold start: runner detection is empty until the bot has ~24h of snapshot history. During the first day, copycat checks degrade gracefully (`is_copycat_of_runner` defaults to `false` ≅ no penalty).

---

## Wallet composition

For every enriched token, the bot pulls the **top 100 holders** and computes lifetime cohort stats for both **top 10** and **top 100**:

| Metric | Meaning |
|---|---|
| `top{10,100}_n` | actual holders found in the cohort (may be less than the cohort size for very fresh pairs) |
| `top{10,100}_avg_buy_sol` | average SOL each holder spent buying this token (lifetime) |
| `top{10,100}_avg_sell_sol` | average SOL each holder received selling this token (lifetime) |
| `top{10,100}_avg_sol_balance` | average SOL sitting in each holder's wallet — proxy for wallet wealth |
| `top{10,100}_max_sol_balance` | biggest wallet in the cohort by SOL balance |
| `top{10,100}_buy_sell_ratio` | `avg_buy / avg_sell` — values >1 = accumulating, <1 = distributing |

By default these metrics are **display + capture only** — they appear in alert cards and are stored in `historical_snapshots` for backtesting, but do not gate any alert. Examples for opting them into the filter (commented out in `templates/*.yaml`):

```yaml
# Avoid bot armies (top10 average wallet < 0.1 SOL = mostly snipers)
- { metric: top10_avg_sol_balance, op: gte, value: 0.1, points: 10 }

# Whale-backed (at least one big wallet in top10)
- { metric: top10_max_sol_balance, op: gte, value: 50, points: 5 }

# Top100 still accumulating
- { metric: top100_buy_sell_ratio, op: gte, value: 1.5, points: 10 }
```

> Field-name normalisation lives in `src/gmgn/client.ts` (`BUY_FIELDS / SELL_FIELDS / BALANCE_FIELDS`). If GMGN renames a holder field, fix it once there and every cohort metric updates.

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
/backtest                          # all 3 pipelines, last 24h
/backtest before_migrated 7d       # before_migrated only, last 7 days
/backtest after_migrated 3d        # after_migrated only, last 3 days
/backtest sleeper 14d              # sleeper only, last 14 days
/review all 12h                    # alias of /backtest
```

Aliases accepted: `before` / `pre` for `before_migrated`, `after` / `post` for `after_migrated`.

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
