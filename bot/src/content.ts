export const CONTENT_POLICY_FIELDS = [
  "provider",
  "resourceId",
  "owner",
  "mimeType",
  "path",
  "sourceType",
] as const;
export const CONTENT_POLICY_OPERATORS = ["equals", "contains", "starts_with", "one_of"] as const;

export type ContentPolicyField = (typeof CONTENT_POLICY_FIELDS)[number];
export type ContentPolicyOperator = (typeof CONTENT_POLICY_OPERATORS)[number];

export interface ContentPolicy {
  effect: "include" | "exclude";
  field: ContentPolicyField;
  operator: ContentPolicyOperator;
  values: string[];
  enabled: boolean;
}

export interface ContentPolicyTarget {
  provider: string;
  resourceId: string;
  owner: string;
  mimeType: string;
  path: string;
  sourceType: string;
}

export function policyMatches(policy: ContentPolicy, target: ContentPolicyTarget): boolean {
  if (!policy.enabled || policy.values.length === 0) return false;
  const actual = target[policy.field].trim().toLowerCase();
  const values = policy.values.map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!actual || values.length === 0) return false;
  if (policy.operator === "equals" || policy.operator === "one_of") return values.includes(actual);
  if (policy.operator === "contains") return values.some((value) => actual.includes(value));
  return values.some((value) => actual.startsWith(value));
}

export function contentAllowed(policies: readonly ContentPolicy[], target: ContentPolicyTarget): boolean {
  const enabled = policies.filter((policy) => policy.enabled);
  if (enabled.some((policy) => policy.effect === "exclude" && policyMatches(policy, target))) return false;
  const includes = enabled.filter((policy) => policy.effect === "include");
  return includes.length === 0 || includes.some((policy) => policyMatches(policy, target));
}

export function searchSnippet(body: string, query: string, maxLength = 280): string {
  const clean = body.replace(/\s+/g, " ").trim();
  const bounded = Math.max(80, Math.min(Math.floor(maxLength), 600));
  if (clean.length <= bounded) return clean;
  const terms = query.toLowerCase().split(/\s+/).map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, "")).filter(Boolean);
  const lower = clean.toLowerCase();
  const hit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(hit - Math.floor(bounded / 3), clean.length - bounded));
  const excerpt = clean.slice(start, start + bounded).trim();
  return `${start > 0 ? "…" : ""}${excerpt}${start + bounded < clean.length ? "…" : ""}`;
}

