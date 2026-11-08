/**
 * Critic opt-in detection (AD-critic-default-off-opt-in).
 * Default = off for all classes; on only via task frontmatter and/or caller flag.
 */
import { splitMaxsplit } from "./py-text.ts";

/** Case-insensitive truthy: on / true / 1 / yes. */
export function isTruthyOptIn(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "on" || v === "1" || v === "yes";
}

function taskFrontmatterOrWhole(text: string): string {
  if (!text.startsWith("---")) return text;
  const parts = splitMaxsplit(text, "---", 2);
  return parts[1] as string;
}

function scalarWithComment(fm: string, key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(fm);
  if (!m) return "";
  return (m[1] as string).replace(/\s+#\s.*$/, "").trim();
}

/**
 * True when task frontmatter has `critic-opt-in: true` OR `critic: on`
 * (truthy on/true/1/yes, case-insensitive).
 */
export function criticOptInFromTaskText(taskText: string): boolean {
  const fm = taskFrontmatterOrWhole(taskText);
  return (
    isTruthyOptIn(scalarWithComment(fm, "critic-opt-in")) ||
    isTruthyOptIn(scalarWithComment(fm, "critic"))
  );
}

/** Frontmatter opt-in OR explicit caller flag; default false. */
export function resolveCriticOptIn(taskText: string, flag?: boolean): boolean {
  return Boolean(flag) || criticOptInFromTaskText(taskText);
}
