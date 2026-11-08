// archive_spec — delta→archive живая спека как НАТИВНЫЙ OMP-тул (P9 B.2b, TS-порт archive_spec.py).
// Накапливает requirements (SP+FR блоки) из завершённого change-spec в канон docs/spec/<capability>.md.
// Merge = ГИБРИД ID+модель: детерминир. ID-common-path (ADD/SKIP/COLLISION) + claude -p на трудное
//   (reconcile коллизий statement + cross-ID семантик-dedupe — разный id, тот же смысл требования).
// Автотриггерится queue-runner на task-done (B.2b); ручной вызов lead'ом тоже возможен.
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseBlocksRaw, mergeCanon, emitCanon, injectFrom, buildDedupePrompt, applyDedupe, type RawBlock } from "./_lib/archivespec";
import { ok, err } from "./_lib/result";

const BLOCK_RE = /```(spec|fr)\s*\n([\s\S]*?)```/;

/** omp -p как чистый ризонер над переданным текстом (без файл-тулов). B4: no pi.exec("claude"). */
async function claudeReason(
  pi: { exec: (c: string, a: string[], o: { cwd: string }) => Promise<{ code: number; stdout: string; stderr: string }> },
  cwd: string, model: string, prompt: string,
): Promise<{ code: number; text: string; costUsd?: number }> {
  // Same argv shape as backend.ts omp branch; no tools (prompt embeds content).
  const r = await pi.exec(
    "omp",
    ["-p", prompt, "--model", model, "--mode", "json", "--tools", "", "--no-extensions",
     "--add-dir", cwd, "--cwd", cwd, "--approval-mode", "yolo"],
    { cwd },
  );
  let text = r.stdout;
  let costUsd: number | undefined;
  let cost = 0;
  let anyCost = false;
  const parts: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(s); } catch { continue; }
    const msg = (j.message ?? j) as Record<string, unknown>;
    const u = msg.usage as Record<string, unknown> | undefined;
    const c = (u?.cost as Record<string, unknown> | undefined)?.total;
    if (c != null) { cost += Number(c); anyCost = true; }
    const content = msg.content ?? j.content ?? j.result ?? j.text;
    if (typeof content === "string" && content.trim()) parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "string" && block.trim()) parts.push(block);
        else if (block && typeof block === "object" && typeof (block as { text?: string }).text === "string") {
          const t = (block as { text: string }).text;
          if (t.trim()) parts.push(t);
        }
      }
    }
  }
  if (parts.length) text = parts.join("\n");
  if (anyCost) costUsd = cost;
  return { code: r.code, text: text.trim(), costUsd };
}

const factory: CustomToolFactory = (pi) => {
  return {
    name: "archive_spec",
    label: "Archive change-spec → living canon",
    loadMode: "essential",
    description:
      "Merge'ит requirements (SP+FR) из change-spec в канон docs/spec/<capability>.md по id " +
      "(ADD/SKIP/COLLISION детерминир.). reconcile=true → claude примиряет statement-коллизии; " +
      "dedupe=true → claude ищет cross-id семантик-дубли (разный id, тот же смысл). " +
      "Автотриггер на task-done; ADR не архивируется (канон = requirements).",
    parameters: pi.zod.object({
      change: pi.zod.string().describe("change-spec (docs/design/<id>-spec.md)"),
      capability: pi.zod.string().optional().describe("канон docs/spec/<cap>.md (дефолт system)"),
      specDir: pi.zod.string().optional().describe("дир канона (дефолт docs/spec)"),
      reconcile: pi.zod.boolean().optional().describe("claude примиряет statement-коллизии (B.2b)"),
      dedupe: pi.zod.boolean().optional().describe("claude ищет cross-id семантик-дубли (B.2b #4c)"),
      model: pi.zod.string().optional().describe("модель для reconcile/dedupe (дефолт sonnet)"),
    }),
    async execute(_id, params) {
      const changeP = path.resolve(pi.cwd, params.change);
      if (!fs.existsSync(changeP)) return err("change-spec не найден: " + params.change);
      const capability = params.capability || "system";
      const specDir = params.specDir || "docs/spec";
      const model = params.model || "sonnet";
      const changeId = path.basename(changeP, ".md").replace(/-spec$/, "");
      const canonP = path.resolve(pi.cwd, specDir, `${capability}.md`);

      const incoming: RawBlock[] = parseBlocksRaw(fs.readFileSync(changeP, "utf8"));
      if (!incoming.length) return ok(`change '${changeId}': нет SP/FR-блоков для архива — nothing to merge`);
      const canonText = fs.existsSync(canonP) ? fs.readFileSync(canonP, "utf8") : "";

      // reconcile-колбэк (синхронный контракт mergeCanon) → предвычисляем коллизии асинхронно, потом merge.
      // Проще: сначала dry-merge без reconcile для выявления коллизий, затем при reconcile гоняем claude,
      // затем финальный merge с map-колбэком.
      const dry = mergeCanon(incoming, canonText, changeId);
      const log: string[] = [`=== ARCHIVE ${changeId} → ${path.relative(pi.cwd, canonP).replace(/\\/g, "/")} (cap=${capability}) ===`];
      let totalCost = 0;

      const reconcileMap = new Map<string, string>();
      if (params.reconcile && dry.collisions.length) {
        const canonBlocks = parseBlocksRaw(canonText);
        for (const fid of dry.collisions) {
          const oldB = canonBlocks.find((b) => b.fields.id === fid)?.body || "";
          const newB = injectFrom(incoming.find((b) => b.fields.id === fid)!.body, changeId);
          const prompt =
            "Две версии одного requirement-блока (совпал id, разошёлся statement). Реши: какая актуальна, " +
            "или слей. Верни ОДИН fenced-блок того же вида (```spec или ```fr) с корректными полями " +
            `(id/from/source/statement[/pattern]). Новее — из change '${changeId}'.\n\nСТАРЫЙ:\n${oldB}\n\nНОВЫЙ:\n${newB}`;
          const r = await claudeReason(pi, pi.cwd, model, prompt);
          totalCost += r.costUsd || 0;
          const mm = BLOCK_RE.exec(r.text);
          if (r.code === 0 && mm) reconcileMap.set(fid, mm[2].replace(/\n+$/, ""));
        }
      }
      const merged = mergeCanon(incoming, canonText, changeId, (fid, o, n) => reconcileMap.get(fid) ?? null);

      // #4c cross-ID семантик-dedupe: claude ищет пары (РАЗНЫЙ id, ТОТ ЖЕ смысл); логика в lib (тестируемо).
      const dupNotes: string[] = [];
      if (params.dedupe && merged.canon.length > 1) {
        const r = await claudeReason(pi, pi.cwd, model, buildDedupePrompt(merged.canon));
        totalCost += r.costUsd || 0;
        if (r.code === 0) {
          const d = applyDedupe(merged.canon, r.text);
          merged.canon = d.canon;
          dupNotes.push(...d.notes);
        } else dupNotes.push("dedupe: claude недоступен (пропущено)");
      }

      fs.mkdirSync(path.dirname(canonP), { recursive: true });
      fs.writeFileSync(canonP, emitCanon(capability, merged.canon), "utf8");

      log.push(`ADD:${merged.added.length} SKIP:${merged.skipped.length} RECONCILED:${merged.reconciled.length} COLLISION:${merged.collisions.length} DEDUP:${dupNotes.length}`);
      merged.added.forEach((f) => log.push(`  + ${f}`));
      merged.reconciled.forEach((f) => log.push(`  ~ ${f} (reconciled)`));
      dupNotes.forEach((n) => log.push(`  ⊇ ${n}`));
      merged.collisions.forEach((f) => log.push(`  ! ${f} (COLLISION — не решено)`));
      if (totalCost) log.push(`  (~$${totalCost.toFixed(2)})`);
      if (merged.collisions.length) return err(log.join("\n") + "\nARCHIVE: BLOCKED (коллизии — вызови с reconcile=true или разведи id)");
      return ok(log.join("\n") + "\nARCHIVE: OK");
    },
  };
};

export default factory;
