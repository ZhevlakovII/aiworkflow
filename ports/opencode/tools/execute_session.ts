// execute_session — in-session execute driver (B2b port from OMP). Thin OpenCode tool over B1/B2b judge + zoneCheck.
// Lead spawns executor/domain-dev as native task-agents; this tool NEVER spawns models.
// Steps: begin → (lead: spawn resolved agent) → check → done → lead uses gated_commit.
import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseZone, scalarField } from "../lib/task";
import { zoneCheck } from "../lib/zonecheck";
import { resolveAgent, loadZoneMap, type ZoneMap } from "../lib/zonemap";
import { ok, err } from "../lib/result";
import { nodeGitSeam } from "../../../core/src/rails/git-seam.ts";
import { runJudgeCli, type JudgeCliDeps } from "../../../core/src/stage/judge-cli.ts";
import { contractKey12 } from "../../../core/src/stage/journal.ts";

const STEPS = ["begin", "check", "done"] as const;
type Step = (typeof STEPS)[number];

const ACTIVE_ZONE_REL = ".workflow/active-zone.json";

export interface DomainResolve {
  agent: string;
  note: string;
}

/** Резолв домен-агента из zonemap — same helpers/rules as legacy execute_worker. */
export function resolveExecuteDomain(cwd: string, taskText: string): DomainResolve {
  let zm: ZoneMap | null = null;
  try {
    zm = loadZoneMap(path.resolve(cwd, ".opencode/zonemap.yml"));
  } catch {
    zm = null;
  }
  if (!zm) return { agent: "executor", note: "нет zonemap → generic executor" };
  const { allow } = parseZone(taskText);
  const r = resolveAgent(allow, zm);
  if (r.denied.length) {
    return { agent: "executor", note: `deny-domain в зоне (${r.denied.join(",")}) — не трогать` };
  }
  if (r.ambiguous) {
    return {
      agent: "executor",
      note: `ambiguous домены (${r.matched.join(",")}) → generic executor; раздели зону для домен-агента`,
    };
  }
  return {
    agent: r.agent,
    note: r.agent === "executor" ? "нет домен-матча → executor" : `домен ${r.tech} → ${r.agent}`,
  };
}

/** Payload for `.workflow/active-zone.json` (UTF-8, no BOM). Extra `by:judge` is ignored by parsers. */
export function activeZonePayload(
  tid: string,
  allow: string[],
  deny: string[],
): { task: string; allow: string[]; deny?: string[]; by: "judge" } {
  const body: { task: string; allow: string[]; deny?: string[]; by: "judge" } = {
    task: tid,
    allow,
    by: "judge",
  };
  if (deny.length) body.deny = deny;
  return body;
}

export function writeActiveZone(cwd: string, tid: string, allow: string[], deny: string[]): string {
  const abs = path.join(cwd, ACTIVE_ZONE_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(activeZonePayload(tid, allow, deny)), "utf8");
  return ACTIVE_ZONE_REL;
}

export interface StagedZoneEval {
  staged: string[];
  violations: string[];
  error?: string;
}

/** git add -A then zoneCheck staged vs task allow/deny. Does not commit. */
export function evalStagedZone(cwd: string, taskText: string): StagedZoneEval {
  const git = nodeGitSeam(cwd);
  const add = git.run(["git", "add", "-A"]);
  if (add.code !== 0) return { staged: [], violations: [], error: "git add failed: " + (add.stderr || "").trim() };
  const diff = git.run(["git", "diff", "--cached", "--name-only"]);
  if (diff.code !== 0) {
    return { staged: [], violations: [], error: "git diff --cached failed: " + (diff.stderr || "").trim() };
  }
  const staged = diff.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const z = parseZone(taskText);
  const violations = z.allow.length ? zoneCheck(staged, z.allow, z.deny) : [];
  return { staged, violations };
}

function prodDeps(cwd: string): JudgeCliDeps {
  return {
    cwd,
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };
}

function judgeToTool(r: { stdout: string; stderr: string; exitCode: number }, extra = "") {
  const body = [r.stdout, r.stderr, extra].filter((s) => s && s.trim()).join("\n");
  if (r.exitCode === 0) return ok(body || "ok");
  return err(body || `judge exit ${r.exitCode}`);
}

function formatCheck(evaled: StagedZoneEval): string {
  const files = evaled.staged.length
    ? evaled.staged.map((s) => "  + " + s).join("\n")
    : "  (none staged)";
  if (evaled.violations.length) {
    return (
      `zoneCheck VIOLATION (${evaled.violations.length}):\n` +
      evaled.violations.map((x) => "  [x] " + x).join("\n") +
      `\nstaged:\n${files}`
    );
  }
  return `zoneCheck OK (${evaled.staged.length} staged)\nstaged:\n${files}`;
}

export default tool({
  description:
    "In-session execute driver (B2b default). Steps: begin | check | done. " +
    "Calls judge + zoneCheck only — lead spawns executor/domain-dev as native agents. " +
    "Never spawns models. After done → use gated_commit.",
  args: {
    step: tool.schema.enum(STEPS).describe("begin | check | done"),
    task: tool.schema.string().describe("path to locked execute task-file"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
    const step = params.step as Step;
    const taskPath = path.resolve(cwd, params.task);
    if (!fs.existsSync(taskPath)) return err("task-file не найден: " + params.task);
    const taskText = fs.readFileSync(taskPath, "utf8");
    const tid = scalarField(taskText, "id") || path.basename(taskPath, ".md");
    const stage = (scalarField(taskText, "stage") || "").toLowerCase();
    if (stage.startsWith("design")) {
      return err(
        `MISROUTE: execute_session на design-задаче (stage=${stage}). ` +
          `Только stage:execute* (не design*).`,
      );
    }
    const taskRel = path.relative(cwd, taskPath).split(path.sep).join("/");
    const deps = prodDeps(cwd);
    const z = parseZone(taskText);
    const ck12 = contractKey12(taskText);

    if (step === "begin") {
      const r = runJudgeCli(["execute-begin", "--task", taskRel], deps);
      if (r.exitCode !== 0) return judgeToTool(r);
      const { agent, note } = resolveExecuteDomain(cwd, taskText);
      const zoneRel = writeActiveZone(cwd, tid, z.allow, z.deny);
      const globs = z.allow.length ? z.allow.map((g) => "  - " + g).join("\n") : "  (none)";
      const handoff =
        `=== EXECUTE SESSION begin: ${tid} (ck12=${ck12}) ===\n` +
        `${r.stdout}\n\n` +
        `Executor handoff (spawn native ${agent}; Write only allow globs):\n` +
        `  agent: ${agent} [${note}]\n` +
        `  task: ${taskRel}\n` +
        `  zone: ${zoneRel}\n` +
        `  allow:\n${globs}\n` +
        `Next: after executor writes in zone → execute_session(step=check, task=...).`;
      return ok(handoff);
    }

    if (step === "check") {
      const ev = evalStagedZone(cwd, taskText);
      if (ev.error) return err(ev.error);
      const summary = formatCheck(ev);
      const note = "journal: check is diagnostic only (no judge event); record via step=done.";
      if (ev.violations.length) {
        return err(`${summary}\n${note}\nNext: fix out-of-zone paths → execute_session(step=check, ...) again.`);
      }
      return ok(
        `${summary}\n${note}\nNext: execute_session(step=done, task=...). Then gated_commit(task=${taskRel}).`,
      );
    }

    if (step === "done") {
      const ev = evalStagedZone(cwd, taskText);
      if (ev.error) return err(ev.error);
      const outcome = ev.violations.length ? "violation" : "ok";
      const r = runJudgeCli(
        ["execute-done", "--task", taskRel, "--outcome", outcome],
        deps,
      );
      const summary = formatCheck(ev);
      if (r.exitCode !== 0) return judgeToTool(r, summary);
      if (outcome === "violation") {
        return err(
          `${r.stdout}\n${summary}\n` +
            `execute-done outcome=violation. Do not gated_commit until zone is clean.`,
        );
      }
      return ok(
        `${r.stdout}\n${summary}\n` +
          `EXECUTE DONE (ok). Commit via gated_commit(message=..., task=${taskRel}) — ` +
          `do not raw-git-commit.`,
      );
    }

    return err(`unknown step: ${step}`);
  },
});
