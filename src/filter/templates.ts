import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import type { FilterTemplate } from "./types.js";

const RuleSchema = z.object({
  metric: z.string(),
  op: z.enum(["equals", "lt", "lte", "gt", "gte", "between", "in"]),
  value: z.unknown(),
  points: z.number().optional(),
});

const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  pipeline: z.enum(["before_migrated", "after_migrated", "sleeper"]),
  score_threshold: z.number(),
  hard_rules: z.array(RuleSchema).default([]),
  scoring: z.array(RuleSchema).default([]),
  boosters: z.array(RuleSchema).default([]),
});

export function loadTemplate(path: string): FilterTemplate {
  const raw = readFileSync(path, "utf-8");
  const parsed = yaml.load(raw);
  const result = TemplateSchema.parse(parsed);
  return result as FilterTemplate;
}
