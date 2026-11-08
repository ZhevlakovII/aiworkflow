// queue-runner — автономная очередь ВНУТРИ OMP-процесса (P7 Phase-3).
// Ретайрит внешний tools/scheduler.py (он спавнил свежий `omp -p` на задачу). Теперь один OMP-процесс
// сам гонит очередь: hook на `agent_end` берёт следующую pending-задачу из .workflow/tasks и инжектит
// её в lead через pi.sendMessage(triggerTurn:true, deliverAs:"followUp"). Поток не встаёт (D10):
// done → next, blocked → next, drained → молчим (headless -p завершится сам).
//
// ARMED ТОЛЬКО при env OMP_QUEUE (иначе no-op — интерактивные сессии не трогаем).
// Task-file ИММУТАБЕЛЕН (INV-1): статус в отдельном .workflow/queue-state.json {id: pending|active|done|blocked}.
// Done/blocked-детект ДЕТЕРМИНИРОВАН: HEAD продвинулся с момента инжекта задачи → done (рельс закоммитил),
//   не продвинулся → blocked. Не доверяем самоотчёту lead (P2/P3 thesis: enforcement > инструкции).
// Routing: stage:design* → нативный тул design_worker (Phase-2, сильная модель); остальное → execute-флоу.
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parseBlocksRaw, mergeCanon, emitCanon } from "../tools/_lib/archivespec";
import { recordGuard } from "../tools/_lib/telemetry";
import { loadModelCaps, ConcurrencyBudget } from "../tools/_lib/modelcaps";

type State = Record<string, "pending" | "active" | "done" | "blocked">;

// Активная задача в полёте (task-3: их может быть >1 при maxSubagents>1 на модель).
interface Active {
  id: string;
  headRef: string;      // HEAD на момент dispatch — окно для поиска tid rail-commit
  specPath: string;
  capability: string;
  model: string;        // bucket-ключ для ConcurrencyBudget (per-model потолок)
  stall: number;        // сколько agent_end прошло без done-коммита этой задачи
  grace: number;        // сколько таких циклов допускаем до blocked (= число активных на dispatch)
}

function scalar(text: string, key: string): string {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"));
  return m ? m[1].replace(/\s+#\s.*$/, "").trim().replace(/^["']|["']$/g, "") : "";
}

export default function hook(pi: HookAPI): void {
  if (!process.env.OMP_QUEUE) return; // disarmed — обычная сессия

  const cwd = pi.cwd;
  const tasksDir = path.resolve(cwd, process.env.OMP_QUEUE_TASKS_DIR || ".workflow/tasks");
  const statePath = path.resolve(cwd, process.env.OMP_QUEUE_STATE || ".workflow/queue-state.json");
  const rollbackOnBlock = !!process.env.OMP_QUEUE_ROLLBACK;
  // Общий потолок параллелизма поверх per-model. ДЕФОЛТ = 1 (строго последовательно = прежнее поведение:
  //   одна активная за раз). Параллелизм — OPT-IN через OMP_QUEUE_MAX_PARALLEL>1; тогда per-model
  //   maxSubagents из models.yml режет по bucket'у модели. Причина дефолта-1: под single-lead субстратом
  //   воркеры сериализуются, а >1-инжект усложняет атрибуцию без выигрыша до direct-spawn (backlog).
  const globalCap = Number(process.env.OMP_QUEUE_MAX_PARALLEL) > 0
    ? Number(process.env.OMP_QUEUE_MAX_PARALLEL) : 1;
  const budget = new ConcurrencyBudget(loadModelCaps(cwd), globalCap);

  let processing = false;                 // guard от реентранта в agent_end
  const actives = new Map<string, Active>();   // id → in-flight задача (task-3: их может быть >1)

  // Логи ПРОЕКТНО в .workflow/logs (баг: pi.logger уходил в глобальный OMP-лог вне .workflow;
  //   ошибки не персистились). Пишем и в pi.logger (UI), и в файл (append, best-effort).
  const logsDir = path.resolve(cwd, ".workflow/logs");
  const qlog = path.join(logsDir, `queue-${new Date().toISOString().slice(0, 10)}.log`);
  const fileLog = (level: string, msg: string): void => {
    try { fs.mkdirSync(logsDir, { recursive: true }); fs.appendFileSync(qlog, `${new Date().toISOString()} [${level}] ${msg}\n`, "utf8"); } catch { /* best-effort */ }
  };
  const logInfo = (m: string): void => { pi.logger.info?.(m); fileLog("info", m); };
  const logErr = (m: string): void => { pi.logger.error?.(m); fileLog("error", m); };

  const loadState = (): State => {
    try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; }
  };
  const saveState = (st: State) => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2), "utf8");
  };
  // Синхронно: sendMessage должен вызваться в agent_end БЕЗ await до него, иначе headless -p
  // успевает dispose-нуть сессию (гонка: agent_end→dispose ~10ms) → инжект не долетает.
  // execFileSync (НЕ execSync со string-join): аргументы передаются массивом без shell → значения
  // с пробелами/скобками (напр. commit -m "chore(spec): ...") не рвутся. Синхронно (sendMessage
  // обязан вызваться в agent_end БЕЗ await до него).
  const git = (args: string[]): string => {
    try { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
    catch { return ""; }
  };
  const head = (): string => git(["rev-parse", "HEAD"]);

  /** Резолв change-spec для B.2b-архива: task-поле spec: → путь; иначе docs/design/<id>-spec.md. */
  const resolveSpec = (taskText: string, id: string): string => {
    const field = scalar(taskText, "spec");
    return field ? path.resolve(cwd, field) : path.resolve(cwd, "docs/design", `${id}-spec.md`);
  };

  /** B.2b autotrigger: детерминир. ID-merge change-spec → канон docs/spec/<cap>.md на task-done.
   *  БЕЗ claude (reconcile/dedupe — opt-in через тул archive_spec); коллизии логируются, очередь не встаёт.
   *  Канон коммитится отдельным chore-коммитом (execSync, не bash-тул → bash.patterns не трогают). */
  const archiveOnDone = (specPath: string, capability: string, id: string): void => {
    try {
      if (!fs.existsSync(specPath)) return;
      const incoming = parseBlocksRaw(fs.readFileSync(specPath, "utf8"));
      if (!incoming.length) return;
      const canonP = path.resolve(cwd, "docs/spec", `${capability}.md`);
      const canonText = fs.existsSync(canonP) ? fs.readFileSync(canonP, "utf8") : "";
      const m = mergeCanon(incoming, canonText, id);
      fs.mkdirSync(path.dirname(canonP), { recursive: true });
      fs.writeFileSync(canonP, emitCanon(capability, m.canon), "utf8");
      const rel = path.relative(cwd, canonP).replace(/\\/g, "/");
      git(["add", rel]);
      if (git(["diff", "--cached", "--name-only"]).includes(rel)) {
        git(["commit", "-m", `chore(spec): archive ${id} → ${capability} canon (ADD:${m.added.length} SKIP:${m.skipped.length} COLLISION:${m.collisions.length})`, "-m", "[omp-rail:archive]"]);
      }
      logInfo(`[queue] archive ${id}→${capability}: ADD:${m.added.length} SKIP:${m.skipped.length} COLLISION:${m.collisions.length}` +
        (m.collisions.length ? ` (collisions: ${m.collisions.join(",")} — reconcile вручную через archive_spec dedupe)` : ""));
    } catch (e) {
      logErr(`[queue] archive ${id} error: ${String(e)}`);
    }
  };

  /** Bypass-аудит: коммиты fromRef..HEAD без rail-подписи [omp-rail:*] (или legacy via *_worker/design())
   *  = обход рельса → guard bypass-suspected в telemetry. Автономный аналог tools/audit_commits.py. */
  const auditBypass = (fromRef: string, id: string): void => {
    try {
      const out = git(["log", `${fromRef}..HEAD`, "--format=%H%x00%s%x00%b%x1e"]);
      if (!out) return;
      const RAIL = /\[omp-rail:/;
      const LEGACY = /via (execute|codex)_worker|^design\([^)]+\): spec\+ADR locked/im;
      for (const rec of out.split("\x1e")) {
        const r = rec.replace(/^\n+/, "");
        if (!r.trim()) continue;
        const [sha, subject = "", body = ""] = r.split("\x00");
        const text = subject + "\n" + body;
        if (!RAIL.test(text) && !LEGACY.test(text))
          recordGuard(cwd, { event: "bypass-suspected", tid: id, tool: "queue-runner", detail: `${sha.slice(0, 9)} ${subject.slice(0, 120)}` });
      }
    } catch { /* аудит best-effort — очередь не встаёт */ }
  };

  /** Модель задачи (bucket для per-model потолка): execute-model|design-model из task-file; пусто → matchCap→default. */
  const taskModel = (text: string): string => scalar(text, "execute-model") || scalar(text, "design-model") || "";

  /** Задача считается done, если в headRef..HEAD появился rail-commit ИМЕННО этой задачи:
   *  subject `feat(<id>): … [omp-rail:*]` / `chore(spec): archive <id>` — атрибуция по tid, НЕ по глобальному HEAD
   *  (иначе при >1 активной чужой коммит ложно закрыл бы соседнюю задачу). */
  const tidCommitted = (headRef: string, id: string): boolean => {
    const out = git(["log", `${headRef}..HEAD`, "--format=%s%x00%b%x1e"]);
    if (!out) return false;
    const rx = new RegExp(`\\(${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)|\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const rec of out.split("\x1e")) {
      const text = rec.replace(/^\n+/, "");
      if (!text.trim()) continue;
      if (/\[omp-rail:/.test(text) && rx.test(text)) return true;
    }
    return false;
  };

  /** Все pending task-файлы (id не в терминальном/активном статусе и не in-flight), в порядке имени. */
  const pendingList = (st: State): { id: string; file: string; stage: string; text: string; model: string }[] => {
    if (!fs.existsSync(tasksDir)) return [];
    const out: { id: string; file: string; stage: string; text: string; model: string }[] = [];
    for (const f of fs.readdirSync(tasksDir).filter((n) => n.endsWith(".md")).sort()) {
      const fp = path.join(tasksDir, f);
      const text = fs.readFileSync(fp, "utf8");
      const id = scalar(text, "id") || path.basename(f, ".md");
      const status = st[id];
      if (status === "done" || status === "blocked" || status === "active" || actives.has(id)) continue;
      out.push({ id, file: path.relative(cwd, fp).replace(/\\/g, "/"), stage: scalar(text, "stage"), text, model: taskModel(text) });
    }
    return out;
  };

  /** Routing (детерминир., D2): design→design_worker, остальное→execute_worker. Оба резолвят домен/зону
   *  и коммитят внутри тула — lead только диспатчит (не оркестрирует, не реализует). */
  const promptFor = (file: string, stage: string, _text: string): string => {
    if (stage.startsWith("design"))
      return `Autonomous queue: обработай design-задачу. Вызови тул design_worker с параметром ` +
        `task="${file}" (полная design-стадия producer→gate→critic→commit внутри OMP). ` +
        `Отчитайся результатом одной строкой. Больше ничего не делай.`;
    return `Autonomous queue: обработай execute-задачу. Вызови тул execute_worker с параметром ` +
      `task="${file}" (резолв домен-агента→реализация код+тест→zone-check→test-cmd→commit внутри OMP). ` +
      `НЕ реализуй сам, НЕ вызывай design_worker. Отчитайся результатом одной строкой. Больше ничего не делай.`;
  };

  // Синхронный handler (никаких await до sendMessage — см. коммент к git()).
  // task-3 (parallel-N per model): reconcile ВСЕХ in-flight по tid rail-commit → dispatch пока
  //   ConcurrencyBudget разрешает (per-model потолок из models.yml + общий globalCap).
  // СУБСТРАТ-ОГОВОРКА: под single-lead (rpc/acp) воркеры сериализуются в одном lead-цикле — per-model
  //   потолок >1 даёт РЕАЛЬНЫЙ wall-clock параллелизм только когда очередь спавнит воркеров напрямую
  //   (backlog: direct-spawn). Аккаунтинг/атрибуция здесь — тот примитив, что это питает; при дефолт
  //   maxSubagents=1 поведение идентично прежнему (одна активная за раз).
  pi.on("agent_end", (_event, _ctx) => {
    if (processing) return;
    processing = true;
    try {
      const st = loadState();

      // 1. RECONCILE: закрыть done по tid rail-commit; накопить stall для не-сдвинувшихся.
      for (const a of [...actives.values()]) {
        if (tidCommitted(a.headRef, a.id)) {
          st[a.id] = "done";
          auditBypass(a.headRef, a.id);
          archiveOnDone(a.specPath, a.capability, a.id);
          budget.release(a.model);
          actives.delete(a.id);
          logInfo(`[queue] ${a.id}: done`);
        } else {
          a.stall++;
        }
      }
      // blocked: задача пережила свой grace (число активных на момент dispatch) без своего коммита.
      for (const a of [...actives.values()]) {
        if (a.stall < a.grace) continue;
        st[a.id] = "blocked";
        if (rollbackOnBlock && actives.size === 1) {  // rollback безопасен только когда она одна в полёте
          git(["reset", "--hard", "-q", a.headRef]);
          git(["clean", "-fdq", "-e", ".workflow"]);
        }
        budget.release(a.model);
        actives.delete(a.id);
        logInfo(`[queue] ${a.id}: blocked${rollbackOnBlock && actives.size === 0 ? " +rolled back" : ""}`);
      }
      saveState(st);

      // 2. DISPATCH: заполнять бюджет из pending, пока per-model/global потолок позволяет.
      const pend = pendingList(st);
      let dispatched = 0;
      for (const next of pend) {
        if (!budget.canDispatch(next.model)) continue;   // потолок этой модели исчерпан — пропускаем
        st[next.id] = "active";
        budget.acquire(next.model);
        actives.set(next.id, {
          id: next.id, headRef: head(),
          specPath: resolveSpec(next.text, next.id),
          capability: scalar(next.text, "capability") || "system",
          model: next.model, stall: 0, grace: actives.size,   // grace = число уже активных (min 1 после acquire)
        });
        saveState(st);
        // Синхронный инжект (персистентный host rpc/acp — нет teardown-гонки). Под `omp -p` (single-shot)
        // сессия disposed после agent_end → re-drive не работает; substrate обязан быть персистентным.
        pi.sendMessage(promptFor(next.file, next.stage, next.text), { triggerTurn: true, deliverAs: "followUp" });
        logInfo(`[queue] dispatch ${next.id} (${next.stage || "execute"}, model=${next.model || "default"}, inflight=${budget.count(next.model)}/${budget.capFor(next.model)})`);
        dispatched++;
      }
      if (!dispatched && !actives.size) logInfo("[queue] drained"); // headless -p завершится сам
    } catch (e) {
      logErr(`[queue] error: ${String(e)}`);
    } finally {
      processing = false;
    }
  });

  pi.registerCommand("queue", {
    description: "autonomous queue-runner status",
    handler: async () => {
      const st = loadState();
      const counts = { pending: 0, active: 0, done: 0, blocked: 0 } as Record<string, number>;
      for (const v of Object.values(st)) counts[v] = (counts[v] || 0) + 1;
      const inflight = [...actives.values()].map((a) => `${a.id}@${a.model || "default"}`).join(", ") || "—";
      return `queue-runner ARMED (globalCap=${globalCap === Infinity ? "∞" : globalCap}). state: ${JSON.stringify(counts)}. in-flight: ${inflight}`;
    },
  });
}
