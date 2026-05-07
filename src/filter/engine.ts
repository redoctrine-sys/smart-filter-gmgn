import type { FilterDecision, FilterRule, FilterTemplate, RuleEval } from "./types.js";

/**
 * Hybrid filter engine.
 *
 * Step 1 — hard_rules: ALL must pass, otherwise the candidate is dropped.
 * Step 2 — scoring + boosters: each passing rule adds `points`; if total
 *          score >= template.score_threshold, the candidate is alerted.
 *
 * Boosters are evaluated either way (they affect score and surface in
 * Telegram), but only contribute extra points; they are not gating.
 */

export class FilterEngine {
  constructor(private readonly tpl: FilterTemplate) {}

  evaluate(metrics: Record<string, unknown>): FilterDecision {
    const hardEvals = this.tpl.hard_rules.map((r) => evalRule(r, metrics));
    const hardOk = hardEvals.every((e) => e.passed);

    const scoreEvals = this.tpl.scoring.map((r) => evalRule(r, metrics));
    const boosterEvals = this.tpl.boosters.map((r) => evalRule(r, metrics));

    const score =
      scoreEvals.reduce((a, e) => a + e.pointsAwarded, 0) +
      boosterEvals.reduce((a, e) => a + e.pointsAwarded, 0);

    let reason: FilterDecision["reason"] = "ok";
    let passed = true;
    if (!hardOk) {
      reason = "hard_rule_failed";
      passed = false;
    } else if (score < this.tpl.score_threshold) {
      reason = "score_below_threshold";
      passed = false;
    }

    return {
      templateId: this.tpl.id,
      pipeline: this.tpl.pipeline,
      passed,
      reason,
      score,
      threshold: this.tpl.score_threshold,
      hardEvals,
      scoreEvals,
      boosterEvals,
    };
  }
}

function evalRule(rule: FilterRule, metrics: Record<string, unknown>): RuleEval {
  const actual = metrics[rule.metric];
  const passed = compare(actual, rule.op, rule.value);
  return {
    metric: rule.metric,
    op: rule.op,
    expected: rule.value,
    actual,
    passed,
    pointsAwarded: passed && rule.points ? rule.points : 0,
  };
}

function compare(actual: unknown, op: FilterRule["op"], expected: unknown): boolean {
  if (actual === undefined || actual === null) return false;
  switch (op) {
    case "equals":
      return normalize(actual) === normalize(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    case "between": {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const a = Number(actual);
      const lo = Number(expected[0]);
      const hi = Number(expected[1]);
      return a >= lo && a <= hi;
    }
    case "in": {
      if (!Array.isArray(expected)) return false;
      const s = String(actual).toLowerCase();
      return expected.map((v) => String(v).toLowerCase()).includes(s);
    }
  }
}

function normalize(v: unknown): unknown {
  if (typeof v === "string") return v.toLowerCase();
  return v;
}
