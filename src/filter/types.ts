export type FilterOp = "equals" | "lt" | "lte" | "gt" | "gte" | "between" | "in";

export interface FilterRule {
  metric: string;
  op: FilterOp;
  value: unknown;
  points?: number;
}

export type FilterPipeline = "before_migrated" | "after_migrated" | "sleeper";

export interface FilterTemplate {
  id: string;
  name: string;
  pipeline: FilterPipeline;
  score_threshold: number;
  hard_rules: FilterRule[];
  scoring: FilterRule[];
  boosters: FilterRule[];
}

export interface RuleEval {
  metric: string;
  op: FilterOp;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  pointsAwarded: number;
}

export interface FilterDecision {
  templateId: string;
  pipeline: FilterPipeline;
  passed: boolean;
  reason: "hard_rule_failed" | "score_below_threshold" | "ok";
  score: number;
  threshold: number;
  hardEvals: RuleEval[];
  scoreEvals: RuleEval[];
  boosterEvals: RuleEval[];
}
