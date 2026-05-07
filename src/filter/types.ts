export type FilterOp = "equals" | "lt" | "lte" | "gt" | "gte" | "between" | "in";

export interface FilterRule {
  metric: string;
  op: FilterOp;
  value: unknown;
  points?: number;
}

export interface FilterTemplate {
  id: string;
  name: string;
  pipeline: "new_pair" | "sleeper";
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
  pipeline: "new_pair" | "sleeper";
  passed: boolean;
  reason: "hard_rule_failed" | "score_below_threshold" | "ok";
  score: number;
  threshold: number;
  hardEvals: RuleEval[];
  scoreEvals: RuleEval[];
  boosterEvals: RuleEval[];
}
