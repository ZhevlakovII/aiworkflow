// archive_spec — delta→archive living spec (deterministic merge; optional reconcile/dedupe).
import * as fs from "node:fs";
import * as path from "node:path";
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import {
  parseBlocksRaw,
  mergeCanon,
  emitCanon,
  injectFrom,
  buildDedupePrompt,
  applyDedupe,
} from "./_lib/archivespec.ts";
import { runDshText } from "./_lib/dshtext.ts";
import { ok, err } from "./_lib/result";

const BLOCK_RE = /```(spec|fr)\s*\n([\s\S]*?)```/;

async function dshReason(
  cwd: string,
  model: string,
  prompt: string,
  ctxExec?: DshToolContext["exec"],
): Promise<{ code: number; text: string; costUsd?: number }> {
  const r = await runDshText(cwd, model, "", prompt, ctxExec);
  return { code: r.code, text: r.text.trim(), costUsd: r.costUsd };
}

export function registerArchiveSpec(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "archive_spec",
    description:
      "Merge SP/FR из change-spec в docs/spec/<capability>.md. reconcile/dedupe — opt-in (nested harness).",
    parameters: {
      type: "object",
      properties: {
        change: { type: "string", description: "change-spec path" },
        capability: { type: "string", description: "канон cap (дефолт system)" },
        specDir: { type: "string", description: "дефолт docs/spec" },
        reconcile: { type: "boolean", description: "resolve statement collisions" },
        dedupe: { type: "boolean", description: "cross-id semantic dedupe" },
        model: { type: "string", description: "модель reconcile/dedupe (дефолт sonnet)" },
      },
      required: ["change"],
    },
    async execute(params) {
      const cwd = ctx.cwd;
      const changeP = path.resolve(cwd, String(params.change));
      if (!fs.existsSync(changeP)) return emitToolResult(err("change-spec не найден: " + params.change));
      const capability = (params.capability as string) || "system";
      const specDir = (params.specDir as string) || "docs/spec";
      const model = (params.model as string) || "sonnet";
      const changeId = path.basename(changeP, ".md").replace(/-spec$/, "");
      const canonP = path.resolve(cwd, specDir, `${capability}.md`);

      const incoming = parseBlocksRaw(fs.readFileSync(changeP, "utf8"));
      if (!incoming.length) return emitToolResult(ok(`change '${changeId}': нет SP/FR-блоков — nothing to merge`));
      const canonText = fs.existsSync(canonP) ? fs.readFileSync(canonP, "utf8") : "";

      const dry = mergeCanon(incoming, canonText, changeId);
      const log: string[] = [
        `=== ARCHIVE ${changeId} → ${path.relative(cwd, canonP).replace(/\\/g, "/")} (cap=${capability}) ===`,
      ];
      let totalCost = 0;

      const reconcileMap = new Map<string, string>();
      if (params.reconcile && dry.collisions.length) {
        if (process.env.DSH_ONESHOT !== "1" && !ctx.exec) {
          return emitToolResult(
            err("reconcile требует DSH_ONESHOT=1 или ctx.exec — иначе только детерминир. merge без reconcile"),
          );
        }
        const canonBlocks = parseBlocksRaw(canonText);
        for (const fid of dry.collisions) {
          const oldB = canonBlocks.find((b) => b.fields.id === fid)?.body || "";
          const newB = injectFrom(incoming.find((b) => b.fields.id === fid)!.body, changeId);
          const prompt =
            "Две версии requirement-блока (id совпал). Верни ОДИН fenced ```spec|fr блок.\n\nСТАРЫЙ:\n" +
            oldB +
            "\n\nНОВЫЙ:\n" +
            newB;
          const r = await dshReason(cwd, model, prompt, ctx.exec);
          totalCost += r.costUsd || 0;
          const mm = BLOCK_RE.exec(r.text);
          if (r.code === 0 && mm) reconcileMap.set(fid, mm[2].replace(/\n+$/, ""));
        }
      }
      const merged = mergeCanon(incoming, canonText, changeId, (fid) => reconcileMap.get(fid) ?? null);

      const dupNotes: string[] = [];
      if (params.dedupe && merged.canon.length > 1) {
        if (process.env.DSH_ONESHOT !== "1" && !ctx.exec) {
          dupNotes.push("dedupe: nested harness unavailable (пропущено)");
        } else {
          const r = await dshReason(cwd, model, buildDedupePrompt(merged.canon), ctx.exec);
          totalCost += r.costUsd || 0;
          if (r.code === 0) {
            const d = applyDedupe(merged.canon, r.text);
            merged.canon = d.canon;
            dupNotes.push(...d.notes);
          } else dupNotes.push("dedupe: model недоступен (пропущено)");
        }
      }

      fs.mkdirSync(path.dirname(canonP), { recursive: true });
      fs.writeFileSync(canonP, emitCanon(capability, merged.canon), "utf8");

      log.push(
        `ADD:${merged.added.length} SKIP:${merged.skipped.length} RECONCILED:${merged.reconciled.length} COLLISION:${merged.collisions.length} DEDUP:${dupNotes.length}`,
      );
      merged.added.forEach((f) => log.push(`  + ${f}`));
      merged.reconciled.forEach((f) => log.push(`  ~ ${f} (reconciled)`));
      dupNotes.forEach((n) => log.push(`  ⊇ ${n}`));
      merged.collisions.forEach((f) => log.push(`  ! ${f} (COLLISION — не решено)`));
      if (totalCost) log.push(`  (~$${totalCost.toFixed(2)})`);
      if (merged.collisions.length) {
        return emitToolResult(
          err(log.join("\n") + "\nARCHIVE: BLOCKED (коллизии — reconcile=true или разведи id)"),
        );
      }
      return emitToolResult(ok(log.join("\n") + "\nARCHIVE: OK"));
    },
  });
}
