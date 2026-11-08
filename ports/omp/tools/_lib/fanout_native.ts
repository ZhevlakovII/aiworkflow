// omp-fanout Path B (ЭКСПЕРИМЕНТАЛЬНЫЙ, за флагом OMP_FANOUT_NATIVE=1) — нативный isolated task-субагент.
//
// Probe (2026-09-01, .workflow/probe-fanout.json) показал: customTool.pi.pi (PiCodingAgent) экспортит
//   BUILTIN_TOOLS.task, TaskTool, createAgentSession, Executor, createSubagentSettings; TaskParams несёт
//   isolated:true (projfs/worktree). НО контракт вызова task-тула из customTool НЕ задокументирован →
//   это спекулятивная попытка. Path A (git-worktree, backend.ts) — валидированный дефолт; B — upgrade,
//   даёт НАТИВНУЮ projfs-изоляцию (OMP-managed) вместо нашей git-worktree.
//
// Контракт: любой сбой/неизвестная форма → { ok:false, reason } → вызывающий тул ПАДАЕТ обратно на Path A.
//   Диагностика формы пишется в .workflow/fanout-native-diag.json (как probe) — для итерации под yolo.
//
// ВАЛИДАЦИЯ (нужны твои yolo-прогоны, у меня классификатор рубит --yolo):
//   OMP_FANOUT_NATIVE=1 omp -p "<execute-задача через execute_worker>" --yolo
//   → смотри fanout-native-diag.json + сошёлся ли isolated-спавн.
import * as fs from "node:fs";
import * as path from "node:path";

export interface NativeFanoutReq {
  taskPrompt: string;   // контракт-инструкция воркеру (workerPrompt)
  agent: string;        // домен-агент (резолвится против OMP agent-registry, вкл. .omp/agents)
  cwd: string;
}
export type NativeFanoutResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: string };

/** Пишет диагностику формы task-API (best-effort) для итерации. */
function diag(cwd: string, obj: unknown): void {
  try {
    const dir = path.resolve(cwd, ".workflow");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "fanout-native-diag.json"), JSON.stringify(obj, null, 2), "utf8");
  } catch { /* best-effort */ }
}

/** Попытка native isolated task-спавна. pi = полный CustomToolAPI (с .pi), ctx = CustomToolContext. */
export async function tryFanoutNative(
  pi: unknown, ctx: unknown, req: NativeFanoutReq, signal?: AbortSignal,
): Promise<NativeFanoutResult> {
  const P = (pi as { pi?: Record<string, unknown> })?.pi;
  if (!P) return { ok: false, reason: "pi.pi (PiCodingAgent) недоступен" };

  const builtins = P.BUILTIN_TOOLS as Record<string, unknown> | undefined;
  const taskEntry = builtins?.task ?? P.TaskTool;
  if (typeof taskEntry !== "function") {
    diag(req.cwd, { piPiKeys: Object.keys(P).slice(0, 50), hasBuiltins: !!builtins, taskType: typeof taskEntry });
    return { ok: false, reason: "task-тул не найден в pi.pi.BUILTIN_TOOLS/TaskTool" };
  }

  const params = { task: req.taskPrompt, agent: req.agent, isolated: true };

  // Форма вызова не сверена — пробуем наиболее вероятные, ловим каждую.
  // (1) taskEntry — фабрика (pi)=>tool: instantiate, затем tool.execute(id, params, onUpdate, ctx, signal).
  // (2) taskEntry — уже tool-объект с execute.
  const attempts: { how: string; run: () => Promise<unknown> }[] = [];
  try {
    const maybeTool = (taskEntry as (p: unknown) => unknown)(P);
    if (maybeTool && typeof (maybeTool as { execute?: unknown }).execute === "function") {
      attempts.push({ how: "factory(P).execute(id,params,undef,ctx,signal)", run: () =>
        (maybeTool as { execute: (...a: unknown[]) => Promise<unknown> }).execute("fanout", params, undefined, ctx, signal) });
    }
  } catch (e) { /* фабрика бросила — пробуем как объект */ diag(req.cwd, { factoryThrow: String(e) }); }
  if (typeof (taskEntry as { execute?: unknown }).execute === "function") {
    attempts.push({ how: "taskEntry.execute(id,params,undef,ctx,signal)", run: () =>
      (taskEntry as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute("fanout", params, undefined, ctx, signal) });
  }

  if (!attempts.length) {
    diag(req.cwd, { taskEntryKeys: Object.getOwnPropertyNames(taskEntry), note: "нет распознанной execute-формы" });
    return { ok: false, reason: "не распознана форма вызова task-тула (см. fanout-native-diag.json)" };
  }

  for (const a of attempts) {
    try {
      const res = await a.run();
      const r = res as { isError?: boolean; content?: { text?: string }[] };
      const text = (r?.content ?? []).map((c) => c?.text ?? "").join("\n");
      if (r?.isError) { diag(req.cwd, { how: a.how, isError: true, text }); continue; }
      diag(req.cwd, { how: a.how, ok: true });
      return { ok: true, stdout: `[omp-fanout NATIVE] через ${a.how}\n${text}` };
    } catch (e) {
      diag(req.cwd, { how: a.how, threw: String(e) });
    }
  }
  return { ok: false, reason: "все формы вызова native task упали (см. fanout-native-diag.json) → fallback Path A" };
}
