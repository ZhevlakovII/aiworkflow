/**
 * Critic / plan / scaffold opt-in detection.
 * Default off; on via task frontmatter and/or caller flag.
 * Truthy: on / true / 1 / yes (case-insensitive).
 * Critic defaults unchanged; plan/scaffold helpers are neighbors.
 */
import { splitMaxsplit } from "./py-text.ts";

export function isTruthyOptIn(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "on" || v === "1" || v === "yes";
}

function taskFrontmatterOrWhole(text: string): string {
  if (!text.startsWith("---")) return text;
  const parts = splitMaxsplit(text, "---", 2);
  return parts[1] as string;
}

export function scalarWithComment(fm: string, key: string): string {
  const m = new RegExp("^" + "\\s*" + key + ":" + "\\s*" + "(.+?)" + "\\s*$", "m").exec(fm);
  if (!m) return "";
  return (m[1] as string).replace(new RegExp("\\s+#\\s.*$"), "").trim();
}

function optInPair(taskText: string, a: string, b: string): boolean {
  const fm = taskFrontmatterOrWhole(taskText);
  return isTruthyOptIn(scalarWithComment(fm, a)) || isTruthyOptIn(scalarWithComment(fm, b));
}

export function criticOptInFromTaskText(taskText: string): boolean {
  return optInPair(taskText, "critic-opt-in", "critic");
}

export function resolveCriticOptIn(taskText: string, flag?: boolean): boolean {
  return Boolean(flag) || criticOptInFromTaskText(taskText);
}

export function planOptInFromTaskText(taskText: string): boolean {
  return optInPair(taskText, "plan-opt-in", "plan");
}

export function resolvePlanOptIn(taskText: string, flag?: boolean): boolean {
  return Boolean(flag) || planOptInFromTaskText(taskText);
}

export function scaffoldOptInFromTaskText(taskText: string): boolean {
  return optInPair(taskText, "scaffold-opt-in", "scaffold");
}

export function resolveScaffoldOptIn(taskText: string, flag?: boolean): boolean {
  return Boolean(flag) || scaffoldOptInFromTaskText(taskText);
}
