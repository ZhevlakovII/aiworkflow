// gate-lint (TS-порт tools/gate_lint.py) — детерминированный two-stage design-gate (INV-4).
// Модель-агностичен: код не рационализирует дефекты в PASS (в отличие от LLM-lead).
// Gate-1 (source↔spec): каждый SP несёт source-ref, резолвящийся в реальные непустые строки task-file.
// Gate-2 (spec↔ADR): каждый SP покрыт ≥1 AD.covers ИЛИ gap:true; каждый covers-id существует в spec.
// Gate-3 (EARS, P9 B.1a): FR-* (функц-требование) несёт source-ref + валидный EARS-шаблон (ядро-3
//   ubiquitous/event/unwanted). FR УСЛОВЕН — 0 FR-блоков = OK (мета/констрейнт-задача); линтим только
//   имеющиеся. gate_lint = СИНТАКС EARS (структура), семантика (testable/тот ли паттерн) — на critic.
import * as fs from "node:fs";
import * as path from "node:path";

const BLOCK_RE = /```(spec|adr|fr)\s*\n([\s\S]*?)```/g;
const SRC_RE = /^([^#]+)#L(\d+)(?:-L?(\d+))?$/;

export interface GateResult {
  findings: string[];
  nSp: number;
  nAd: number;
  nFr: number;
}

/** EARS-синтакс FR-блока (ядро-3). Возвращает finding-msg или "" (валиден). */
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

/** Вытащить fenced-блоки заданного вида, распарсить `key: value` строки. */
function parseBlocks(mdPath: string, kind: "spec" | "adr" | "fr"): Record<string, string>[] {
  const text = fs.readFileSync(mdPath, "utf8");
  const out: Record<string, string>[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    if (m[1] !== kind) continue;
    const entry: Record<string, string> = {};
    for (let line of m[2].split("\n")) {
      // spec-source содержит '#Lx' → режем только трейлинг-коммент ' # ...'; adr — весь #-хвост
      line = kind === "adr" ? line.split("#", 1)[0].replace(/\s+$/, "") : line.replace(/\s+#\s.*$/, "").replace(/\s+$/, "");
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      entry[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    if (entry.id) out.push(entry);
  }
  return out;
}

/** Резолвится ли source-ref в реальные непустые строки task-file. */
function checkSourceRef(ref: string, repoRoot: string): { ok: boolean; msg: string } {
  const mm = SRC_RE.exec(ref.trim());
  if (!mm) return { ok: false, msg: `source не в формате <file>#Lx[-Ly]: ${JSON.stringify(ref)}` };
  const f = path.resolve(repoRoot, mm[1]);
  if (!fs.existsSync(f)) return { ok: false, msg: `source-file не найден: ${mm[1]}` };
  // splitlines-семантика (паритет с python gate_lint.py): роняем один трейлинг-newline перед split,
  // иначе "a\n" даёт лишнюю пустую строку → расходится счётчик длины с .splitlines().
  const lines = fs.readFileSync(f, "utf8").replace(/\r?\n$/, "").split(/\r?\n/);
  const start = parseInt(mm[2], 10);
  const end = mm[3] ? parseInt(mm[3], 10) : start;
  if (start < 1 || end > lines.length || start > end)
    return { ok: false, msg: `диапазон L${start}-L${end} вне файла (всего ${lines.length} строк)` };
  if (!lines.slice(start - 1, end).join("\n").trim())
    return { ok: false, msg: `строки L${start}-L${end} пусты` };
  return { ok: true, msg: "" };
}

/** Прогоняет two-stage gate. findings.length===0 → PASS. */
export function gateLint(taskPath: string, specPath: string, adrPath: string, repoRoot: string): GateResult {
  for (const p of [taskPath, specPath, adrPath])
    if (!fs.existsSync(p)) return { findings: [`файл не найден: ${p}`], nSp: 0, nAd: 0, nFr: 0 };

  const sps = parseBlocks(specPath, "spec");
  const ads = parseBlocks(adrPath, "adr");
  const frs = parseBlocks(specPath, "fr");   // FR живёт в spec (problem-space: WHAT система делает)
  const findings: string[] = [];
  if (!sps.length) findings.push("SPEC: не найдено ни одного ```spec-блока (формат нарушен)");
  if (!ads.length) findings.push("ADR: не найдено ни одного ```adr-блока (формат нарушен)");

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

  // Gate-3: FR ↔ source + EARS-синтакс (FR условен — пусто = OK, линтим только имеющиеся)
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
