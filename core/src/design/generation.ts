/**
 * Contract generation cutover (AD-cutover-by-generation).
 * Exclusive path per task: `generation: spec-roadmap` vs absent / `sp-adr` (legacy).
 * Default legacy so in-flight dual SP+ADR contracts keep working.
 */
import { scalarWithComment } from "./critic-opt-in.ts";
import { splitMaxsplit } from "./py-text.ts";

export const GEN_SPEC_ROADMAP = "spec-roadmap";
export const GEN_SP_ADR = "sp-adr";

function taskFrontmatterOrWhole(text: string): string {
  if (!text.startsWith("---")) return text;
  const parts = splitMaxsplit(text, "---", 2);
  return parts[1] as string;
}

/** Raw generation scalar from task frontmatter (empty if absent). */
export function generationFromTaskText(taskText: string): string {
  const fm = taskFrontmatterOrWhole(taskText);
  return scalarWithComment(fm, "generation").trim().toLowerCase();
}

/** True when task explicitly opts into the new spec+roadmap path. */
export function isSpecRoadmapGeneration(taskText: string): boolean {
  return generationFromTaskText(taskText) === GEN_SPEC_ROADMAP;
}

/**
 * True for legacy SP+ADR path: absent marker or explicit `sp-adr`.
 * Default when generation is missing so in-flight contracts stay on dual emit.
 */
export function isLegacySpAdrGeneration(taskText: string): boolean {
  const g = generationFromTaskText(taskText);
  return g === "" || g === GEN_SP_ADR;
}
