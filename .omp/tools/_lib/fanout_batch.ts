// fanout_batch — параллельная worker-фаза Path A (direct-spawn ×N) для очереди (task-3 продолжение).
// Проблема, которую решает: queue-runner под single-lead сериализует воркеров. Здесь очередь спавнит
//   N изолированных воркеров САМА, каждый в git-worktree клоне, параллельно — с потолком per-model
//   (ConcurrencyBudget). Гонки за git убраны разделением фаз:
//     • serial (быстро): git worktree add ×N   — трогает main refs/worktree-метаданные (lock-sensitive).
//     • parallel (медленно): runInner + git add/diff В КЛОНЕ — у каждого worktree СВОЙ index → безопасно;
//       LLM-работа (самое долгое) идёт разом.
//     • serial (быстро): worktree remove + branch -D ×N — снова main refs.
//   Commit-rail (zone-check/test/commit в РЕАЛЬНОМ tree) — за вызывающим, per-task серийно (зоны задач
//   непересекающиеся → bring-back копии не коллизят, коммит детерминирован).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkerPi, WorkerReq, WorkerRes, InnerRunner } from "./backend";
import type { ConcurrencyBudget } from "./modelcaps";

export interface BatchTask<T> {
  id: string;
  model: string;            // bucket для ConcurrencyBudget
  req: WorkerReq;           // system/user/model/inZone
  meta: T;                  // payload вызывающего (task-file/зона/spec/capability) — batch не интерпретирует
}

export interface BatchResult<T> {
  id: string;
  meta: T;
  worker?: WorkerRes;       // результат worker'а (code/stdout/stderr/usage); нет → setup упал
  brought: string[];        // in-zone файлы, внесённые в реальный tree (готовы к commit-rail)
  discarded: string[];      // вне-зоны (остались в клоне, отброшены с ним — isolation)
  error?: string;           // setup/worktree ошибка (worker не запускался или клон не создался)
}

/** Планировщик с ограничением параллелизма по budget (per-model + global). Стартует задачу ⟺ бюджет её
 *  модели позволяет; иначе ждёт освобождения слота. Возвращает результаты в порядке ВХОДА. */
export async function runBudgeted<A, R>(
  items: A[], keyOf: (a: A) => string, budget: ConcurrencyBudget, run: (a: A) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const remaining = items.map((a, i) => ({ a, i }));
  const active = new Map<Promise<void>, true>();

  const launch = (a: A, i: number): Promise<void> => {
    const key = keyOf(a);
    budget.acquire(key);
    const p = run(a).then((r) => { results[i] = r; }).finally(() => budget.release(key));
    const wrapped = p.then(() => { active.delete(wrapped); });
    active.set(wrapped, true);
    return wrapped;
  };

  while (remaining.length || active.size) {
    // стартовать всё, что бюджет пускает прямо сейчас
    let started = false;
    for (let k = 0; k < remaining.length; ) {
      const { a, i } = remaining[k];
      if (budget.canDispatch(keyOf(a))) { remaining.splice(k, 1); launch(a, i); started = true; }
      else k++;
    }
    // ничего не стартанули и есть активные → ждём первого освобождения; иначе (не стартанули и нет активных)
    //   значит бюджет всех оставшихся = 0 (cap 0) — защита от вечного цикла: ждём если есть active.
    if (active.size) await Promise.race(active.keys());
    else if (!started && remaining.length) {
      // ни один не может стартовать и нет активных (напр. cap=0) — форсим по одному, чтоб не зависнуть
      const { a, i } = remaining.shift()!;
      await launch(a, i);
    }
  }
  return results;
}

const git = (pi: WorkerPi, args: string[], cwd = pi.cwd) => pi.exec("git", args, { cwd });

/** Направляет параллельную worker-фазу над задачами. runInner инъектируем (прод = claude-in-clone; тест = фейк).
 *  Возврат: per-task результат с brought/discarded/worker. Commit-rail — за вызывающим. */
export async function fanoutBatch<T>(
  pi: WorkerPi, tasks: BatchTask<T>[], budget: ConcurrencyBudget, runInner: InnerRunner,
): Promise<BatchResult<T>[]> {
  if (!tasks.length) return [];
  // HEAD-prereq (изоляция требует ≥1 коммита).
  if ((await git(pi, ["rev-parse", "HEAD"])).code !== 0)
    return tasks.map((t) => ({ id: t.id, meta: t.meta, brought: [], discarded: [], error: "изоляция требует git-репо с ≥1 коммитом (валидный HEAD)" }));

  // Фаза 1 (serial): worktree add ×N — main refs lock-sensitive.
  interface WT { task: BatchTask<T>; wt: string; branch: string; ok: boolean; err?: string; }
  const wts: WT[] = [];
  for (const task of tasks) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const wt = path.join(os.tmpdir(), `omp-batch-${id}`);
    const branch = `omp/batch/${id}`;
    const add = await git(pi, ["worktree", "add", "-b", branch, wt, "HEAD"]);
    wts.push({ task, wt, branch, ok: add.code === 0, err: add.code !== 0 ? (add.stderr || "").slice(-400) : undefined });
  }

  // Фаза 2 (parallel, budget): runInner + add/diff в СВОЁМ index клона + bring-back in-zone.
  //   Cleanup worktree'ов — в finally: даже при throw в worker-фазе изоляты не текут.
  let results: BatchResult<T>[];
  try {
  results = await runBudgeted(
    wts, (w) => w.task.model, budget,
    async (w): Promise<BatchResult<T>> => {
      const base = { id: w.task.id, meta: w.task.meta };
      if (!w.ok) return { ...base, brought: [], discarded: [], error: "git worktree add failed: " + (w.err || "") };
      const innerPi: WorkerPi = { cwd: w.wt, exec: (c, a, o) => pi.exec(c, a, o) };
      let worker: WorkerRes;
      try { worker = await runInner(innerPi, w.task.req); }
      catch (e) { return { ...base, brought: [], discarded: [], error: "runInner threw: " + ((e as Error)?.message || String(e)) }; }
      if (worker.code !== 0) return { ...base, worker, brought: [], discarded: [] };

      if ((await git(pi, ["add", "-A"], w.wt)).code !== 0)
        return { ...base, worker, brought: [], discarded: [], error: "git add в worktree failed" };
      const changed = (await git(pi, ["diff", "--cached", "--name-only"], w.wt)).stdout
        .split("\n").map((s) => s.trim()).filter(Boolean);
      const inZone = w.task.req.inZone ?? (() => true);
      const brought: string[] = [], discarded: string[] = [];
      for (const f of changed) {
        if (!inZone(f)) { discarded.push(f); continue; }
        try {
          const src = path.join(w.wt, f), dst = path.join(pi.cwd, f);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
          brought.push(f);
        } catch (e) { return { ...base, worker, brought, discarded, error: `copy-back ${f}: ${(e as Error).message}` }; }
      }
      return { ...base, worker, brought, discarded };
    },
  );
  } finally {
    // Фаза 3 (serial): cleanup worktree + branch (main refs) — всегда, даже при исключении.
    for (const w of wts) {
      await git(pi, ["worktree", "remove", "--force", w.wt]);
      await git(pi, ["branch", "-D", w.branch]);
    }
  }
  return results;
}
