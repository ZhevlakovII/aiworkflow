// gated_merge — L3 merge-рельс, thin OMP-tool wrapper over
// core/src/rails/merge.ts::gatedMerge (B3 rebind,
// .workflow/tasks/phase-b3-rails-rebind.md). git through nodeGitSeam
// (sync, Bun-compatible). CAPABILITY-PROBE, trailer, rollback — all in the
// core rail; this wrapper only resolves argv -> Options (contract L-3).
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { railDeps, resolveGateCmd, toToolResult } from "./_lib/rail";
import { gatedMerge } from "../../../core/src/rails/merge.ts";

const factory: CustomToolFactory = (pi) => {
  return {
    name: "gated_merge",
    label: "Gated merge (L3)",
    loadMode: "essential",
    description:
      "Автономный merge (raw `git merge` заблокирован). Core-рельс CAPABILITY-PROBE по классу: green-gate / " +
      "clean-rebase / forced-critic (feature,refactor) / rollback. Недоступна → insufficient (мёржит человек). " +
      "security/migration — нужен allowRisky. Секвенс: probe → merge --no-ff → трейлер [omp-rail:merge] → " +
      "свежий gate на результате → RED? откат. Gate: явный --gate → зона task-file (design/gate-setup) → " +
      "policy.quality_gate.cmd (`.workflow/gate.cmd` больше НЕ читается). --dryRun останавливается после probe.",
    parameters: pi.zod.object({
      branch: pi.zod.string().describe("feature-ветка для merge"),
      base: pi.zod.string().optional().describe("базовая ветка (дефолт main/master)"),
      class: pi.zod.string().optional().describe("класс задачи: feature|refactor|trivial|security|migration"),
      findings: pi.zod.string().optional().describe("critic findings-файл (forced-critic для feature/refactor)"),
      gate: pi.zod
        .string()
        .optional()
        .describe("явная gate-команда на merge-результат — приоритет над зоной task-file и policy.quality_gate.cmd"),
      task: pi.zod
        .string()
        .optional()
        .describe("путь к task-file — из его зоны строится gate-команда (design/gate-setup), если --gate не задан"),
      allowRisky: pi.zod.boolean().optional().describe("явно разрешить L3 для security/migration"),
      dryRun: pi.zod.boolean().optional().describe("остановиться после capability-probe, ничего не мутировать"),
    }),
    async execute(_id, params, _u, _ctx, _sig) {
      const cwd = pi.cwd;
      const gate = resolveGateCmd(cwd, params.gate, params.task);
      if (gate.error) return toToolResult({ ok: false, status: "guard-fail", detail: gate.error });

      const { policy, seam } = railDeps(cwd);
      const result = gatedMerge({
        git: seam,
        policy,
        branch: params.branch,
        base: params.base,
        klass: params.class,
        // Normalized to absolute (rail-cwd relative) BEFORE the core rail
        // reads it — `gatedMerge`'s own `existsSync`/`readFileSync` on
        // `findingsPath` is unqualified (relies on `process.cwd()`, same as
        // `core/src/rails/cli.ts`'s `--findings`), which would silently
        // diverge from the seam's `cwd` if they differ.
        findingsPath: params.findings ? path.resolve(cwd, params.findings) : undefined,
        gateCmd: gate.gateCmd,
        allowRisky: params.allowRisky,
        dryRun: params.dryRun,
      });
      return toToolResult(result);
    },
  };
};

export default factory;
