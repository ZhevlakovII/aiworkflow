// archivespec (TS-порт tools/archive_spec.py) — delta→archive живая спека (P9 B.2b).
// Чистая merge-логика (детерминир.), без I/O claude — reconcile/dedupe инъектятся колбэком из тула.
// Канон docs/spec/<capability>.md копит requirements (SP+FR блоки) по id: new→ADD (from:<change>),
// same-statement→SKIP, diff-statement→COLLISION (reconcile-колбэк решает). ADR не архивируем.

export type ReqKind = "spec" | "fr";
export interface RawBlock { kind: ReqKind; fields: Record<string, string>; body: string; }

const BLOCK_RE = /```(spec|adr|fr)\s*\n([\s\S]*?)```/g;
const REQ_KINDS: ReqKind[] = ["spec", "fr"];

/** Парсит req-блоки (spec|fr), сохраняя тело дословно. adr игнорится. */
export function parseBlocksRaw(text: string): RawBlock[] {
  const out: RawBlock[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const kind = m[1];
    if (kind !== "spec" && kind !== "fr") continue;
    const body = m[2];
    const fields: Record<string, string> = {};
    for (const line of body.split("\n")) {
      const ln = line.replace(/\s+#\s.*$/, "").replace(/\s+$/, "");
      const idx = ln.indexOf(":");
      if (idx < 0) continue;
      fields[ln.slice(0, idx).trim()] = ln.slice(idx + 1).trim();
    }
    if (fields.id) out.push({ kind: kind as ReqKind, fields, body: body.replace(/\n+$/, "") });
  }
  return out;
}

/** Вставить `from: <change-id>` после строки id: (идемпотентно). */
export function injectFrom(body: string, changeId: string): string {
  if (/^\s*from:/m.test(body)) return body;
  const out: string[] = [];
  for (const line of body.split("\n")) {
    out.push(line);
    if (/^\s*id:/.test(line)) out.push(`from: ${changeId}`);
  }
  return out.join("\n");
}

export function stmt(body: string): string {
  const m = body.match(/^\s*statement:\s*(.+?)\s*$/m);
  return m ? m[1].trim() : "";
}

export function emitCanon(capability: string, blocks: Array<{ kind: ReqKind; body: string }>): string {
  const parts = [
    `# Living spec: ${capability}`,
    "",
    "_Накопительная система-спека (P9 B.2, archive_spec). Копится merge'ем из change-specs " +
      "по FR/SP-id. НЕ редактировать вручную — источник истины = change-specs + этот merge._",
    "",
  ];
  for (const b of blocks) { parts.push("```" + b.kind, b.body, "```", ""); }
  return parts.join("\n").replace(/\s+$/, "") + "\n";
}

export interface MergeResult {
  canon: Array<{ kind: ReqKind; body: string }>;
  added: string[];
  skipped: string[];
  collisions: string[];
  reconciled: string[];
}
/** Reconcile-колбэк: старое+новое тело коллизии → примирённое тело (или null=не решено). */
export type ReconcileFn = (id: string, oldBody: string, newBody: string) => string | null;

function blockId(body: string): string { return (body.match(/^\s*id:\s*(\S+)/m) || [])[1] || "?"; }
function blockStmt(body: string): string { return (body.match(/^\s*statement:\s*(.+)$/m) || [])[1] || ""; }

/** #4c: промпт для cross-ID семантик-dedupe (claude ищет разный-id/один-смысл). Чистая функция. */
export function buildDedupePrompt(canon: Array<{ kind: ReqKind; body: string }>): string {
  const listing = canon.map((b, i) => `[${i}] id=${blockId(b.body)} :: ${blockStmt(b.body)}`).join("\n");
  return (
    "Ниже список requirement-блоков живой спеки (индекс, id, statement). Найди пары с РАЗНЫМ id, " +
    "но выражающие ОДНО И ТО ЖЕ требование (семантический дубль). Верни СТРОГО JSON-массив " +
    '[{"keep":<idx>,"drop":<idx>,"reason":"..."}] (пусто [] если дублей нет). Только явные дубли, ' +
    "не близкие-но-разные.\n\n" + listing
  );
}

/** #4c: применить claude-ответ (JSON пар) к канону — дропнуть дубли. Чистая, детерминир. Возвращает
 *  новый канон + notes (что слито). Некорректный JSON → канон без изменений + note. */
export function applyDedupe(
  canon: Array<{ kind: ReqKind; body: string }>,
  claudeText: string,
): { canon: Array<{ kind: ReqKind; body: string }>; notes: string[] } {
  const notes: string[] = [];
  try {
    const jm = claudeText.match(/\[[\s\S]*\]/);
    const pairs: Array<{ keep: number; drop: number; reason: string }> = jm ? JSON.parse(jm[0]) : [];
    const dropIdx = new Set<number>();
    for (const p of pairs) {
      if (p.drop >= 0 && p.drop < canon.length && p.keep !== p.drop && !dropIdx.has(p.drop)) {
        dropIdx.add(p.drop);
        notes.push(`${blockId(canon[p.drop].body)} ⊇ ${blockId(canon[p.keep]?.body || "")} (${p.reason})`);
      }
    }
    if (dropIdx.size) return { canon: canon.filter((_, i) => !dropIdx.has(i)), notes };
  } catch { notes.push("dedupe: claude-ответ не распарсился (пропущено)"); }
  return { canon, notes };
}

/** Детерминир. ID-merge incoming в канон. reconcile — опц. колбэк на коллизии (B.2b). */
export function mergeCanon(
  incoming: RawBlock[],
  canonText: string,
  changeId: string,
  reconcile?: ReconcileFn,
): MergeResult {
  const canon: Array<{ kind: ReqKind; body: string }> = [];
  const byId = new Map<string, number>();
  for (const b of parseBlocksRaw(canonText)) { byId.set(b.fields.id, canon.length); canon.push({ kind: b.kind, body: b.body }); }

  const added: string[] = [], skipped: string[] = [], collisions: string[] = [], reconciled: string[] = [];
  for (const b of incoming) {
    const fid = b.fields.id;
    const newBody = injectFrom(b.body, changeId);
    if (!byId.has(fid)) { byId.set(fid, canon.length); canon.push({ kind: b.kind, body: newBody }); added.push(fid); continue; }
    const idx = byId.get(fid)!;
    if (stmt(canon[idx].body) === stmt(newBody)) { skipped.push(fid); continue; }
    if (reconcile) {
      const merged = reconcile(fid, canon[idx].body, newBody);
      if (merged) { canon[idx] = { kind: b.kind, body: injectFrom(merged, changeId) }; reconciled.push(fid); continue; }
    }
    collisions.push(fid);
  }
  return { canon, added, skipped, collisions, reconciled };
}
