// gated_merge — L3 merge-рельс, thin OpenCode-tool wrapper over
// core/src/rails/merge.ts::gatedMerge (B3 rebind,
// .workflow/tasks/phase-b3-rails-rebind.md). git through nodeGitSeam
// (sync, Bun-compatible). CAPABILITY-PROBE, trailer, rollback — all in the
// core rail; this wrapper only resolves argv -> Options (contract L-3).
import { tool } from "@opencode-ai/plugin";
import * as path from "node:path";
import { railDeps, resolveGateCmd, toToolResult } from "../lib/rail";
import { gatedMerge } from "../../../core/src/rails/merge.ts";

export default tool({
  description:
    "Автономный merge (raw `git merge` заблокирован). Core-рельс CAPABILITY-PROBE по классу: green-gate / " +
    "clean-rebase / forced-critic (feature,refactor) / rollback. Недоступна → insufficient (мёржит человек). " +
    "security/migration — нужен allowRisky. Секвенс: probe → merge --no-ff → трейлер [omp-rail:merge] → " +
    "свежий gate на результате → RED? откат. Gate: явный gate → зона task-file (design/gate-setup) → " +
    "policy.quality_gate.cmd (`.workflow/gate.cmd` больше НЕ читается). dryRun останавливается после probe.",
  args: {
    branch: tool.schema.string().describe("feature-ветка для merge"),
    base: tool.schema.string().optional().describe("базовая ветка (дефолт main/master)"),
    class: tool.schema.string().optional().describe("класс задачи: feature|refactor|trivial|security|migration"),
    findings: tool.schema.string().optional().describe("critic findings-файл (forced-critic для feature/refactor)"),
    gate: tool.schema
      .string()
      .optional()
      .describe("явная gate-команда на merge-результат — приоритет над зоной task-file и policy.quality_gate.cmd"),
    task: tool.schema
      .string()
      .optional()
      .describe("путь к task-file — из его зоны строится gate-команда (design/gate-setup), если gate не задан"),
    allowRisky: tool.schema.boolean().optional().describe("явно разрешить L3 для security/migration"),
    dryRun: tool.schema.boolean().optional().describe("остановиться после capability-probe, ничего не мутировать"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
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
      // diverge from `ctx.directory` if they differ.
      findingsPath: params.findings ? path.resolve(cwd, params.findings) : undefined,
      gateCmd: gate.gateCmd,
      allowRisky: params.allowRisky,
      dryRun: params.dryRun,
    });
    return toToolResult(result);
  },
});
