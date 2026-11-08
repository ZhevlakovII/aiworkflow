// scaffold_session — in-session scaffold driver (T4 port from OMP). Thin OpenCode tool over judge scaffold-begin/done + zoneCheck.
// Lead spawns fixed agent `scaffolder` as native task-agent; this tool NEVER spawns models.
// Steps: begin → (lead: spawn scaffolder) → check → done → lead uses gated_commit.
import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseZone, scalarField } from "../lib/task";
import { zoneCheck } from "../lib/zonecheck";
import { ok, err } from "../lib/result";
import { nodeGitSeam } from "../../../core/src/rails/git-seam.ts";
import { runJudgeCli, type JudgeCliDeps } from "../../../core/src/stage/judge-cli.ts";
import { contractKey12 } from "../../../core/src/stage/journal.ts";

const STEPS = ["begin", "check", "done"] as const;
type Step = (typeof STEPS)[number];

const ACTIVE_ZONE_REL = ".workflow/active-zone.json";
const SCAFFOLDER_AGENT = "scaffolder";

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
    "In-session scaffold driver (between design lock and execute). Steps: begin | check | done. " +
    "Calls judge + zoneCheck only — lead spawns fixed scaffolder as native agent. " +
    "Never spawns models. After done → use gated_commit.",
  args: {
    step: tool.schema.enum(STEPS).describe("begin | check | done"),
    task: tool.schema.string().describe("path to locked scaffold task-file"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
    const step = params.step as Step;
    const taskPath = path.resolve(cwd, params.task);
    if (!fs.existsSync(taskPath)) return err("task-file не найден: " + params.task);
    const taskText = fs.readFileSync(taskPath, "utf8");
    const tid = scalarField(taskText, "id") || path.basename(taskPath, ".md");
    const stage = (scalarField(taskText, "stage") || "").toLowerCase();
    if (stage.startsWith("design") || stage.startsWith("execute") || !stage.startsWith("scaffold")) {
      return err(
        `MISROUTE: scaffold_session на не-scaffold задаче (stage=${stage || "<none>"}). ` +
          `Только stage:scaffold* (не design*/execute*).`,
      );
    }
    const taskRel = path.relative(cwd, taskPath).split(path.sep).join("/");
    const deps = prodDeps(cwd);
    const z = parseZone(taskText);
    const ck12 = contractKey12(taskText);

    if (step === "begin") {
      const r = runJudgeCli(["scaffold-begin", "--task", taskRel], deps);
      if (r.exitCode !== 0) return judgeToTool(r);
      const zoneRel = writeActiveZone(cwd, tid, z.allow, z.deny);
      const globs = z.allow.length ? z.allow.map((g) => "  - " + g).join("\n") : "  (none)";
      const handoff =
        `=== SCAFFOLD SESSION begin: ${tid} (ck12=${ck12}) ===\n` +
        `${r.stdout}\n\n` +
        `Scaffolder handoff (spawn native ${SCAFFOLDER_AGENT}; Write only allow globs):\n` +
        `  agent: ${SCAFFOLDER_AGENT} [fixed; no zonemap domain resolve]\n` +
        `  task: ${taskRel}\n` +
        `  zone: ${zoneRel}\n` +
        `  allow:\n${globs}\n` +
        `Next: after scaffolder writes in zone → scaffold_session(step=check, task=...).`;
      return ok(handoff);
    }

    if (step === "check") {
      const ev = evalStagedZone(cwd, taskText);
      if (ev.error) return err(ev.error);
      const summary = formatCheck(ev);
      const note = "journal: check is diagnostic only (no judge event); record via step=done.";
      if (ev.violations.length) {
        return err(`${summary}\n${note}\nNext: fix out-of-zone paths → scaffold_session(step=check, ...) again.`);
      }
      return ok(
        `${summary}\n${note}\nNext: scaffold_session(step=done, task=...). Then gated_commit(task=${taskRel}).`,
      );
    }

    if (step === "done") {
      const ev = evalStagedZone(cwd, taskText);
      if (ev.error) return err(ev.error);
      const outcome = ev.violations.length ? "violation" : "ok";
      const r = runJudgeCli(
        ["scaffold-done", "--task", taskRel, "--outcome", outcome],
        deps,
      );
      const summary = formatCheck(ev);
      if (r.exitCode !== 0) return judgeToTool(r, summary);
      if (outcome === "violation") {
        return err(
          `${r.stdout}\n${summary}\n` +
            `scaffold-done outcome=violation. Do not gated_commit until zone is clean.`,
        );
      }
      return ok(
        `${r.stdout}\n${summary}\n` +
          `SCAFFOLD DONE (ok). Commit via gated_commit(message=..., task=${taskRel}) — ` +
          `do not raw-git-commit.`,
      );
    }

    return err(`unknown step: ${step}`);
  },
});
