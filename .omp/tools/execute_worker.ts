// execute_worker — execute-стадия как НАТИВНЫЙ детерминир. OMP-тул (P9 Track C, фикс #5 merge-stall).
// Симметричен design_worker, но для РЕАЛИЗАЦИИ: domain-executor пишет код внутри залоченного контракта,
// тул zone+test-гейтит на коммите. Оркестрация в TS — вынесена из Qwen-lead (тест #5 показал: lead
// стопорится на fan-out→merge-back изолированного воркера; детерминир. драйвер надёжнее, как design_worker).
//
// Поток: resolve домен-агента из zonemap (Track C) → worker(claude -p, домен-sysprompt, {Read,Write,Glob,Grep},
//   без Bash) пишет код+тест по DoD → git add -A → zone-check staged → test-cmd → commit только на зелёном.
// Контейнмент = НЕ projfs, а no-Bash воркер + zone-check на коммите (тот же рельс, что gated_commit;
//   запись вне зоны ловится независимо от того, что написал воркер — проект-тезис enforcement>инструкция).
// INV-9 note: воркер = claude (сильная, корректность кода важна). Cheap-Qwen-execute потребовал бы
//   nested-omp (тяжело/substrate) — отложено; model-параметр позволяет указать дешевле.
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseZone, scalarField } from "./_lib/task";
import { zoneCheck } from "./_lib/zonecheck";
import { resolveAgent, loadZoneMap, type ZoneMap } from "./_lib/zonemap";
import { frTrace } from "./_lib/frtrace";
import { resolveBackend, runWorker } from "./_lib/backend";
import { tryFanoutNative } from "./_lib/fanout_native";
import { recordRun, recordGuard } from "./_lib/telemetry";
import { classifyError, errExcerpt, scanRequestErrors } from "./_lib/errclass";
import { preflightModel } from "./_lib/modelroles";
import { ok, err } from "./_lib/result";

/** Резолв change-spec для FR↔test-гейта (B.1b): поле `spec:` task-file → путь; иначе
 *  docs/design/<id>-spec.md. Нет файла/поля → null (FR-гейт скипается, FR условен как B.1a). */
function resolveSpec(cwd: string, taskText: string, tid: string): string | null {
  const field = scalarField(taskText, "spec");
  const cand = field ? path.resolve(cwd, field) : path.resolve(cwd, "docs/design", `${tid}-spec.md`);
  return fs.existsSync(cand) ? cand : null;
}

/** Системный промпт роли из .omp/agents/<role>.md без YAML-фронтматтера. */
function rolePrompt(cwd: string, role: string): string {
  const p = path.resolve(cwd, ".omp/agents", `${role}.md`);
  if (!fs.existsSync(p)) return "";
  let text = fs.readFileSync(p, "utf8");
  if (text.startsWith("---")) {
    const parts = text.split("---");
    if (parts.length >= 3) text = parts.slice(2).join("---");
  }
  return text.trim();
}

/** Резолв домен-агента из zonemap (Track C). Нет карты/матча → executor. */
function resolveDomain(cwd: string, taskText: string): { agent: string; note: string } {
  let zm: ZoneMap | null = null;
  try { zm = loadZoneMap(path.resolve(cwd, ".omp/zonemap.yml")); } catch { zm = null; }
  if (!zm) return { agent: "executor", note: "нет zonemap → generic executor" };
  const { allow } = parseZone(taskText);
  const r = resolveAgent(allow, zm);
  if (r.denied.length) return { agent: "executor", note: `deny-domain в зоне (${r.denied.join(",")}) — не трогать` };
  if (r.ambiguous) return { agent: "executor", note: `ambiguous домены (${r.matched.join(",")}) → generic executor; раздели зону для домен-агента` };
  return { agent: r.agent, note: r.agent === "executor" ? "нет домен-матча → executor" : `домен ${r.tech} → ${r.agent}` };
}

function workerPrompt(taskRel: string): string {
  return (
    `Locked task-file (ЕДИНСТВЕННЫЙ источник контракта, INV-1): ${taskRel}\n\n` +
    `Прочитай его через Read (и связанный код через Glob/Grep/Read). Реализуй РОВНО то, что в контракте, ` +
    `по Definition of Done — код + тесты. Пиши файлы через Write СТРОГО в пределах allow-зоны task-file.\n` +
    `Не выходи за зону. Не переосмысливай дизайн — следуй контракту. Если у change есть FR-* требования — ` +
    `покрой КАЖДОЕ тестом и УКАЖИ его FR-id (напр. FR-toggle-event) в тесте (в имени теста или комментарии), ` +
    `иначе FR-трасса-гейт отклонит коммит.\n` +
    `Не пиши ничего вне зоны (иначе коммит будет отклонён zone-check). Верни одну строку: какие файлы создал.`
  );
}

const factory: CustomToolFactory = (pi) => {
  const git = (args: string[]) => pi.exec("git", args, { cwd: pi.cwd });

  return {
    name: "execute_worker",
    label: "Execute stage (domain-agent, deterministic)",
    loadMode: "essential",
    description:
      "Execute-стадия целиком (resolve домен-агента→worker пишет код+тест→zone-check→test-cmd→commit) " +
      "детерминированно внутри OMP. Воркер = claude -p с домен-sysprompt (kmp/go-developer из zonemap), " +
      "без Bash. Коммит ТОЛЬКО при zone-check green + test-cmd green; иначе blocked (staged сброшен). " +
      "Оркестрация в TS (не Qwen-lead — тот стопорится на merge-back). Только для stage:execute (не design).",
    parameters: pi.zod.object({
      task: pi.zod.string().describe("путь к locked execute task-file (источник контракта)"),
      model: pi.zod.string().optional().describe("модель воркера (дефолт sonnet; можно дешевле)"),
      noCommit: pi.zod.boolean().optional().describe("не коммитить (код на диске для ревью)"),
    }),
    async execute(_id, params, _u, ctx, sig) {
      const t0 = Date.now();
      if ((await git(["rev-parse", "--git-dir"])).code !== 0) return err("не git-репо");
      const taskPath = path.resolve(pi.cwd, params.task);
      if (!fs.existsSync(taskPath)) return err("task-file не найден: " + params.task);
      const taskText = fs.readFileSync(taskPath, "utf8");
      const tid = scalarField(taskText, "id") || path.basename(taskPath, ".md");
      const capability = scalarField(taskText, "capability");

      // MISROUTE GUARD (симметрия к design_worker): execute_worker — ТОЛЬКО для НЕ-design задач.
      const stage = (scalarField(taskText, "stage") || "").toLowerCase();
      if (stage.startsWith("design")) {
        recordGuard(pi.cwd, { event: "misroute-guard", tid, tool: "execute_worker", detail: `execute_worker на design-задаче (stage=${stage})` });
        recordRun(pi.cwd, { tool: "execute_worker", tid, stage, capability, outcome: "misroute", durationMs: Date.now() - t0 });
        return err(
          `MISROUTE GUARD: execute_worker вызван на design-задаче (stage=${stage}).\n` +
          `→ Design-стадию гони тулом design_worker(task=${params.task}).`,
        );
      }

      const model = params.model || scalarField(taskText, "execute-model") || "sonnet";
      const { agent, note } = resolveDomain(pi.cwd, taskText);
      const sysPrompt = rolePrompt(pi.cwd, agent) || rolePrompt(pi.cwd, "executor");
      const taskRel = path.relative(pi.cwd, taskPath).replace(/\\/g, "/");

      // backend делегации (ручка per-stage): task-field > env > delegation.yml > claude.
      let backend, backendSrc;
      try { ({ backend, source: backendSrc } = resolveBackend("execute", scalarField(taskText, "execute-backend"), pi.cwd)); }
      catch (e) {
        const m = (e as Error).message;
        recordRun(pi.cwd, { tool: "execute_worker", tid, stage, capability, outcome: "error", errClass: "config", errMsg: errExcerpt(m), durationMs: Date.now() - t0 });
        return err("BACKEND: " + m);
      }
      const log: string[] = [`=== EXECUTE STAGE: ${tid} (backend=${backend} [${backendSrc}], agent=${agent} [${note}], model=${model}) ===`];

      // Runtime-уведомление (task-2): omp-backend зовёт нативную модель из models.yml — если она не задана/
      //   не резолвится, предупреждаем ДО запроса (иначе omp вернёт model-not-found; см. errclass).
      if (backend === "omp" || backend === "omp-fanout") {
        const pf = preflightModel(pi.cwd, model);
        if (!pf.ok) {
          log.push(`[model] WARN: ${pf.msg}. Проверь modelRoles/models.yml (tools/setup_roles.ts --check).`);
          recordGuard(pi.cwd, { event: "model-unset", tid, tool: "execute_worker", backend, model, detail: pf.msg });
        }
      }

      // reqErrors: «тихие» ошибки запроса в потоке воркера (task-4) — считаются после runWorker, вносятся
      //   в КАЖДУЮ terminal-точку (даже committed: провайдер мог отретраить request-error внутри).
      let reqErrors: number | undefined, reqErrClasses: string | undefined;

      // Хелпер: записать run-телеметрию (+опц. guard) и вернуть ok/err. Единая terminal-точка.
      const base = { tool: "execute_worker", tid, stage, capability, backend, backendSrc, model, agent };
      const fin = (
        outcome: string, isErr: boolean, msg: string,
        extra: Record<string, unknown> = {},
        guard?: { event: string; detail?: string; errClass?: string },
      ) => {
        recordRun(pi.cwd, { ...base, outcome, durationMs: Date.now() - t0, worker: wr?.usage, reqErrors, reqErrClasses, ...extra });
        if (guard) recordGuard(pi.cwd, { event: guard.event, tid, tool: "execute_worker", backend, model, detail: guard.detail, errClass: guard.errClass });
        return isErr ? err(msg) : ok(msg);
      };

      // worker: домен-sysprompt, {Read,Write,Glob,Grep} — без Bash (нет git-escape). Контейнмент = commit-rail.
      // inZone-предикат передаём в req — backend omp-fanout фильтрует bring-back из worktree-клона по зоне
      //   (вне-зоны discard вместе с клоном). Строим его нашим zoneCheck (backend.ts self-contained, не импортит).
      const z = parseZone(taskText);
      const inZone = (f: string) => !z.allow.length || zoneCheck([f], z.allow, z.deny).length === 0;

      // omp-fanout Path B (ЭКСПЕРИМЕНТАЛЬНЫЙ, флаг OMP_FANOUT_NATIVE=1): нативный isolated task-субагент.
      //   Успех → в commit-rail (файлы должны прилететь из OMP-projfs merge-back). Сбой/неизвестная форма →
      //   fallback на Path A (git-worktree, runWorker). Диагностика в .workflow/fanout-native-diag.json.
      let wr: Awaited<ReturnType<typeof runWorker>> | undefined;
      if (backend === "omp-fanout" && process.env.OMP_FANOUT_NATIVE === "1") {
        const nat = await tryFanoutNative(pi, ctx, { taskPrompt: workerPrompt(taskRel), agent, cwd: pi.cwd }, sig);
        if (nat.ok) { wr = { code: 0, stdout: nat.stdout, stderr: "" }; log.push("[fanout] native isolated task OK"); }
        else log.push(`[fanout] native отпал (${nat.reason}) → Path A`);
      }
      if (!wr) wr = await runWorker(pi, backend, { system: sysPrompt, user: workerPrompt(taskRel), model, inZone });
      // request-error скан (task-4): stderr + stdout (omp-фреймы). Заполняет reqErrors для ЛЮБОГО outcome.
      const scan = scanRequestErrors((wr.stderr || "") + "\n" + (wr.stdout || ""));
      if (scan.count) {
        reqErrors = scan.count; reqErrClasses = scan.classes.join(",");
        log.push(`[req-errors] ${scan.count} ошибок запроса в потоке (${reqErrClasses}); пример: ${scan.sample}`);
        recordGuard(pi.cwd, { event: "request-error", tid, tool: "execute_worker", backend, model, detail: `${scan.count}× ${reqErrClasses}: ${scan.sample}`, errClass: scan.classes[0] });
      }
      if (wr.code !== 0) {
        const cls = classifyError((wr.stderr || "") + "\n" + (wr.stdout || ""), wr.code);
        const emsg = errExcerpt(wr.stderr || wr.stdout || "");
        return fin("worker-error", true, log.join("\n") + `\nworker (${backend}) rc=${wr.code} [${cls}] ${emsg}\n${(wr.stderr || "").slice(-1500)}`,
          { errClass: cls, errMsg: emsg, errCode: wr.code },
          { event: "worker-error", detail: `${backend} rc=${wr.code}: ${emsg}`, errClass: cls });
      }
      const costUsd = wr.usage?.costUsd;
      log.push("worker завершил реализацию");

      // commit-rail: add → zone-check → test-cmd → commit (тот же рельс, что gated_commit).
      if ((await git(["add", "-A"])).code !== 0) return fin("error", true, log.join("\n") + "\ngit add failed", { errClass: "git", errMsg: "git add -A failed" });
      const staged = (await git(["diff", "--cached", "--name-only"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!staged.length) {
        await git(["reset", "-q"]);
        return fin("no-changes", true, log.join("\n") + "\nворкер ничего не написал (нет staged-изменений).",
          { filesChanged: 0 }, { event: "no-changes" });
      }
      if (z.allow.length) {
        const v = zoneCheck(staged, z.allow, z.deny);
        if (v.length) {
          await git(["reset", "-q"]);
          return fin("zone-violation", true, log.join("\n") + "\nZONE VIOLATION — коммит отменён (staged сброшен):\n" + v.map((x) => "  [x] " + x).join("\n"),
            { zoneViolations: v.length, filesChanged: staged.length },
            { event: "zone-violation", detail: v.slice(0, 5).join("; ") });
        }
      }
      let testCmd = "none";
      if (z.testCmd) {
        const tr = await pi.exec("sh", ["-c", z.testCmd], { cwd: pi.cwd });
        if (tr.code !== 0) {
          await git(["reset", "-q"]);
          return fin("gate-red", true, log.join("\n") + `\nGATE RED (test-cmd exit ${tr.code}) — коммит отменён:\n${(tr.stdout + "\n" + tr.stderr).slice(-2000)}`,
            { testCmd: "red", filesChanged: staged.length }, { event: "test-cmd-red", detail: `exit ${tr.code}` });
        }
        testCmd = "green";
        log.push("test-cmd green");
      }

      // FR↔test-гейт (B.1b): каждое FR-* из change-spec должно трассироваться в staged тест-файл.
      // Детерминир., FR условен (нет spec / 0 FR → скип). Enforcement, не послушность воркера.
      let frCovered: number | undefined, frTotal: number | undefined;
      const specPath = resolveSpec(pi.cwd, taskText, tid);
      if (specPath) {
        const ft = frTrace(specPath, staged, pi.cwd);
        frTotal = ft.frIds.length; frCovered = ft.covered.length;
        if (ft.frIds.length) log.push(`FR-trace: ${ft.covered.length}/${ft.frIds.length} FR покрыто (${ft.testFiles.length} тест-файлов)`);
        if (ft.findings.length) {
          await git(["reset", "-q"]);
          return fin("fr-fail", true, log.join("\n") + "\nFR-TRACE FAIL — коммит отменён (staged сброшен):\n" + ft.findings.map((x) => "  [x] " + x).join("\n"),
            { testCmd, frCovered, frTotal, filesChanged: staged.length },
            { event: "fr-trace-fail", detail: ft.findings.slice(0, 5).join("; ") });
        }
      }

      const costNote = costUsd != null ? ` (~$${costUsd.toFixed(2)})` : "";
      const filesNote = `\nФайлы:\n` + staged.map((s) => "  + " + s).join("\n");
      if (params.noCommit) {
        await git(["reset", "-q"]);
        return fin("locked-nocommit", false, log.join("\n") + "\nnoCommit: код на диске (не закоммичен)." + filesNote,
          { testCmd, frCovered, frTotal, filesChanged: staged.length });
      }

      const c = await git(["commit", "-m", `feat(${tid}): ${capability || "execute"} via execute_worker (${agent}, zone+test green)`, "-m", "[omp-rail:execute_worker]"]);
      if (c.code !== 0) return fin("error", true, log.join("\n") + "\ngit commit failed: " + c.stderr, { testCmd, frCovered, frTotal, errClass: "git", errMsg: errExcerpt(c.stderr) });
      const sha = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
      return fin("committed", false, log.join("\n") + `\nEXECUTE COMMITTED${costNote}.${filesNote}\n${c.stdout}`,
        { testCmd, frCovered, frTotal, filesChanged: staged.length, commit: sha });
    },
  };
};

export default factory;
