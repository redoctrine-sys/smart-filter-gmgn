# 🧠 Smart Filter GMGN — Full Blueprint & Setup Guide

> **Target deploy**: GitHub Codespaces (Linux container)
> **Last updated**: 2026-05-08

---

## 1. Apa Ini?

**smart-filter-gmgn** = real-time Solana meme coin scanner:
1. Poll token dari **GMGN Agent API** via 3 pipeline paralel
2. Filter lewat **hybrid engine** (hard rules + weighted scoring YAML template)
3. Alert ke **Telegram** + action buttons (Trojan / Jupiter)
4. Monitor token post-alert: **TP / SL / Anti-Rug** (24h lifecycle)
5. **Backtester harian** + daily digest + CSV export
6. **(BARU) Hermes Agent** — AI layer untuk category insight + entry/risk plan card
7. **(BARU) Strategy Optimizer Loop** — setiap pipeline punya reviewer mandiri yang auto-generate strategy variants (🔴 Aggressive / 🟡 Moderate / 🟢 Safe), simulasi masing-masing, lalu apply yang terbaik — berjalan terus sebagai feedback loop

---

## 2. Architecture

### High-Level Flow

```
GMGN Agent API
      │
      ├─ before_migrated  (poll 4s)   ──┐
      ├─ after_migrated   (poll 8s)   ──┤
      ├─ sleeper          (poll 60s)  ──┼─▶ FilterEngine ─▶ sendAlert()
      └─ post_alert       (poll 5s)   ──┘         │              │
                                                   │         ┌────┴────┐
                                              Backtester     │ Hermes  │
                                              (daily cron)   │ Agent   │
                                                   │         └────┬────┘
                                                   ▼              ▼
                                              Digest +       Entry/Risk
                                              Category       Plan Card
                                              Insight        (reply msg)
```

### Per-Pipeline Strategy Loop (BARU)

Setiap pipeline memiliki reviewer mandiri. **Optimizer hanya aktif jika terdeteksi penurunan performa mingguan** — bukan jalan setiap hari. Daily digest tetap jalan setiap hari untuk monitoring, tapi variant generation + auto-tweak hanya di-trigger saat performa menurun.

```
┌──────────────────────────────────────────────────────────────────────┐
│                PER-PIPELINE STRATEGY LOOP                          │
│                                                                     │
│  ┌─────────┐    ┌─────────────────────────────────────────────────┐ │
│  │Pipeline │    │ Weekly Performance Monitor (setiap Senin 08:00) │ │
│  │ (alert) │    │                                                 │ │
│  └────┬────┘    │ Bandingkan minggu ini vs minggu lalu:           │ │
│       │         │   • win rate turun > 5%?                        │ │
│       │         │   • avg PnL turun > 10%?                        │ │
│       │         │   • realized SOL turun > 15%?                   │ │
│       │         │                                                 │ │
│       │         │ Jika YA (decline detected):                     │ │
│       │         │   → Trigger Strategy Optimizer                  │ │
│       │         │ Jika TIDAK:                                     │ │
│       │         │   → Skip, kirim "✅ Performance stable" saja   │ │
│       │         └────────────────────┬────────────────────────────┘ │
│       │                              │ (decline detected)          │
│       │                              ▼                             │
│       │         ┌────────────────────────────────────┐             │
│       │         │ Strategy Optimizer                 │             │
│       │         │                                    │             │
│       │         │ 1. Analisis metric lift             │             │
│       │         │ 2. Generate 3 variant:              │             │
│       │         │    🔴 Aggressive (low threshold)   │             │
│       │         │    🟡 Moderate   (balanced tweak)  │             │
│       │         │    🟢 Safe       (high threshold)  │             │
│       │         │ 3. Backtest SETIAP variant          │             │
│       │         │    dengan adjusted metrics          │             │
│       │         │ 4. Compare win rate, PnL, calls     │             │
│       │         │ 5. Recommend best → Telegram        │             │
│       │         └──────────────┬─────────────────────┘             │
│       │                       │                                    │
│       │                       ▼                                    │
│       │         ┌──────────────────┐                               │
│       │         │ Auto-apply best  │  (atau manual approval        │
│       └─────────│ variant sebagai  │   via /approve di Telegram)   │
│                 │ active template  │                               │
│                 └──────────────────┘                               │
│                                                                     │
│  Trigger:                                                          │
│    • Otomatis: weekly cron (Senin 08:00 WIB) jika decline          │
│    • Manual: /optimize <pipeline> <window> kapan saja              │
└──────────────────────────────────────────────────────────────────────┘

Jalan paralel per pipeline (masing-masing punya history & threshold sendiri):

  before_migrated  ──▶  Weekly Review ──▶  Decline? ──▶ Optimizer ──▶ 3 variants ──▶ backtest each ──▶ pick best
  after_migrated   ──▶  Weekly Review ──▶  Decline? ──▶ Optimizer ──▶ 3 variants ──▶ backtest each ──▶ pick best
  sleeper          ──▶  Weekly Review ──▶  Decline? ──▶ Optimizer ──▶ 3 variants ──▶ backtest each ──▶ pick best
```

| Layer | Tech |
|---|---|
| Runtime | Node.js ≥ 20, TypeScript ES2022 |
| Database | SQLite (`better-sqlite3`) |
| Telegram | `telegraf` v4 |
| AI | Google Gemini (`@google/generative-ai`) |
| Validation | `zod` |
| Templates | YAML (`js-yaml`) |

---

## 3. Module Breakdown

### Core

| Directory | Fungsi |
|---|---|
| `src/config/env.ts` | Zod-validated env schema |
| `src/db/` | SQLite repos (alerts, watchlist, snapshots, muted, seen) |
| `src/gmgn/` | GMGN API client + adaptive rate limiter |
| `src/filter/` | FilterEngine, metricsAdapter, template loader |
| `src/pipelines/` | 3 pipeline classes (beforeMigrated, afterMigrated, sleeper) |
| `src/narrative/` | Gemini narrative scoring + copycat/cluster detection |
| `src/postAlert/` | TP/SL/Anti-Rug watcher (24h lifecycle) |
| `src/telegram/` | Bot setup, alert dispatcher, daily digest |
| `src/backtester/` | Replay engine, exit simulator (auto-capture on-chain metrics snapshot at entry & exit), reviewer, CSV export |
| `src/capture/` | Snapshot scheduler (1m → 5m → 1h intervals) |

### Hermes Agent & Strategy Optimizer (BARU)

| File | Fungsi |
|---|---|
| `src/hermes/categories.ts` | Map 40+ metrics → 4 kategori (TA, Volume, Age, Narrative), hitung dominance ratio, generate insight text |
| `src/hermes/agent.ts` | HermesAgent class — Gemini-powered analysis atau static fallback. Output: conviction, entry zone, risk plan |
| `src/hermes/cardTemplate.ts` | Format Entry/Risk Plan Card untuk Telegram |
| `src/hermes/strategyOptimizer.ts` | Weekly reviewer — deteksi penurunan performa, generate 3 strategy variant (Aggressive/Moderate/Safe), backtest masing-masing dengan adjusted metrics, bandingkan hasil, recommend/apply yang terbaik |
| `src/hermes/templateMutator.ts` | Generate YAML template baru dari template aktif + rekomendasi optimizer (tweak threshold, points, tambah/hapus rules) |
| `src/hermes/performanceTracker.ts` | Simpan historical weekly stats per pipeline (win rate, PnL, calls) untuk deteksi decline week-over-week |

### Hermes Output Example

```
┌─ 📋 HERMES PLAN ─────────────────────────────────────┐
│ Strategy: 🟡 MODERATE · Conviction: 🟢 HIGH · Risk: 3/10
│
│ 💰 Position Sizing
│ Entry size:  0.1 SOL per buy
│ Max total:   0.5 SOL (5 entries max)
│ DCA trigger: -15% dari avg entry
│
│ 🎯 Entry Zone
│ Buy:  $0.00012 − $0.00015
│ DCA1: $0.00010 (-17%)  → 0.1 SOL
│ DCA2: $0.00008 (-33%)  → 0.1 SOL
│ DCA3: $0.00006 (-50%)  → 0.1 SOL (if vol > $5K/5m)
│
│ 🛡 Risk Plan
│ SL:  $0.00004 (-67% dari entry)
│ TP1: $0.00030 (+100%)  sell 30%
│ TP2: $0.00075 (+400%)  sell 30%
│ TP3: $0.00150 (+900%)  sell 20%, rest moonbag
│
│ 💡 Kuat di TA dan Volume
│ 📝 Vol $12K/5m, MC $45K → Moderate sizing
└──────────────────────────────────────────────────────┘
```

---

## 4. Data Flow

### Alert Flow (dengan Hermes)

```
Pipeline.runOnce()
  → gmgnClient.enrich(ca)                    # TokenSnapshot
  → buildMetrics(snapshot)                    # flatten ke metric map
  → FilterEngine.evaluate(metrics)            # hard_rules → scoring → boosters
  → if passed → sendAlert()
       ├─ buildBody() → kirim ke Telegram
       └─ if HERMES_ENABLED:
            └─ runHermesReply() [async, non-blocking]
                 ├─ categorizeScoringMetrics()  → breakdown
                 ├─ generateCategoryInsight()   → "Kuat di TA"
                 ├─ Gemini prompt               → entry/risk plan
                 ├─ buildEntryRiskCard()         → card text
                 └─ Reply ke alert message
```

### Backtester Digest (dengan Category Insight)

```
review()
  → findSimulatedCalls()                     # replay through template + capture ENTRY snapshot (holders, bundler, MC)
  → simulateExit() per call                  # TP/SL outcomes + capture EXIT snapshot (holders, bundler, MC)
  → aggregate()                              # win rate, PnL, distribution
  → metricCorrelation()                      # per-metric lift
  → aggregateCategoryBreakdown()             # per-category dominance
  → generateCategoryInsight()                # "Kuat di TA dan Volume"

formatDigest()
  → Category Strength section
  → Insight text
```

### Strategy Optimizer Loop (per pipeline)

Loop ini **BUKAN** jalan setiap hari. Optimizer hanya aktif saat terdeteksi penurunan performa mingguan. Daily digest tetap jalan untuk monitoring.

```
Untuk setiap pipeline (before_migrated, after_migrated, sleeper):

  ┌─ STEP 0: Weekly Performance Check ─────────────────────────┐
  │ Setiap Senin 08:00 WIB (weekly cron):                       │
  │                                                             │
  │ performanceTracker.compare(pipeline, thisWeek, lastWeek)    │
  │   → Δ ROI (avg PnL):  +18% → -2% (turun 20%) ⚠️           │
  │                                                             │
  │ Decline threshold (configurable):                           │
  │   ROI (avg PnL) turun drastis > 15% minus                   │
  │                                                             │
  │ → DECLINE DETECTED → lanjut ke STEP 1                      │
  │ → STABLE           → kirim "✅ Performance stable" & stop  │
  └──────────────────────────────────┬──────────────────────────┘
                                     │ (decline detected)
                                     ▼
  ┌─ STEP 1: Deep Review ───────────────────────────────────────┐
  │ review(pipeline, 7d)  ← window mingguan, bukan harian      │
  │   → BacktestSummary (win rate, PnL, metric lift, category)  │
  │   → Identifikasi trend: metric mana yang memburuk?          │
  └──────────────────────────────────┬──────────────────────────┘
                                     │
  ┌─ STEP 2: Analyze & Generate Variants ───────▼───────────────┐
  │ StrategyOptimizer.analyze(summary, currentTemplate)         │
  │   → Identifikasi:                                           │
  │     • Dead weight metrics (lift ≤ 0%, buang poin)           │
  │     • Hidden gems (lift > 15% tapi poin kecil, naikkan)     │
  │     • Threshold tuning (terlalu ketat / terlalu longgar)    │
  │   → templateMutator.generate() → 3 variant YAML:           │
  │     🔴 Aggressive: threshold turun, poin TA naik            │
  │     🟡 Moderate:   balanced tweak based on lift data        │
  │     🟢 Safe:       threshold naik, dead weight dihapus      │
  └──────────────────────────────────┬──────────────────────────┘
                                     │
  ┌─ STEP 3: Backtest SETIAP Variant ▼──────────────────────────┐
  │ Untuk MASING-MASING variant (🔴🟡🟢):                      │
  │                                                             │
  │   review(pipeline, 7d, variant_template)                    │
  │                                                             │
  │   Adjusted metrics per variant:                             │
  │     🔴 Aggressive: simulasi dengan base_size +50%          │
  │     🟡 Moderate:   simulasi dengan base_size standar       │
  │     🟢 Safe:       simulasi dengan base_size -30%          │
  │                                                             │
  │   Per variant dihitung:                                     │
  │     • win rate                                              │
  │     • avg PnL %                                             │
  │     • total realized SOL                                    │
  │     • max drawdown                                          │
  │     • avg time to TP                                        │
  │     • outcome distribution (TP vs SL vs rug ratio)          │
  │                                                             │
  │   Bandingkan vs current template performance                │
  └──────────────────────────────────┬──────────────────────────┘
                                     │
  ┌─ STEP 4: Report & Apply ─────────▼──────────────────────────┐
  │ Kirim ke Telegram:                                          │
  │                                                             │
  │   ⚠️ PERFORMANCE DECLINE — after_migrated                  │
  │   This week vs last week: win 35% (was 42%), PnL -7pp      │
  │                                                             │
  │   🔧 STRATEGY VARIANTS (backtested on 7d data):            │
  │                                                             │
  │   Current:  win 35% · avg +11% · 72 calls · 8.2 SOL       │
  │   🔴 Aggro: win 33% · avg +19% · 95 calls · 11.4 SOL     │
  │   🟡 Mod:   win 41% · avg +16% · 78 calls · 10.1 SOL ←   │
  │   🟢 Safe:  win 52% · avg +8%  · 48 calls · 6.8 SOL      │
  │                                                             │
  │   ✅ Recommendation: Apply 🟡 Moderate                     │
  │   Changes: near_fib_786 20→30pts, bundler_pct 15→10pts     │
  │   Threshold: 80 → 75                                       │
  │                                                             │
  │ Mode:                                                       │
  │   AUTO_APPLY=true  → langsung apply variant terbaik         │
  │   AUTO_APPLY=false → tunggu /approve di Telegram            │
  └─────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                              Template YAML updated
                              (atau pending approval)
                                     │
                                     ▼
                              Pipeline pakai template baru
                              mulai minggu depan
                                     │
                                     └──────▶ Loop kembali ke STEP 0
                                              (Senin depan 08:00 WIB)
```

### Kapan Optimizer TIDAK Trigger

| Kondisi | Aksi |
|---|---|
| ROI (avg PnL) stabil atau turun ≤ 15% | ✅ "Performance stable" — tidak ada perubahan |
| ROI (avg PnL) turun drastis > 15% minus | 🔧 **Trigger optimizer** — generate & backtest 3 variant |

### Entry Sizing Rules

Aturan sizing berlaku global untuk semua pipeline:

| Rule | Value |
|---|---|
| Max entry per buy | **0.1 SOL** |
| Max total position per token | **0.5 SOL** (= 5 entries max) |
| Berlaku sama untuk | before_migrated, after_migrated, sleeper |

Strategy variant menentukan **berapa banyak DCA** dan **pada kondisi apa** DCA di-trigger:

### Contoh Strategy Variant yang Di-generate

Dari template `after_migrated_irisan.yaml` (threshold=80):

#### Scoring & Filter Adjustment

| Aspect | 🔴 Aggressive | 🟡 Moderate | 🟢 Safe |
|---|---|---|---|
| Threshold | 65 | 75 | 90 |
| `drop_from_ath_pct` | 25pts (keep) | 25pts (keep) | 30pts (naik) |
| `candle_confirm_3_green` | 15pts (turun) | 20pts (keep) | 25pts (naik) |
| `near_fib_786` | 15pts (turun) | 25pts (naik, hidden gem) | 30pts (naik) |
| `bundler_pct` | 10pts (turun) | 10pts (turun) | 15pts (keep) |
| `volume_1h_usd` | 15pts (naik) | 10pts (keep) | 5pts (turun) |
| Dead weight metric | tetap ada | dihapus | dihapus |

#### Entry & DCA Strategy

| Aspect | 🔴 Aggressive | 🟡 Moderate | 🟢 Safe |
|---|---|---|---|
| **Entry per buy** | 0.1 SOL | 0.1 SOL | 0.1 SOL |
| **Max total** | 0.5 SOL (5 entries) | 0.4 SOL (4 entries) | 0.2 SOL (2 entries) |
| **Min volume (5m)** | > $2K | > $5K | > $10K |
| **Min market cap** | > $10K | > $25K | > $50K |
| **DCA trigger** | -10% dari avg entry | -15% dari avg entry | -25% dari avg entry |
| **DCA max** | 4 kali DCA (sampai 0.5 SOL) | 3 kali DCA (sampai 0.4 SOL) | 1 kali DCA (sampai 0.2 SOL) |
| **DCA condition** | Jika volume masih aktif (vol 5m > $2K) | Jika volume naik + TA confirm (3 green / fib) | Hanya jika volume spike > 3x + TA confirm |
| **Stop DCA jika** | Dev dump / LP unlock | Vol 5m turun < $1K ATAU dev dump | Vol 5m turun < $5K ATAU score turun |

#### Contoh DCA Flow: 🟡 Moderate pada after_migrated

```
Entry1: 0.1 SOL @ $0.00015  (initial buy, vol $12K/5m, MC $45K)
  │
  │ Price turun -15%
  ▼
DCA1:  0.1 SOL @ $0.000128  (vol masih $8K/5m, 3 green candle confirm)
  │
  │ Price turun -15% lagi
  ▼
DCA2:  0.1 SOL @ $0.000109  (vol naik $15K/5m, near fib 0.786)
  │
  │ Price turun -15% lagi
  ▼
DCA3:  0.1 SOL @ $0.000092  (vol $6K/5m — last DCA, total 0.4 SOL)
  │
  │ Price turun lagi tapi vol < $1K/5m
  ▼
STOP DCA — no more entries. Manage existing 0.4 SOL position.
```

#### Expected Performance per Variant

| Metric | 🔴 Aggressive | 🟡 Moderate | 🟢 Safe |
|---|---|---|---|
| Calls/day | ~20 | ~14 | ~8 |
| Avg entries/call | 3.5 | 2.5 | 1.5 |
| Avg position size | 0.35 SOL | 0.25 SOL | 0.15 SOL |
| Win rate | ~38% | ~48% | ~55% |
| Avg PnL per call | +19% | +16% | +8% |
| Max drawdown | -45% | -30% | -18% |

---

## 5. Installation — GitHub Codespaces

### Step 1: Push ke GitHub

```bash
cd d:\Vibecoding\smart-filter-gmgn
git add -A
git commit -m "feat: hermes agent + category correlation"
git push origin main
```

### Step 2: Buat Codespace

1. Di GitHub repo, klik **Code** → **Codespaces** → **Create codespace on main**
2. Pilih **2-core** machine (cukup untuk bot ini)
3. Tunggu VS Code di browser terbuka (~1 menit)

### Step 3: Install Dependencies

```bash
node -v              # pastikan >= 20
npm install          # better-sqlite3 akan compile otomatis
npm run typecheck    # verifikasi tidak ada error
```

> Di Codespaces (Ubuntu), `python3`, `make`, `g++` sudah pre-installed — `better-sqlite3` native build berjalan lancar.

### Step 4: Setup Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# WAJIB
GMGN_API_KEY=<your_key>
TELEGRAM_BOT_TOKEN=<your_token>
GEMINI_API_KEY=<your_gemini_key>

# AKTIFKAN Hermes
HERMES_ENABLED=true
HERMES_MODEL=gemini-2.0-flash
HERMES_MAX_RESEARCH_MS=10000
```

### Step 5: Setup Telegram

1. Buat bot via [@BotFather](https://t.me/BotFather)
2. Buat **supergroup** dengan **topics enabled**, add bot sebagai admin
3. Buat 4 topics: 🌱 Before Migrated, 🚀 After Migrated, 😴 Sleeper, 📡 Post-Alert
4. Jalankan bot: `npm run dev`
5. Di General: `/setup` → bot reply chat ID
6. Di setiap topic: `/setup before_migrated`, `/setup after_migrated`, dst.

### Step 6: Run

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start

# Background (agar tidak mati saat terminal tutup)
screen -S bot
npm run dev
# Ctrl+A, D to detach
# screen -r bot to reattach
```

### Step 7: Verifikasi

1. Log menampilkan `telegram bot launched` + `pipeline ready` (×3)
2. `/status` di Telegram → reply config
3. `/backtest after_migrated 1d` → digest dengan **Category Strength** section
4. Tunggu alert → cek **Hermes Plan card** muncul sebagai reply

---

## 6. Key Environment Variables

| Variable | Default | Keterangan |
|---|---|---|
| `GMGN_API_KEY` | — | **Required** |
| `TELEGRAM_BOT_TOKEN` | — | **Required** |
| `GEMINI_API_KEY` | — | Required untuk Hermes + narrative |
| `HERMES_ENABLED` | `false` | Toggle Hermes on/off |
| `HERMES_MODEL` | same as GEMINI_MODEL | Model untuk Hermes analysis |
| `HERMES_MAX_RESEARCH_MS` | `10000` | Timeout Gemini call |
| `OPTIMIZER_AUTO_APPLY` | `false` | `true` = auto-apply best variant, `false` = tunggu `/approve` |
| `OPTIMIZER_VARIANT_COUNT` | `3` | Jumlah variant yang di-generate (Aggressive/Moderate/Safe) |
| `BEFORE_MIGRATED_POLL_MS` | `4000` | Polling interval |
| `AFTER_MIGRATED_POLL_MS` | `8000` | Polling interval |
| `SLEEPER_POLL_MS` | `60000` | Polling interval |
| `BACKTEST_ALMOST_BAND` | `15` | "Almost triggered" score band |
| `BACKTEST_RETENTION_DAYS` | `30` | Snapshot retention |

---

## 7. Telegram Commands

| Command | Contoh | Fungsi |
|---|---|---|
| `/setup` | `/setup` | Register chat ID |
| `/setup <pipeline>` | `/setup after_migrated` | Register topic ID |
| `/status` | `/status` | Tampilkan config aktif |
| `/backtest` | `/backtest` | Digest semua pipeline 24h |
| `/backtest <p> <w>` | `/backtest sleeper 7d` | Digest spesifik pipeline + window |
| `/optimize <p> <w>` | `/optimize after_migrated 7d` | **(BARU)** Trigger strategy optimizer loop: generate 3 variant, simulate, report |
| `/approve <p>` | `/approve after_migrated` | **(BARU)** Apply recommended variant sebagai active template (jika `AUTO_APPLY=false`) |
| `/revert <p>` | `/revert after_migrated` | **(BARU)** Rollback ke template sebelumnya jika variant baru ternyata buruk |

---

## 8. Codespaces Tips

**Persistent storage**: SQLite DB hilang jika Codespace di-delete → jangan delete, cukup stop (gratis saat idle). Atau backup: `cp data/state.db data/backup.db`

**Idle timeout**: 30 menit → gunakan `screen` atau `nohup npm start &`

**Cost**: Free tier = 120 core-hours/month. 2-core = 60 jam. Untuk 24/7 production, pertimbangkan Railway/Fly.io.

---

## 9. Troubleshooting

| Problem | Solution |
|---|---|
| `better-sqlite3` build error | `sudo apt install python3 build-essential` (biasanya tidak perlu di Codespaces) |
| Alert tidak muncul | Pastikan `/setup` sudah di semua topic |
| Hermes card tidak muncul | Cek `HERMES_ENABLED=true` + `GEMINI_API_KEY` |
| `hermes gemini failed` | Timeout/error Gemini — card tetap muncul dgn data statis |
| Digest kosong | Butuh ~24h snapshot history |
