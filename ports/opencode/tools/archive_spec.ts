// archive_spec — delta→archive живая спека как нативный OpenCode-тул (порт OMP tools/archive_spec.ts).
// Накапливает requirements (SP+FR блоки) из завершённого change-spec в канон docs/spec/<capability>.md.
// Merge = ГИБРИД ID+модель: детерминир. ID-common-path (ADD/SKIP/COLLISION) + claude -p на трудное
//   (reconcile коллизий statement + cross-ID семантик-dedupe). Ручной вызов lead'ом.
import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseBlocksRaw, mergeCanon, emitCanon, injectFrom, buildDedupePrompt, applyDedupe, type RawBlock } from "../lib/archivespec";
import { ok, err } from "../lib/result";
import { exec } from "../lib/exec";

const BLOCK_RE = /```(spec|fr)\s*\n([\s\S]*?)```/;

/** claude -p как чистый ризонер над переданным текстом (без файл-тулов). Возврат result-текста. */
async function claudeReason(
  cwd: string, model: string, prompt: string,
): Promise<{ code: number; text: string; costUsd?: number }> {
  const r = await exec("claude", ["-p", prompt, "--model", model, "--output-format", "json", "--allowedTools", ""], { cwd });
  let text = r.stdout, costUsd: number | undefined;
  try { const j = JSON.parse(r.stdout); text = typeof j.result === "string" ? j.result : r.stdout; costUsd = j.total_cost_usd; } catch { /* raw */ }
  return { code: r.code, text: text.trim(), costUsd };
}

export default tool({
  description:
    "Merge'ит requirements (SP+FR) из change-spec в канон docs/spec/<capability>.md по id " +
    "(ADD/SKIP/COLLISION детерминир.). reconcile=true → claude примиряет statement-коллизии; " +
    "dedupe=true → claude ищет cross-id семантик-дубли. ADR не архивируется (канон = requirements).",
  args: {
    change: tool.schema.string().describe("change-spec (docs/design/<id>-spec.md)"),
    capability: tool.schema.string().optional().describe("канон docs/spec/<cap>.md (дефолт system)"),
    specDir: tool.schema.string().optional().describe("дир канона (дефолт docs/spec)"),
    reconcile: tool.schema.boolean().optional().describe("claude примиряет statement-коллизии"),
    dedupe: tool.schema.boolean().optional().describe("claude ищет cross-id семантик-дубли"),
    model: tool.schema.string().optional().describe("модель для reconcile/dedupe (дефолт sonnet)"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
    const changeP = path.resolve(cwd, params.change);
    if (!fs.existsSync(changeP)) return err("change-spec не найден: " + params.change);
    const capability = params.capability || "system";
    const specDir = params.specDir || "docs/spec";
    const model = params.model || "sonnet";
    const changeId = path.basename(changeP, ".md").replace(/-spec$/, "");
    const canonP = path.resolve(cwd, specDir, `${capability}.md`);

    const incoming: RawBlock[] = parseBlocksRaw(fs.readFileSync(changeP, "utf8"));
    if (!incoming.length) return ok(`change '${changeId}': нет SP/FR-блоков для архива — nothing to merge`);
    const canonText = fs.existsSync(canonP) ? fs.readFileSync(canonP, "utf8") : "";

    const dry = mergeCanon(incoming, canonText, changeId);
    const log: string[] = [`=== ARCHIVE ${changeId} → ${path.relative(cwd, canonP).replace(/\\/g, "/")} (cap=${capability}) ===`];
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
        const r = await claudeReason(cwd, model, prompt);
        totalCost += r.costUsd || 0;
        const mm = BLOCK_RE.exec(r.text);
        if (r.code === 0 && mm) reconcileMap.set(fid, mm[2].replace(/\n+$/, ""));
      }
    }
    const merged = mergeCanon(incoming, canonText, changeId, (fid) => reconcileMap.get(fid) ?? null);

    // cross-ID семантик-dedupe: claude ищет пары (РАЗНЫЙ id, ТОТ ЖЕ смысл); логика в lib (тестируемо).
    const dupNotes: string[] = [];
    if (params.dedupe && merged.canon.length > 1) {
      const r = await claudeReason(cwd, model, buildDedupePrompt(merged.canon));
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
});
