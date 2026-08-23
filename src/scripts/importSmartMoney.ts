import { readFileSync, existsSync } from "node:fs";
import { env } from "../config/env.js";
import { smartMoneyRepo } from "../db/repos.js";
import { logger } from "../utils/logger.js";

/**
 * Import smart-money wallets from CSV.
 *
 * Format (header optional, but required if columns are reordered):
 *   address,source,label
 *   7xKxk...,gmgn_tag,sniper_pro
 *   9aPna...,kol_list,@someone
 *
 * Usage:
 *   pnpm import-smart-money [path/to.csv]
 */

function parseCsv(text: string): { address: string; source: string; label: string | null }[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return [];
  const first = lines[0]!.toLowerCase();
  const hasHeader = first.includes("address");
  const rows = hasHeader ? lines.slice(1) : lines;
  const out: { address: string; source: string; label: string | null }[] = [];
  for (const line of rows) {
    const cols = line.split(",").map((c) => c.trim());
    const [address, source, label] = cols;
    if (!address) continue;
    out.push({
      address,
      source: source || "manual",
      label: label || null,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? env.SMART_MONEY_CSV;
  if (!existsSync(path)) {
    logger.error({ path }, "CSV not found");
    process.exit(1);
  }
  const text = readFileSync(path, "utf-8");
  const rows = parseCsv(text);
  for (const r of rows) {
    smartMoneyRepo.upsert(r.address, r.source, r.label);
  }
  logger.info(
    { imported: rows.length, total: smartMoneyRepo.count(), path },
    "smart money import done",
  );
}

main().catch((err) => {
  logger.error({ err: String(err) }, "import failed");
  process.exit(1);
});
