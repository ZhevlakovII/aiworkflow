// codex_worker — execute-стадия через CODEX как harness-subprocess воркер (dsh-seam, кросс-вендор).
// Зеркало execute_worker, но worker = `codex exec` (OpenAI-модель в codex-песочнице) вместо `claude -p`.
// Роадмап L-1/dsh-seam: worker = {OMP-субагент | харнесс-subprocess}; оба под ОДИН контракт
//   (isolated context, scoped paths, structured return). Единственный ToS-чистый способ дать
//   OpenAI-модель в OMP-флоу — через сам codex (его auth/песочница), не через OMP-провайдер.
//
// Контейнмент (проект-тезис enforcement>доверие): codex пишет в workspace (свой sandbox=workspace-write,
//   без сети), а НАСТОЯЩИЙ рельс — тот же commit-rail, что у execute_worker: zone-check + test-cmd +
//   FR-trace на коммите. Запись вне зоны ловится независимо от того, что сделал codex.
//
// PREFLIGHT: codex CLI + auth обязательны. Нет codex на PATH → чистый err с инструкцией (детерминир.,
//   тестируется без OpenAI-кредов). Live-прогон требует `npm i -g @openai/codex` + `codex login`/OPENAI_API_KEY.
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseZone, scalarField } from "./_lib/task";
import { zoneCheck } from "./_lib/zonecheck";
import { resolveAgent, loadZoneMap, type ZoneMap } from "./_lib/zonemap";
import { frTrace } from "./_lib/frtrace";
import { recordRun, recordGuard } from "./_lib/telemetry";
import { classifyError, errExcerpt, scanRequestErrors } from "./_lib/errclass";
import { ok, err } from "./_lib/result";

function rolePrompt(cwd: string, role: string): string {
  const p = path.resolve(cwd, ".omp/agents", `${role}.md`);
  if (!fs.existsSync(p)) return "";
  let text = fs.readFileSync(p, "utf8");
  if (text.startsWith("---")) { const parts = text.split("---"); if (parts.length >= 3) text = parts.slice(2).join("---"); }
  return text.trim();
}

function resolveDomain(cwd: string, taskText: string): { agent: string; note: string } {
  let zm: ZoneMap | null = null;
  try { zm = loadZoneMap(path.resolve(cwd, ".omp/zonemap.yml")); } catch { zm = null; }
  if (!zm) return { agent: "executor", note: "нет zonemap → generic executor" };
  const { allow } = parseZone(taskText);
  const r = resolveAgent(allow, zm);
  if (r.denied.length) return { agent: "executor", note: `deny-domain (${r.denied.join(",")})` };
  if (r.ambiguous) return { agent: "executor", note: `ambiguous (${r.matched.join(",")}) → executor` };
  return { agent: r.agent, note: r.agent === "executor" ? "нет домен-матча" : `домен ${r.tech} → ${r.agent}` };
}

function resolveSpec(cwd: string, taskText: string, tid: string): string | null {
  const field = scalarField(taskText, "spec");
  const cand = field ? path.resolve(cwd, field) : path.resolve(cwd, "docs/design", `${tid}-spec.md`);
  return fs.existsSync(cand) ? cand : null;
}

function workerPrompt(taskRel: string, sysPrompt: string): string {
  // codex exec — единый prompt (нет отдельного system-канала как у claude --append-system-prompt),
  // поэтому домен-роль вклеиваем в начало промпта.
  return (
    (sysPrompt ? `[Роль]\n${sysPrompt}\n\n` : "") +
    `[Задача]\nLocked task-file (ЕДИНСТВЕННЫЙ источник контракта, INV-1): ${taskRel}\n` +
    `Прочитай его и связанный код. Реализуй РОВНО то, что в контракте, по Definition of Done — код + тесты. ` +
    `Пиши файлы СТРОГО в пределах allow-зоны task-file, не выходи за зону, не переосмысливай дизайн. ` +
    `Если у change есть FR-* требования — покрой КАЖДОЕ тестом и укажи его FR-id в тесте (имя/комментарий). ` +
    `Не трогай .git/.omp. Верни одну строку: какие файлы создал.`
  );
}

const factory: CustomToolFactory = (pi) => {
  const git = (args: string[]) => pi.exec("git", args, { cwd: pi.cwd });

  return {
    name: "codex_worker",
    label: "Execute stage via Codex (harness-subprocess seam)",
    loadMode: "essential",
    description:
      "Execute-стадия через codex как кросс-вендор воркер (OpenAI-модель в codex-песочнице). Зеркало " +
      "execute_worker: resolve домен→codex exec пишет код+тест→zone-check→test-cmd→FR-trace→commit. " +
      "Требует установленного codex CLI + auth (иначе чистый preflight-err). Только stage:execute.",
    parameters: pi.zod.object({
      task: pi.zod.string().describe("путь к locked execute task-file"),
      model: pi.zod.string().optional().describe("codex-модель (дефолт gpt-5-codex)"),
      noCommit: pi.zod.boolean().optional(),
    }),
    async execute(_id, params) {
      const t0 = Date.now();
      // PREFLIGHT: codex доступен? (детерминир. — тестируется без OpenAI-кредов)
      let ver;
      try { ver = await pi.exec("codex", ["--version"], { cwd: pi.cwd }); } catch { ver = { code: 127, stdout: "", stderr: "" }; }
      if (!ver || ver.code !== 0) {
        recordRun(pi.cwd, { tool: "codex_worker", tid: "?", backend: "codex", outcome: "error", errClass: "cli-missing", errMsg: "codex CLI недоступен (preflight)", durationMs: Date.now() - t0 });
        return err(
          "PREFLIGHT: codex CLI недоступен (dsh-seam требует его).\n" +
          "→ Установи: npm i -g @openai/codex\n" +
          "→ Auth: codex login (или экспортируй OPENAI_API_KEY)\n" +
          "Пока codex нет — используй execute_worker (claude -p seam).",
        );
      }

      if ((await git(["rev-parse", "--git-dir"])).code !== 0) return err("не git-репо");
      const taskPath = path.resolve(pi.cwd, params.task);
      if (!fs.existsSync(taskPath)) return err("task-file не найден: " + params.task);
      const taskText = fs.readFileSync(taskPath, "utf8");
      const tid = scalarField(taskText, "id") || path.basename(taskPath, ".md");
      const capability = scalarField(taskText, "capability");

      const stage = (scalarField(taskText, "stage") || "").toLowerCase();
      if (stage.startsWith("design")) {
        recordGuard(pi.cwd, { event: "misroute-guard", tid, tool: "codex_worker", detail: `codex_worker на design-задаче (stage=${stage})` });
        recordRun(pi.cwd, { tool: "codex_worker", tid, stage, capability, backend: "codex", outcome: "misroute", durationMs: Date.now() - t0 });
        return err(`MISROUTE GUARD: codex_worker на design-задаче (stage=${stage}). Design → design_worker.`);
      }

      const model = params.model || scalarField(taskText, "execute-model") || "gpt-5-codex";
      const { agent, note } = resolveDomain(pi.cwd, taskText);
      const sysPrompt = rolePrompt(pi.cwd, agent) || rolePrompt(pi.cwd, "executor");
      const taskRel = path.relative(pi.cwd, taskPath).replace(/\\/g, "/");
      const log: string[] = [`=== EXECUTE (codex seam): ${tid} (agent=${agent} [${note}], model=${model}) ===`];

      let reqErrors: number | undefined, reqErrClasses: string | undefined;
      const base = { tool: "codex_worker", tid, stage, capability, backend: "codex", model, agent };
      const fin = (
        outcome: string, isErr: boolean, msg: string,
        extra: Record<string, unknown> = {},
        guard?: { event: string; detail?: string; errClass?: string },
      ) => {
        recordRun(pi.cwd, { ...base, outcome, durationMs: Date.now() - t0, reqErrors, reqErrClasses, ...extra });
        if (guard) recordGuard(pi.cwd, { event: guard.event, tid, tool: "codex_worker", backend: "codex", model, detail: guard.detail, errClass: guard.errClass });
        return isErr ? err(msg) : ok(msg);
      };

      // worker: codex exec — non-interactive, sandbox=workspace-write (пишет файлы, без сети).
      const wr = await pi.exec(
        "codex",
        ["exec", workerPrompt(taskRel, sysPrompt), "--cd", pi.cwd, "-m", model, "--sandbox", "workspace-write"],
        { cwd: pi.cwd },
      );
      const scan = scanRequestErrors((wr.stderr || "") + "\n" + (wr.stdout || ""));
      if (scan.count) {
        reqErrors = scan.count; reqErrClasses = scan.classes.join(",");
        log.push(`[req-errors] ${scan.count} ошибок запроса в потоке (${reqErrClasses}); пример: ${scan.sample}`);
        recordGuard(pi.cwd, { event: "request-error", tid, tool: "codex_worker", backend: "codex", model, detail: `${scan.count}× ${reqErrClasses}: ${scan.sample}`, errClass: scan.classes[0] });
      }
      if (wr.code !== 0) {
        const cls = classifyError((wr.stderr || "") + "\n" + (wr.stdout || ""), wr.code);
        const emsg = errExcerpt(wr.stderr || wr.stdout || "");
        return fin("worker-error", true, log.join("\n") + `\ncodex exec rc=${wr.code} [${cls}] ${emsg}\n${(wr.stderr || "").slice(-1500)}`,
          { errClass: cls, errMsg: emsg, errCode: wr.code }, { event: "worker-error", detail: `codex rc=${wr.code}: ${emsg}`, errClass: cls });
      }
      log.push("codex завершил реализацию");

      // commit-rail (идентичен execute_worker): add → zone-check → test-cmd → FR-trace → commit.
      if ((await git(["add", "-A"])).code !== 0) return fin("error", true, log.join("\n") + "\ngit add failed", { errClass: "git", errMsg: "git add -A failed" });
      const z = parseZone(taskText);
      const staged = (await git(["diff", "--cached", "--name-only"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!staged.length) { await git(["reset", "-q"]); return fin("no-changes", true, log.join("\n") + "\ncodex ничего не написал (нет staged).", { filesChanged: 0 }, { event: "no-changes" }); }
      if (z.allow.length) {
        const v = zoneCheck(staged, z.allow, z.deny);
        if (v.length) { await git(["reset", "-q"]); return fin("zone-violation", true, log.join("\n") + "\nZONE VIOLATION — коммит отменён:\n" + v.map((x) => "  [x] " + x).join("\n"), { zoneViolations: v.length, filesChanged: staged.length }, { event: "zone-violation", detail: v.slice(0, 5).join("; ") }); }
      }
      let testCmd = "none";
      if (z.testCmd) {
        const tr = await pi.exec("sh", ["-c", z.testCmd], { cwd: pi.cwd });
        if (tr.code !== 0) { await git(["reset", "-q"]); return fin("gate-red", true, log.join("\n") + `\nGATE RED (test-cmd exit ${tr.code}):\n${(tr.stdout + "\n" + tr.stderr).slice(-2000)}`, { testCmd: "red", filesChanged: staged.length }, { event: "test-cmd-red", detail: `exit ${tr.code}` }); }
        testCmd = "green";
        log.push("test-cmd green");
      }
      let frCovered: number | undefined, frTotal: number | undefined;
      const specPath = resolveSpec(pi.cwd, taskText, tid);
      if (specPath) {
        const ft = frTrace(specPath, staged, pi.cwd);
        frTotal = ft.frIds.length; frCovered = ft.covered.length;
        if (ft.frIds.length) log.push(`FR-trace: ${ft.covered.length}/${ft.frIds.length} FR покрыто`);
        if (ft.findings.length) { await git(["reset", "-q"]); return fin("fr-fail", true, log.join("\n") + "\nFR-TRACE FAIL — коммит отменён:\n" + ft.findings.map((x) => "  [x] " + x).join("\n"), { testCmd, frCovered, frTotal, filesChanged: staged.length }, { event: "fr-trace-fail", detail: ft.findings.slice(0, 5).join("; ") }); }
      }

      const filesNote = `\nФайлы:\n` + staged.map((s) => "  + " + s).join("\n");
      if (params.noCommit) { await git(["reset", "-q"]); return fin("locked-nocommit", false, log.join("\n") + "\nnoCommit: код на диске." + filesNote, { testCmd, frCovered, frTotal, filesChanged: staged.length }); }
      const c = await git(["commit", "-m", `feat(${tid}): ${capability || "execute"} via codex_worker (${agent}, zone+test green)`, "-m", "[omp-rail:codex_worker]"]);
      if (c.code !== 0) return fin("error", true, log.join("\n") + "\ngit commit failed: " + c.stderr, { testCmd, frCovered, frTotal, errClass: "git", errMsg: errExcerpt(c.stderr) });
      const sha = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
      return fin("committed", false, log.join("\n") + `\nEXECUTE COMMITTED (codex seam).${filesNote}\n${c.stdout}`, { testCmd, frCovered, frTotal, filesChanged: staged.length, commit: sha });
    },
  };
};

export default factory;
