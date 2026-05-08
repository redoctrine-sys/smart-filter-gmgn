import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { Pipeline } from "../capture/snapshotter.js";

const TEMPLATE_PATH: Record<Pipeline, () => string> = {
  before_migrated: () => env.TEMPLATE_BEFORE_MIGRATED,
  after_migrated:  () => env.TEMPLATE_AFTER_MIGRATED,
  sleeper:         () => env.TEMPLATE_SLEEPER,
};

function templatesBaseDir(): string {
  return dirname(env.TEMPLATE_AFTER_MIGRATED);
}

function variantsDir(): string {
  return join(templatesBaseDir(), "variants");
}

function backupsDir(): string {
  return join(templatesBaseDir(), "backups");
}

export function readTemplateRaw(pipeline: Pipeline): string {
  return readFileSync(TEMPLATE_PATH[pipeline](), "utf-8");
}

export function writeVariant(
  pipeline: Pipeline,
  variantType: string,
  content: string,
): string {
  const dir = variantsDir();
  mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const path = join(dir, `${pipeline}_${variantType.toLowerCase()}_${ts}.yaml`);
  writeFileSync(path, content, "utf-8");
  logger.info({ path }, "optimizer variant written");
  return path;
}

export function applyVariant(pipeline: Pipeline, variantPath: string): void {
  const activePath = TEMPLATE_PATH[pipeline]();
  const backupDir = backupsDir();
  mkdirSync(backupDir, { recursive: true });

  if (existsSync(activePath)) {
    const backupPath = join(backupDir, `${pipeline}_backup_${Date.now()}.yaml`);
    copyFileSync(activePath, backupPath);
    logger.info({ from: activePath, backup: backupPath }, "template backed up");
  }

  copyFileSync(variantPath, activePath);
  logger.info({ variantPath, activePath }, "optimizer variant applied");
}

export function revertTemplate(pipeline: Pipeline): string | null {
  const backupDir = backupsDir();
  if (!existsSync(backupDir)) return null;

  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith(pipeline) && f.endsWith(".yaml"))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const latestBackup = join(backupDir, files[0]);
  const activePath = TEMPLATE_PATH[pipeline]();
  copyFileSync(latestBackup, activePath);
  logger.info({ from: latestBackup, to: activePath }, "template reverted from backup");
  return basename(latestBackup);
}
