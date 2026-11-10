/**
 * gate-lint (T7-3) — TS port (promoted to core, single implementation) of
 * `tools/gate_lint.py` / former `.omp/tools/_lib/gatelint.ts`. Deterministic
 * two-stage design-gate (INV-4). Model-agnostic: code does not rationalize
 * defects into a PASS (unlike an LLM-lead).
 *
 * Gate-1 (source ↔ spec): each SP carries a source-ref resolving into real
 *   non-empty lines of the task-file.
 * Gate-2 (spec ↔ ADR): each SP is covered by >=1 AD.covers OR marked gap:true;
 *   every covers-id must exist in spec (no phantoms).
 * Gate-3 (EARS, P9 B.1a): each FR-* (functional requirement) carries a
 *   source-ref + a valid EARS-template (core-3: ubiquitous/event/unwanted).
 *   FR is CONDITIONAL — 0 FR-blocks = OK (meta/constraint task); only
 *   present FR-blocks are linted. gate_lint = EARS SYNTAX (structure);
 *   semantics (testable / right pattern) is a critic concern.
 *
 * Pure `gateLint(...)` (no process.exit, no argv) — the thin CLI shell lives
 * in `./gate-lint-cli.ts` (same pure-core/thin-shell split as
 * `../zone/zone-check.ts` / `zone-check-cli.ts`).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const BLOCK_RE = /```(spec|sp|adr|ad|fr)\s*\n([\s\S]*?)```/g;
const SRC_RE = /^([^#]+)#L(\d+)(?:-L?(\d+))?$/;

type BlockKind = "spec" | "adr" | "fr";

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
    const blockKind = canonicalBlockKind(m[1]);
    if (blockKind !== kind) continue;
    const entry: Record<string, string> = {};
    for (let line of m[2].split("\n")) {
      // spec/fr source содержит '#Lx' → режем только трейлинг-коммент ' # ...'; adr — весь #-хвост
      line = blockKind === "adr" ? line.split("#", 1)[0].replace(/\s+$/, "") : line.replace(/\s+#\s.*$/, "").replace(/\s+$/, "");
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
  const f = path.resolve(repoRoot, mm[1]);
  if (!fs.existsSync(f)) return { ok: false, msg: `source-file не найден: ${mm[1]}` };
  // splitlines-семантика (паритет с python .splitlines()): роняем один трейлинг-newline перед
  // split, иначе "a\n" даёт лишнюю пустую строку → расходится счётчик длины со splitlines().
  const lines = fs.readFileSync(f, "utf8").replace(/\r?\n$/, "").split(/\r?\n/);
  const start = parseInt(mm[2], 10);
  const end = mm[3] ? parseInt(mm[3], 10) : start;
  if (start < 1 || end > lines.length || start > end)
    return { ok: false, msg: `диапазон L${start}-L${end} вне файла (всего ${lines.length} строк)` };
  if (!lines.slice(start - 1, end).join("\n").trim())
    return { ok: false, msg: `строки L${start}-L${end} пусты` };
  return { ok: true, msg: "" };
}

/** Runs the two(+one)-stage gate. findings.length===0 -> PASS. */
export function gateLint(taskPath: string, specPath: string, adrPath: string, repoRoot: string): GateResult {
  for (const p of [taskPath, specPath, adrPath])
    if (!fs.existsSync(p)) return { findings: [`файл не найден: ${p}`], nSp: 0, nAd: 0, nFr: 0 };

  const sps = parseBlocks(specPath, "spec");
  const ads = parseBlocks(adrPath, "adr");
  const frs = parseBlocks(specPath, "fr");   // FR живёт в spec (problem-space: WHAT система делает)
  const findings: string[] = [];
  if (!sps.length) findings.push("SPEC: не найдено ни одного ```spec|sp-блока (формат нарушен)");
  if (!ads.length) findings.push("ADR: не найдено ни одного ```adr|ad-блока (формат нарушен)");

  // Gate-1: SP ↔ source
  const spIds = new Set<string>();
  for (const sp of sps) {
    spIds.add(sp.id);
    const src = sp.source || "";
    if (!src) { findings.push(`G1 ${sp.id}: нет source-ref`); continue; }
    const r = checkSourceRef(src, repoRoot);
    if (!r.ok) findings.push(`G1 ${sp.id}: ${r.msg}`);
  }

  // Gate-2: SP ↔ AD coverage
  const covered = new Set<string>();
  for (const ad of ads) {
    const covers = (ad.covers || "").split(",").map((c) => c.trim()).filter(Boolean);
    if (!covers.length) findings.push(`G2 ${ad.id}: covers пуст (решение ничего не покрывает)`);
    for (const c of covers) {
      if (!spIds.has(c)) findings.push(`G2 ${ad.id}: covers ссылается на несуществующий ${c} (фантом)`);
      else covered.add(c);
    }
  }
  for (const sp of sps)
    if (!covered.has(sp.id) && (sp.gap || "").toLowerCase() !== "true")
      findings.push(`G2 ${sp.id}: не покрыт ни одним AD и не помечен gap:true`);

  // Gate-3: FR ↔ source + EARS-syntax (FR conditional — 0 FR-blocks = OK)
  for (const fr of frs) {
    const src = fr.source || "";
    if (!src) findings.push(`G1 ${fr.id}: FR нет source-ref`);
    else {
      const r = checkSourceRef(src, repoRoot);
      if (!r.ok) findings.push(`G1 ${fr.id}: ${r.msg}`);
    }
    const e = earsCheck(fr);
    if (e) findings.push(`G3 ${fr.id}: ${e}`);
  }

  return { findings, nSp: sps.length, nAd: ads.length, nFr: frs.length };
}
