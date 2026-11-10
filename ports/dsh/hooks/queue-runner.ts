// queue-runner — autonomous task queue (DSH Cordis). Armed: DSH_QUEUE or AIWF_QUEUE.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { CordisContext } from "../tools/_lib/cordis.ts";
import { parseBlocksRaw, mergeCanon, emitCanon } from "../tools/_lib/archivespec.ts";
import { recordGuard } from "../tools/_lib/telemetry.ts";
import { loadModelCaps, ConcurrencyBudget } from "../tools/_lib/modelcaps.ts";

type State = Record<string, "pending" | "active" | "done" | "blocked">;

interface Active {
  id: string;
  headRef: string;
  specPath: string;
  capability: string;
  model: string;
  stall: number;
  grace: number;
}

function queueArmed(): boolean {
  const v = process.env.DSH_QUEUE || process.env.AIWF_QUEUE;
  return v === "1" || v === "true" || v === "yes";
}

function scalar(text: string, key: string): string {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"));
  return m ? m[1].replace(/\s+#\s.*$/, "").trim().replace(/^["']|["']$/g, "") : "";
}

export function registerQueueRunner(ctx: CordisContext): void {
  if (!queueArmed()) return;

  const cwd = ctx.cwd;
  const tasksDir = path.resolve(cwd, process.env.DSH_QUEUE_TASKS_DIR || process.env.AIWF_QUEUE_TASKS_DIR || ".workflow/tasks");
  const statePath = path.resolve(cwd, process.env.DSH_QUEUE_STATE || process.env.AIWF_QUEUE_STATE || ".workflow/queue-state.json");
  const rollbackOnBlock = !!(process.env.DSH_QUEUE_ROLLBACK || process.env.AIWF_QUEUE_ROLLBACK);
  const globalCap =
    Number(process.env.DSH_QUEUE_MAX_PARALLEL || process.env.AIWF_QUEUE_MAX_PARALLEL) > 0
      ? Number(process.env.DSH_QUEUE_MAX_PARALLEL || process.env.AIWF_QUEUE_MAX_PARALLEL)
      : 1;
  const budget = new ConcurrencyBudget(loadModelCaps(cwd), globalCap);
  const hasInject = typeof ctx.sendMessage === "function";

  let processing = false;
  const actives = new Map<string, Active>();

  const logsDir = path.resolve(cwd, ".workflow/logs");
  const qlog = path.join(logsDir, `queue-dsh-${new Date().toISOString().slice(0, 10)}.log`);
  const dispatchLog = path.resolve(cwd, ".workflow/queue-dispatch.ndjson");

  const fileLog = (level: string, msg: string): void => {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.appendFileSync(qlog, `${new Date().toISOString()} [${level}] ${msg}\n`, "utf8");
    } catch {
      /* best-effort */
    }
  };
  const logInfo = (m: string): void => {
    ctx.logger?.info?.(m);
    fileLog("info", m);
  };
  const logErr = (m: string): void => {
    ctx.logger?.error?.(m);
    fileLog("error", m);
  };

  const loadState = (): State => {
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      return {};
    }
  };
  const saveState = (st: State) => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2), "utf8");
  };

  const git = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const head = (): string => git(["rev-parse", "HEAD"]);

  const resolveSpec = (taskText: string, id: string): string => {
    const field = scalar(taskText, "spec");
    return field ? path.resolve(cwd, field) : path.resolve(cwd, "docs/design", `${id}-spec.md`);
  };

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
        git([
          "commit",
          "-m",
          `chore(spec): archive ${id} → ${capability} canon (ADD:${m.added.length} SKIP:${m.skipped.length} COLLISION:${m.collisions.length})`,
          "-m",
          "[dsh-rail:archive]",
        ]);
      }
      logInfo(
        `[queue] archive ${id}→${capability}: ADD:${m.added.length} SKIP:${m.skipped.length} COLLISION:${m.collisions.length}` +
          (m.collisions.length ? ` (collisions: ${m.collisions.join(",")} — archive_spec reconcile)` : ""),
      );
    } catch (e) {
      logErr(`[queue] archive ${id} error: ${String(e)}`);
    }
  };

  const auditBypass = (fromRef: string, id: string): void => {
    try {
      const out = git(["log", `${fromRef}..HEAD`, "--format=%H%x00%s%x00%b%x1e"]);
      if (!out) return;
      const RAIL = /\[(?:dsh|omp)-rail:/;
      const LEGACY = /via execute_session|design_session\(/im;
      for (const rec of out.split("\x1e")) {
        const r = rec.replace(/^\n+/, "");
        if (!r.trim()) continue;
        const [sha, subject = "", body = ""] = r.split("\x00");
        const text = subject + "\n" + body;
        if (!RAIL.test(text) && !LEGACY.test(text)) {
          recordGuard(cwd, {
            event: "bypass-suspected",
            tid: id,
            tool: "queue-runner",
            detail: `${sha.slice(0, 9)} ${subject.slice(0, 120)}`,
          });
        }
      }
    } catch {
      /* best-effort */
    }
  };

  const taskModel = (text: string): string => scalar(text, "execute-model") || scalar(text, "design-model") || "";

  const tidCommitted = (headRef: string, id: string): boolean => {
    const out = git(["log", `${headRef}..HEAD`, "--format=%s%x00%b%x1e"]);
    if (!out) return false;
    const rx = new RegExp(`\\(${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)|\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const rec of out.split("\x1e")) {
      const text = rec.replace(/^\n+/, "");
      if (!text.trim()) continue;
      if (/\[(?:dsh|omp)-rail:/.test(text) && rx.test(text)) return true;
    }
    return false;
  };

  const pendingList = (st: State): { id: string; file: string; stage: string; text: string; model: string }[] => {
    if (!fs.existsSync(tasksDir)) return [];
    const out: { id: string; file: string; stage: string; text: string; model: string }[] = [];
    for (const f of fs.readdirSync(tasksDir).filter((n) => n.endsWith(".md")).sort()) {
      const fp = path.join(tasksDir, f);
      const text = fs.readFileSync(fp, "utf8");
      const id = scalar(text, "id") || path.basename(f, ".md");
      const status = st[id];
      if (status === "done" || status === "blocked" || status === "active" || actives.has(id)) continue;
      out.push({
        id,
        file: path.relative(cwd, fp).replace(/\\/g, "/"),
        stage: scalar(text, "stage"),
        text,
        model: taskModel(text),
      });
    }
    return out;
  };

  const promptFor = (file: string, stage: string): string => {
    if (stage.startsWith("design")) {
      return (
        `Autonomous queue (DSH): design-задача. Пройди design_session(begin→gate→critic-record→lock) для task="${file}". ` +
        `Spawn producer/critic natively. gated_commit с [dsh-rail:design]. Одна строка итога.`
      );
    }
    return (
      `Autonomous queue (DSH): execute-задача. Пройди execute_session(begin→check→done) для task="${file}". ` +
      `Spawn executor/domain из handoff. gated_commit с [dsh-rail:execute]. НЕ design_session. Одна строка итога.`
    );
  };

  const appendDispatchFallback = (id: string, prompt: string): void => {
    try {
      fs.mkdirSync(path.dirname(dispatchLog), { recursive: true });
      fs.appendFileSync(
        dispatchLog,
        JSON.stringify({ ts: new Date().toISOString(), id, prompt, note: "no ctx.sendMessage" }) + "\n",
        "utf8",
      );
    } catch {
      /* ignore */
    }
  };

  const onTurnEnd = (): void => {
    if (processing) return;
    processing = true;
    try {
      const st = loadState();

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
      for (const a of [...actives.values()]) {
        if (a.stall < a.grace) continue;
        st[a.id] = "blocked";
        if (rollbackOnBlock && actives.size === 1) {
          git(["reset", "--hard", "-q", a.headRef]);
          git(["clean", "-fdq", "-e", ".workflow"]);
        }
        budget.release(a.model);
        actives.delete(a.id);
        logInfo(`[queue] ${a.id}: blocked${rollbackOnBlock ? " (rollback?)" : ""}`);
      }
      saveState(st);

      const pend = pendingList(st);
      let dispatched = 0;
      for (const next of pend) {
        if (!budget.canDispatch(next.model)) continue;
        st[next.id] = "active";
        budget.acquire(next.model);
        actives.set(next.id, {
          id: next.id,
          headRef: head(),
          specPath: resolveSpec(next.text, next.id),
          capability: scalar(next.text, "capability") || "system",
          model: next.model,
          stall: 0,
          grace: actives.size,
        });
        saveState(st);
        const prompt = promptFor(next.file, next.stage);
        if (hasInject) {
          ctx.sendMessage!(prompt, { triggerTurn: true, deliverAs: "followUp" });
        } else {
          appendDispatchFallback(next.id, prompt);
        }
        logInfo(
          `[queue] dispatch ${next.id} (${next.stage || "execute"}, inject=${hasInject ? "live" : "fallback-ndjson"})`,
        );
        dispatched++;
      }
      if (!dispatched && !actives.size) logInfo("[queue] drained");
    } catch (e) {
      logErr(`[queue] error: ${String(e)}`);
    } finally {
      processing = false;
    }
  };

  const events = ["agent_end", "turn_end", "session_turn_end"];
  let subscribed = 0;
  for (const ev of events) {
    try {
      ctx.hooks.on(ev, async () => {
        onTurnEnd();
        return undefined;
      });
      subscribed++;
    } catch {
      /* unsupported */
    }
  }
  if (!subscribed) {
    logErr("[queue] no turn-end hook on this Cordis build — queue armed but idle (see README)");
  }

  ctx.registerCommand?.("queue", {
    description: "autonomous queue-runner status (DSH)",
    handler: async () => {
      const st = loadState();
      const counts = { pending: 0, active: 0, done: 0, blocked: 0 } as Record<string, number>;
      for (const v of Object.values(st)) counts[v] = (counts[v] || 0) + 1;
      const inflight = [...actives.values()].map((a) => `${a.id}@${a.model || "default"}`).join(", ") || "—";
      return `queue-runner ARMED (DSH; inject=${hasInject}; globalCap=${globalCap === Infinity ? "∞" : globalCap}). state: ${JSON.stringify(counts)}. in-flight: ${inflight}`;
    },
  });

  logInfo(`[queue] armed (hooks=${subscribed}, inject=${hasInject})`);
}
