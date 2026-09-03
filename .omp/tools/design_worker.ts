// design_worker — design-стадия как НАТИВНЫЙ OMP-тул (Phase-2 интеграция).
// Возвращает design-петлю ВНУТРЬ OMP-сессии: раньше внешний python-драйвер (design_stage.py)
// гнал `claude -p` СНАРУЖИ, обходя OMP. Теперь оркестрация тут; сильная модель — через pi.exec("claude").
//
// Поток (детерминированный, вынесен из LLM-lead — тот дробит producer'ов и рубер-штампит гейт):
//   producer(claude -p) → gateLint(TS) → 1 bounce-retry с findings → critic(claude -p) → ledger → commit.
// Locked ТОЛЬКО при gate PASS + нет blocker/major от критика; иначе isError (blocked, не коммитит).
// Контейнмент воркера: claude даётся {Read,Write,Glob,Grep} (нет Bash-escape); настоящий рельс —
// zone-check на коммите тут же (запись вне зоны ловится независимо от того, что написал воркер).
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseZone, scalarField } from "./_lib/task";
import { zoneCheck } from "./_lib/zonecheck";
import { gateLint } from "./_lib/gatelint";
import { resolveBackend, runWorker } from "./_lib/backend";
import { recordRun, recordGuard } from "./_lib/telemetry";
import type { WorkerUsage } from "./_lib/telemetry";
import { classifyError, errExcerpt, scanRequestErrors } from "./_lib/errclass";
import { preflightModel } from "./_lib/modelroles";
import { ok, err } from "./_lib/result";

/** Системный промпт роли из .omp/agents/<role>.md без YAML-фронтматтера. */
function rolePrompt(cwd: string, role: string): string {
  const p = path.resolve(cwd, ".omp/agents", `${role}.md`);
  let text = fs.readFileSync(p, "utf8");
  if (text.startsWith("---")) {
    const parts = text.split("---");
    if (parts.length >= 3) text = parts.slice(2).join("---");
  }
  return text.trim();
}

/** out-dir дизайна = первый allow-glob task-зоны без /**-хвоста (дефолт docs/design). */
function outDir(taskText: string): string {
  const a = parseZone(taskText).allow.find((x) => !x.startsWith(".workflow"));
  return (a || "docs/design").replace(/\/\*\*?$/, "").trim() || "docs/design";
}

function producerPrompt(taskRel: string, specRel: string, adrRel: string, notes: string): string {
  const note = notes.trim() ? `\n\nИСПРАВЬ по замечаниям прошлого прохода (перепиши артефакты):\n${notes}` : "";
  return (
    `Locked task-file (ЕДИНСТВЕННЫЙ источник контракта): ${taskRel}\n\n` +
    `Прочитай его через Read. Произведи ДВА артефакта, записав их через Write:\n` +
    `  1. spec → ${specRel}\n  2. ADR  → ${adrRel}\n\n` +
    `КАЖДЫЙ SP-point и AD-decision ОБЯЗАН нести machine-readable fenced-блок (\`\`\`spec / \`\`\`adr) ` +
    `в формате из твоей роли — их парсит детерминированный gate-линтер. source-ref обязан указывать на ` +
    `РЕАЛЬНЫЕ непустые строки ${taskRel} (формат <file>#L<start>-L<end>): открой файл, возьми точные ` +
    `номера строк, не выдумывай. covers ссылается только на существующие SP-id.\n` +
    `Проза + fenced-блоки в одном файле. Не пиши никаких других файлов.` + note
  );
}

function criticPrompt(taskRel: string, specRel: string, adrRel: string, findingsRel: string): string {
  return (
    `Свежий критический проход. Прочитай через Read:\n` +
    `  task-file (источник): ${taskRel}\n  spec: ${specRel}\n  ADR:  ${adrRel}\n\n` +
    `Проверь: Gate-1 (каждый SP реально поддержан source-ref в task-file), Gate-2 (каждый AD покрывает SP; ` +
    `каждый SP покрыт или явный gap), level-boundary (solution-лексика в spec = leakage), прескриптивность.\n` +
    `Запиши findings через Write в ${findingsRel}: по одному на строку в формате ` +
    `\`[blocker|major|minor] <файл>: <проблема>\`. Если дефектов нет — строка \`[none] clean\`. ` +
    `Не правь артефакты, не решай направление.`
  );
}

/** blocker/major блокируют лок; minor — нет; [none] игнор. */
function criticSeverity(findingsPath: string): { blocking: string[]; minor: string[] } {
  if (!fs.existsSync(findingsPath)) return { blocking: ["критик не создал findings-файл"], minor: [] };
  const blocking: string[] = [];
  const minor: string[] = [];
  for (const raw of fs.readFileSync(findingsPath, "utf8").split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    const low = s.toLowerCase();
    if (low.startsWith("[none]")) continue;
    if (low.startsWith("[blocker]") || low.startsWith("[major]")) blocking.push(s);
    else if (low.startsWith("[minor]")) minor.push(s);
  }
  return { blocking, minor };
}

function writeLedger(
  ledgerPath: string, tid: string, model: string, verdict: string, gateSummary: string,
  blocking: string[], minor: string[], status: string,
): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const L = [
    "---", `id: ${tid}`, "stage: design", `status: ${status}`, `model: ${model}`,
    `date: ${new Date().toISOString().slice(0, 10)}`, "---", "",
    "## Design ledger (native OMP design_worker)", "",
    `**Contract:** \`.workflow/tasks/${tid}.md\` (locked, INV-1)`, "",
    "### Gate-1/2 (gateLint — механический)", `Вердикт: **${verdict}**`, "```", gateSummary.trim(), "```", "",
    "### Critic (свежий контекст, сильная модель — семантика)",
  ];
  if (blocking.length) { L.push("**Blocking (blocker/major):**"); blocking.forEach((b) => L.push(`- ${b}`)); }
  if (minor.length) { L.push("**Non-blocking (minor):**"); minor.forEach((m) => L.push(`- ${m}`)); }
  if (!blocking.length && !minor.length) L.push("clean");
  L.push("", `### Итог: **${status}**`);
  fs.writeFileSync(ledgerPath, L.join("\n") + "\n", "utf8");
}

const factory: CustomToolFactory = (pi) => {
  const git = (args: string[]) => pi.exec("git", args, { cwd: pi.cwd });

  return {
    name: "design_worker",
    label: "Design stage (strong-model)",
    loadMode: "essential",
    description:
      "Design-стадия целиком (producer→gate_lint→bounce-retry→critic→ledger→commit) внутри OMP. " +
      "Сильная модель через claude -p (design/critic — local Qwen слаб). Locked+commit ТОЛЬКО при " +
      "gate PASS + нет blocker/major; иначе blocked (не коммитит). Оркестрация детерминирована (не LLM-lead).",
    parameters: pi.zod.object({
      task: pi.zod.string().describe("путь к locked design task-file (источник контракта)"),
      model: pi.zod.string().optional().describe("сильная модель (sonnet|opus|<id>); дефолт design-model из task / sonnet"),
      noCommit: pi.zod.boolean().optional().describe("не коммитить (артефакты+ledger на диск для ревью)"),
    }),
    async execute(_id, params, _u, _ctx, _sig) {
      const t0 = Date.now();
      if ((await git(["rev-parse", "--git-dir"])).code !== 0) return err("не git-репо");
      const taskPath = path.resolve(pi.cwd, params.task);
      if (!fs.existsSync(taskPath)) return err("task-file не найден: " + params.task);
      const taskText = fs.readFileSync(taskPath, "utf8");
      const tid = scalarField(taskText, "id") || path.basename(taskPath, ".md");
      const capability = scalarField(taskText, "capability");

      // MISROUTE GUARD (детерминир. routing — enforcement > инструкция, D2).
      // design_worker — ТОЛЬКО для design-стадии. Lead (особ. Qwen) склонен звать его на execute-задачи
      // (жжёт сильную модель зря). Тул сам fail-closed'ит: bежит ⟺ stage задачи начинается с "design".
      // Execute-задача (stage=execute/<none>) → отказ; lead обязан реализовать сам + gated_commit.
      const stage = (scalarField(taskText, "stage") || "").toLowerCase();
      if (!stage.startsWith("design")) {
        recordGuard(pi.cwd, { event: "misroute-guard", tid, tool: "design_worker", detail: `design_worker на не-design задаче (stage=${stage || "<none>"})` });
        recordRun(pi.cwd, { tool: "design_worker", tid, stage, capability, outcome: "misroute", durationMs: Date.now() - t0 });
        return err(
          `MISROUTE GUARD: design_worker вызван на не-design задаче (stage=${stage || "<none>"}).\n` +
          `Этот тул ТОЛЬКО для stage:design* (producer→gate→critic→commit сильной моделью).\n` +
          `→ Execute-задачу реализуй САМ по флоу .omp/AGENTS.md, закоммить тулом gated_commit(task=${params.task}).\n` +
          `→ Если это правда design — проставь \`stage: design*\` в task-file и перелочь.`,
        );
      }

      const model = params.model || scalarField(taskText, "design-model") || "sonnet";

      // backend делегации (ручка per-stage): task-field > env > delegation.yml > claude.
      let backend, backendSrc;
      try { ({ backend, source: backendSrc } = resolveBackend("design", scalarField(taskText, "design-backend"), pi.cwd)); }
      catch (e) {
        const m = (e as Error).message;
        recordRun(pi.cwd, { tool: "design_worker", tid, stage, capability, outcome: "error", errClass: "config", errMsg: errExcerpt(m), durationMs: Date.now() - t0 });
        return err("BACKEND: " + m);
      }

      const out = outDir(taskText);
      fs.mkdirSync(path.resolve(pi.cwd, out), { recursive: true });
      fs.mkdirSync(path.resolve(pi.cwd, ".workflow/ledger"), { recursive: true });
      const specRel = `${out}/${tid}-spec.md`;
      const adrRel = `${out}/${tid}-adr.md`;
      const findingsRel = `.workflow/ledger/${tid}-findings.md`;
      const ledgerRel = `.workflow/ledger/${tid}.md`;
      const specPath = path.resolve(pi.cwd, specRel);
      const adrPath = path.resolve(pi.cwd, adrRel);
      const findingsPath = path.resolve(pi.cwd, findingsRel);
      const taskRel = path.relative(pi.cwd, taskPath).replace(/\\/g, "/");

      const log: string[] = [`=== DESIGN STAGE: ${tid} (backend=${backend} [${backendSrc}], model=${model}, out=${out}/) ===`];

      // Runtime-уведомление (task-2): omp-backend зовёт модель из models.yml — если не задана/не резолвится,
      //   предупреждаем ДО запроса (иначе model-not-found; см. errclass).
      if (backend === "omp") {
        const pf = preflightModel(pi.cwd, model);
        if (!pf.ok) {
          log.push(`[model] WARN: ${pf.msg}. Проверь modelRoles/models.yml (tools/setup_roles.ts --check).`);
          recordGuard(pi.cwd, { event: "model-unset", tid, tool: "design_worker", backend, model, detail: pf.msg });
        }
      }
      const producerSys = rolePrompt(pi.cwd, "producer");
      const criticSys = rolePrompt(pi.cwd, "critic");

      // telemetry: сумма usage по worker-вызовам (producer×N + critic) + единая terminal-точка.
      const base = { tool: "design_worker", tid, stage, capability, backend, backendSrc, model };
      const wsum: WorkerUsage = {};
      const addUsage = (u?: WorkerUsage) => {
        if (!u) return;
        wsum.costUsd = (wsum.costUsd || 0) + (u.costUsd || 0);
        wsum.inputTok = (wsum.inputTok || 0) + (u.inputTok || 0);
        wsum.outputTok = (wsum.outputTok || 0) + (u.outputTok || 0);
        wsum.totalTok = (wsum.totalTok || 0) + (u.totalTok || 0);
        wsum.durationMs = (wsum.durationMs || 0) + (u.durationMs || 0);
        if (u.sessionId) wsum.sessionId = u.sessionId;
      };
      let bounces = 0;
      // reqErrors: «тихие» ошибки запроса в потоках producer/critic (task-4), аккумулируем по всем worker-вызовам.
      let reqErrors = 0; const reqClasses = new Set<string>();
      const accScan = (r: { stdout: string; stderr: string }) => {
        const s = scanRequestErrors((r.stderr || "") + "\n" + (r.stdout || ""));
        if (s.count) { reqErrors += s.count; s.classes.forEach((c) => reqClasses.add(c)); }
      };
      const fin = (
        outcome: string, isErr: boolean, msg: string,
        extra: Record<string, unknown> = {},
        guard?: { event: string; detail?: string; errClass?: string },
      ) => {
        recordRun(pi.cwd, { ...base, outcome, bounces, durationMs: Date.now() - t0, worker: wsum,
          reqErrors: reqErrors || undefined, reqErrClasses: reqClasses.size ? [...reqClasses].join(",") : undefined, ...extra });
        if (guard) recordGuard(pi.cwd, { event: guard.event, tid, tool: "design_worker", backend, model, detail: guard.detail, errClass: guard.errClass });
        return isErr ? err(msg) : ok(msg);
      };

      // producer → gateLint, до 2 попыток (bounce-retry с findings)
      let verdict = "BOUNCE";
      let gateSummary = "";
      let notes = "";
      for (const attempt of [1, 2]) {
        const pr = await runWorker(pi, backend, { system: producerSys, user: producerPrompt(taskRel, specRel, adrRel, notes), model });
        addUsage(pr.usage); accScan(pr);
        if (pr.code !== 0) {
          const cls = classifyError((pr.stderr || "") + "\n" + (pr.stdout || ""), pr.code);
          const emsg = errExcerpt(pr.stderr || pr.stdout || "");
          return fin("worker-error", true, log.join("\n") + `\nproducer (${backend}) rc=${pr.code} [${cls}] ${emsg}\n${(pr.stderr || "").slice(-1500)}`,
            { errClass: cls, errMsg: emsg, errCode: pr.code }, { event: "worker-error", detail: `producer ${backend} rc=${pr.code}: ${emsg}`, errClass: cls });
        }
        if (!fs.existsSync(specPath) || !fs.existsSync(adrPath))
          return fin("worker-error", true, log.join("\n") + `\nproducer не создал spec/ADR (${specRel}, ${adrRel})`,
            {}, { event: "worker-error", detail: "producer не создал spec/ADR" });
        const g = gateLint(taskPath, specPath, adrPath, pi.cwd);
        gateSummary = `SP:${g.nSp} AD:${g.nAd} FR:${g.nFr} findings:${g.findings.length}\n` + g.findings.map((f) => "  [x] " + f).join("\n");
        log.push(`gateLint попытка ${attempt}: ` + (g.findings.length ? `BOUNCE (${g.findings.length})` : "PASS"));
        if (!g.findings.length) { verdict = "PASS"; break; }
        verdict = "BOUNCE"; bounces++;
        recordGuard(pi.cwd, { event: "gate-bounce", tid, tool: "design_worker", backend, model, detail: g.findings.slice(0, 5).join("; ") });
        notes = gateSummary;
        if (attempt === 2) log.push("bounce-retry исчерпан");
      }

      // critic (свежий контекст) — даже при PASS: ловит семантику, что механический гейт не видит
      const cr = await runWorker(pi, backend, { system: criticSys, user: criticPrompt(taskRel, specRel, adrRel, findingsRel), model });
      addUsage(cr.usage); accScan(cr);
      if (cr.code !== 0) log.push(`WARN: critic (${backend}) rc=${cr.code} [${classifyError((cr.stderr || "") + (cr.stdout || ""), cr.code)}] ${errExcerpt(cr.stderr || cr.stdout || "")} (findings могут быть неполны)`);
      const { blocking, minor } = criticSeverity(findingsPath);
      if (blocking.length) recordGuard(pi.cwd, { event: "critic-blocker", tid, tool: "design_worker", backend, model, detail: blocking.slice(0, 5).join("; ") });
      if (minor.length) recordGuard(pi.cwd, { event: "critic-minor", tid, tool: "design_worker", backend, model, detail: minor.slice(0, 5).join("; ") });

      if (reqErrors) recordGuard(pi.cwd, { event: "request-error", tid, tool: "design_worker", backend, model, detail: `${reqErrors}× ${[...reqClasses].join(",")} в потоках producer/critic`, errClass: [...reqClasses][0] });

      const locked = verdict === "PASS" && blocking.length === 0;
      const status = locked ? "locked" : "blocked";
      writeLedger(path.resolve(pi.cwd, ledgerRel), tid, model, verdict, gateSummary, blocking, minor, status);
      log.push(`--- DESIGN ${status.toUpperCase()}: gate=${verdict}, blocking=${blocking.length}, minor=${minor.length} ---`);

      const critFields = { gate: verdict, criticBlocking: blocking.length, criticMinor: minor.length };
      if (!locked)
        return fin("blocked", true, log.join("\n") + "\nDesign НЕ залочен → не коммичу (blocked). Артефакты+ledger на диске для итерации.", critFields);

      if (params.noCommit) return fin("locked-nocommit", false, log.join("\n") + "\nnoCommit: пропускаю коммит (locked).", critFields);

      // commit через zone-check (тот же рельс, что gated_commit — запись вне зоны ловится тут)
      if ((await git(["add", "-A"])).code !== 0) return fin("error", true, log.join("\n") + "\ngit add failed", critFields);
      const z = parseZone(taskText);
      if (z.allow.length) {
        const staged = (await git(["diff", "--cached", "--name-only"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        const v = zoneCheck(staged, z.allow, z.deny);
        if (v.length) {
          await git(["reset", "-q"]);
          return fin("zone-violation", true, log.join("\n") + "\nZONE VIOLATION — коммит отменён (staged сброшен):\n" + v.map((x) => "  [x] " + x).join("\n"),
            { ...critFields, zoneViolations: v.length }, { event: "zone-violation", detail: v.slice(0, 5).join("; ") });
        }
      }
      const c = await git(["commit", "-m", `design(${tid}): spec+ADR locked (gate PASS, critic clean)`, "-m", "[omp-rail:design_worker]"]);
      if (c.code !== 0) return fin("error", true, log.join("\n") + "\ngit commit failed: " + c.stderr, critFields);
      const costNote = wsum.costUsd ? ` (~$${wsum.costUsd.toFixed(2)})` : "";
      const sha = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
      return fin("committed", false, log.join("\n") + `\nDESIGN LOCKED + COMMITTED${costNote}.\n${c.stdout}`, { ...critFields, commit: sha });
    },
  };
};

export default factory;
