/**
 * gate-lint — deterministic design-gate (INV-4). Model-agnostic.
 *
 * Generation (AD-cutover-by-generation) — exclusive axes per contract:
 *   Legacy `sp-adr` (default / absent):
 *     Gate-1 source↔spec; Gate-2 spec↔ADR; Gate-3 FR EARS (conditional).
 *   New `spec-roadmap`:
 *     Gate-1 source↔spec; Gate-2 spec↔roadmap (```ac / ```phase covers→SP/FR);
 *     Gate-3 FR EARS. No product ADR required.
 *
 * Roadmap fenced grammar (machine-readable):
 * ```ac
 * id: AC-<kebab>
 * covers: SP-a, FR-b
 * statement: <acceptance / verification / test shelf>
 * ```
 * ```phase
 * id: PH-<kebab>
 * covers: SP-a
 * statement: <phase scope>
 * ```
 *
 * Pure `gateLint(...)` — thin CLI in `./gate-lint-cli.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  GEN_SPEC_ROADMAP,
  generationFromTaskText,
  isSpecRoadmapGeneration,
} from "./generation.ts";

const BLOCK_RE = /```(spec|sp|adr|ad|fr|ac|phase)\s*\n([\s\S]*?)```/g;
const SRC_RE = /^([^#]+)#L(\d+)(?:-L?(\d+))?$/;

type BlockKind = "spec" | "adr" | "fr" | "ac" | "phase";

function canonicalBlockKind(tag: string): BlockKind {
  switch (tag) {
    case "sp":
      return "spec";
    case "ad":
      return "adr";
    default:
      return tag as BlockKind;
  }
}

export interface GateResult {
  findings: string[];
  nSp: number;
  nAd: number;
  nFr: number;
  nAc: number;
  nPhase: number;
}

export type GateGeneration = "sp-adr" | "spec-roadmap";

export interface GateLintOptions {
  /** Explicit generation; else read from task frontmatter (default legacy). */
  generation?: GateGeneration | string;
  /** When set under spec-roadmap, runs spec↔roadmap coverage axis. */
  roadmapPath?: string;
}

/** EARS-syntax of an FR-block (core-3). Returns a finding-msg or "" (valid). */
function earsCheck(fr: Record<string, string>): string {
  const pat = (fr.pattern || "").toLowerCase().trim();
  const st = (fr.statement || "").trim();
  if (!st) return "нет statement";
  const shall = /\bshall\b/i.exec(st);
  if (!shall) return `EARS: нет "SHALL" (${JSON.stringify(st)})`;
  const response = st.slice(shall.index + shall[0].length).trim();
  if (!response) return "EARS: пустой response после SHALL";
  const before = st.slice(0, shall.index);
  switch (pat) {
    case "ubiquitous":
      if (/^\s*(WHEN|WHILE|IF)\b/i.test(st)) return "EARS ubiquitous: не должно быть WHEN/WHILE/IF в начале";
      return "";
    case "event": {
      if (!/^\s*WHEN\b/i.test(st)) return "EARS event: должно начинаться с WHEN";
      const trig = before.replace(/^\s*WHEN\b/i, "").replace(/\bthe\s+system\s*$/i, "").trim();
      if (!trig) return "EARS event: пустой trigger между WHEN и SHALL";
      return "";
    }
    case "unwanted": {
      if (!/^\s*IF\b/i.test(st)) return "EARS unwanted: должно начинаться с IF";
      if (!/\bTHEN\b/i.test(before)) return "EARS unwanted: нет THEN перед SHALL";
      const cond = before.replace(/^\s*IF\b/i, "").replace(/\bTHEN\b[\s\S]*$/i, "").trim();
      if (!cond) return "EARS unwanted: пустое условие между IF и THEN";
      return "";
    }
    default:
      return `EARS: неизвестный pattern ${JSON.stringify(pat)} (ожидается ubiquitous|event|unwanted)`;
  }
}

/** Extract fenced-blocks of the given kind, parse `key: value` lines. */
function parseBlocks(mdPath: string, kind: BlockKind): Record<string, string>[] {
  const text = fs.readFileSync(mdPath, "utf8");
  const out: Record<string, string>[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const blockKind = canonicalBlockKind(m[1]!);
    if (blockKind !== kind) continue;
    const entry: Record<string, string> = {};
    for (let line of m[2]!.split("\n")) {
      // spec/fr/ac/phase source may contain '#Lx' → trailing ' # ...' only; adr — full #-tail
      line =
        blockKind === "adr"
          ? line.split("#", 1)[0]!.replace(/\s+$/, "")
          : line.replace(/\s+#\s.*$/, "").replace(/\s+$/, "");
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      entry[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    if (entry.id) out.push(entry);
  }
  return out;
}

/** Does source-ref resolve into real non-empty lines of the task-file? */
function checkSourceRef(ref: string, repoRoot: string): { ok: boolean; msg: string } {
  const mm = SRC_RE.exec(ref.trim());
  if (!mm) return { ok: false, msg: `source не в формате <file>#Lx[-Ly]: ${JSON.stringify(ref)}` };
  const f = path.resolve(repoRoot, mm[1]!);
  if (!fs.existsSync(f)) return { ok: false, msg: `source-file не найден: ${mm[1]}` };
  const lines = fs.readFileSync(f, "utf8").replace(/\r?\n$/, "").split(/\r?\n/);
  const start = parseInt(mm[2]!, 10);
  const end = mm[3] ? parseInt(mm[3], 10) : start;
  if (start < 1 || end > lines.length || start > end)
    return { ok: false, msg: `диапазон L${start}-L${end} вне файла (всего ${lines.length} строк)` };
  if (!lines.slice(start - 1, end).join("\n").trim())
    return { ok: false, msg: `строки L${start}-L${end} пусты` };
  return { ok: true, msg: "" };
}

function resolveGeneration(
  taskPath: string,
  options?: GateLintOptions,
): GateGeneration {
  if (options?.generation === GEN_SPEC_ROADMAP || options?.generation === "spec-roadmap") {
    return "spec-roadmap";
  }
  if (options?.generation === "sp-adr") return "sp-adr";
  if (fs.existsSync(taskPath)) {
    try {
      const text = fs.readFileSync(taskPath, "utf8");
      if (isSpecRoadmapGeneration(text) || generationFromTaskText(text) === GEN_SPEC_ROADMAP) {
        return "spec-roadmap";
      }
    } catch {
      // fall through to legacy
    }
  }
  return "sp-adr";
}

function emptyResult(findings: string[]): GateResult {
  return { findings, nSp: 0, nAd: 0, nFr: 0, nAc: 0, nPhase: 0 };
}

function lintSourceSpecFr(
  taskPath: string,
  specPath: string,
  repoRoot: string,
  findings: string[],
): { sps: Record<string, string>[]; frs: Record<string, string>[]; spIds: Set<string>; coverableIds: Set<string> } {
  const sps = parseBlocks(specPath, "spec");
  const frs = parseBlocks(specPath, "fr");
  if (!sps.length) findings.push("SPEC: не найдено ни одного ```spec|sp-блока (формат нарушен)");

  const spIds = new Set<string>();
  const coverableIds = new Set<string>();
  for (const sp of sps) {
    spIds.add(sp.id!);
    coverableIds.add(sp.id!);
    const src = sp.source || "";
    if (!src) {
      findings.push(`G1 ${sp.id}: нет source-ref`);
      continue;
    }
    const r = checkSourceRef(src, repoRoot);
    if (!r.ok) findings.push(`G1 ${sp.id}: ${r.msg}`);
  }

  for (const fr of frs) {
    coverableIds.add(fr.id!);
    const src = fr.source || "";
    if (!src) findings.push(`G1 ${fr.id}: FR нет source-ref`);
    else {
      const r = checkSourceRef(src, repoRoot);
      if (!r.ok) findings.push(`G1 ${fr.id}: ${r.msg}`);
    }
    const e = earsCheck(fr);
    if (e) findings.push(`G3 ${fr.id}: ${e}`);
  }

  void taskPath;
  return { sps, frs, spIds, coverableIds };
}

function lintSpecAdr(
  sps: Record<string, string>[],
  spIds: Set<string>,
  ads: Record<string, string>[],
  findings: string[],
): void {
  if (!ads.length) findings.push("ADR: не найдено ни одного ```adr|ad-блока (формат нарушен)");
  const covered = new Set<string>();
  for (const ad of ads) {
    const covers = (ad.covers || "").split(",").map((c) => c.trim()).filter(Boolean);
    if (!covers.length) findings.push(`G2 ${ad.id}: covers пуст (решение ничего не покрывает)`);
    for (const c of covers) {
      if (!spIds.has(c)) findings.push(`G2 ${ad.id}: covers ссылается на несуществующий ${c} (фантом)`);
      else covered.add(c);
    }
  }
  for (const sp of sps) {
    if (!covered.has(sp.id!) && (sp.gap || "").toLowerCase() !== "true") {
      findings.push(`G2 ${sp.id}: не покрыт ни одним AD и не помечен gap:true`);
    }
  }
}

function lintSpecRoadmap(
  coverableIds: Set<string>,
  roadmapPath: string,
  findings: string[],
): { nAc: number; nPhase: number } {
  if (!fs.existsSync(roadmapPath)) {
    findings.push(`файл не найден: ${roadmapPath}`);
    return { nAc: 0, nPhase: 0 };
  }
  const acs = parseBlocks(roadmapPath, "ac");
  const phases = parseBlocks(roadmapPath, "phase");
  if (!acs.length && !phases.length) {
    findings.push("ROADMAP: не найдено ни одного ```ac|phase-блока (формат нарушен)");
  }

  const checkCovers = (block: Record<string, string>, label: string) => {
    const covers = (block.covers || "").split(",").map((c) => c.trim()).filter(Boolean);
    if (!covers.length) {
      findings.push(`G2 ${block.id}: covers пуст (${label} не привязан к spec)`);
      return;
    }
    for (const c of covers) {
      if (!coverableIds.has(c)) {
        findings.push(`G2 ${block.id}: covers ссылается на несуществующий ${c} (фантом)`);
      }
    }
  };

  for (const ac of acs) checkCovers(ac, "AC");
  for (const ph of phases) checkCovers(ph, "phase");
  return { nAc: acs.length, nPhase: phases.length };
}

/**
 * Runs generation-appropriate gate axes. findings.length===0 -> PASS.
 *
 * @param adrPath Legacy ADR path (required for sp-adr). Ignored for spec-roadmap.
 * @param options.generation Explicit generation or read from task.
 * @param options.roadmapPath When set under spec-roadmap, runs second axis.
 */
export function gateLint(
  taskPath: string,
  specPath: string,
  adrPath: string | null | undefined,
  repoRoot: string,
  options?: GateLintOptions,
): GateResult {
  const gen = resolveGeneration(taskPath, options);

  if (!fs.existsSync(taskPath)) return emptyResult([`файл не найден: ${taskPath}`]);
  if (!fs.existsSync(specPath)) return emptyResult([`файл не найден: ${specPath}`]);

  const findings: string[] = [];
  const { sps, frs, spIds, coverableIds } = lintSourceSpecFr(taskPath, specPath, repoRoot, findings);

  if (gen === "spec-roadmap") {
    let nAc = 0;
    let nPhase = 0;
    if (options?.roadmapPath) {
      const r = lintSpecRoadmap(coverableIds, options.roadmapPath, findings);
      nAc = r.nAc;
      nPhase = r.nPhase;
    }
    return {
      findings,
      nSp: sps.length,
      nAd: 0,
      nFr: frs.length,
      nAc,
      nPhase,
    };
  }

  // Legacy sp-adr
  if (!adrPath || !fs.existsSync(adrPath)) {
    findings.push(`файл не найден: ${adrPath || "<adr>"}`);
    return { findings, nSp: sps.length, nAd: 0, nFr: frs.length, nAc: 0, nPhase: 0 };
  }
  const ads = parseBlocks(adrPath, "adr");
  lintSpecAdr(sps, spIds, ads, findings);
  return {
    findings,
    nSp: sps.length,
    nAd: ads.length,
    nFr: frs.length,
    nAc: 0,
    nPhase: 0,
  };
}
