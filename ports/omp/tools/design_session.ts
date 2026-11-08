// design_session — in-session design driver (B2a). Thin customTool over B1 judge + gateLint.
// Lead spawns producer/critic as native task-agents; this tool NEVER spawns models.
// Steps: begin → (lead: producer) → gate → [bounce→producer retry×1] → (lead: critic) →
//   critic-record → lock → lead uses gated_commit.
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseZone, scalarField } from "./_lib/task";
import { gateLint } from "./_lib/gatelint";
import { ok, err } from "./_lib/result";
import { runJudgeCli, type JudgeCliDeps } from "../../../core/src/stage/judge-cli.ts";
import {
  contractKey12,
  readJournal,
  type StageJournalEvent,
} from "../../../core/src/stage/journal.ts";

const STEPS = ["begin", "gate", "critic-record", "lock"] as const;
type Step = (typeof STEPS)[number];

/** Design out-dir = first allow-glob of task zone without glob tail (default docs/design). */
export function outDirFromTask(taskText: string): string {
  const a = parseZone(taskText).allow.find((x) => !x.startsWith(".workflow"));
  return (a || "docs/design").replace(/\/\*\*?$/, "").trim() || "docs/design";
}

/** Rel paths for producer/critic handoff (narrow pointers). */
export function designArtifactRels(taskText: string, tid: string): {
  out: string;
  specRel: string;
  adrRel: string;
  findingsRel: string;
} {
  const out = outDirFromTask(taskText);
  return {
    out,
    specRel: `${out}/${tid}-spec.md`,
    adrRel: `${out}/${tid}-adr.md`,
    findingsRel: `.workflow/ledger/${tid}-findings.md`,
  };
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

function countGateBounces(events: StageJournalEvent[]): number {
  return events.filter((e) => e.type === "design-gate" && e.verdict === "BOUNCE").length;
}

function hasCriticRecord(events: StageJournalEvent[]): boolean {
  return events.some((e) => e.type === "design-critic");
}

const factory: CustomToolFactory = (pi) => {
  return {
    name: "design_session",
    label: "Design session (in-session judge)",
    loadMode: "essential",
    description:
      "In-session design driver (B2a default). Steps: begin | gate | critic-record | lock. " +
      "Calls B1 judge + gateLint only — lead spawns producer/critic as native agents. " +
      "Never spawns models. After lock → use gated_commit.",
    parameters: pi.zod.object({
      step: pi.zod.enum(STEPS).describe("begin | gate | critic-record | lock"),
      task: pi.zod.string().describe("path to locked design task-file"),
      findings: pi.zod
        .string()
        .optional()
        .describe("findings path for critic-record (default .workflow/ledger/<tid>-findings.md)"),
    }),
    async execute(_id, params) {
      const step = params.step as Step;
      const taskPath = path.resolve(pi.cwd, params.task);
      if (!fs.existsSync(taskPath)) return err("task-file не найден: " + params.task);
      const taskText = fs.readFileSync(taskPath, "utf8");
      const tid = scalarField(taskText, "id") || path.basename(taskPath, ".md");
      const stage = (scalarField(taskText, "stage") || "").toLowerCase();
      if (!stage.startsWith("design")) {
        return err(
          `MISROUTE: design_session на не-design задаче (stage=${stage || "<none>"}). ` +
            `Только stage:design*.`,
        );
      }
      const taskRel = path.relative(pi.cwd, taskPath).split(path.sep).join("/");
      const deps = prodDeps(pi.cwd);
      const arts = designArtifactRels(taskText, tid);
      const ck12 = contractKey12(taskText);

      if (step === "begin") {
        const r = runJudgeCli(["design-begin", "--task", taskRel], deps);
        if (r.exitCode !== 0) return judgeToTool(r);
        const handoff =
          `=== DESIGN SESSION begin: ${tid} (ck12=${ck12}) ===\n` +
          `${r.stdout}\n\n` +
          `Producer handoff (spawn native producer; Write only these):\n` +
          `  task: ${taskRel}\n` +
          `  spec → ${arts.specRel}\n` +
          `  ADR  → ${arts.adrRel}\n` +
          `Next: after producer writes artifacts → design_session(step=gate, task=...).`;
        return ok(handoff);
      }

      if (step === "gate") {
        const specPath = path.resolve(pi.cwd, arts.specRel);
        const adrPath = path.resolve(pi.cwd, arts.adrRel);
        if (!fs.existsSync(specPath) || !fs.existsSync(adrPath)) {
          return err(
            `gate: нет артефактов producer'а (${arts.specRel}, ${arts.adrRel}). ` +
              `Сначала spawn producer.`,
          );
        }
        const eventsBefore = readJournal(pi.cwd, ck12, "design");
        const priorBounces = countGateBounces(eventsBefore);
        const g = gateLint(taskPath, specPath, adrPath, pi.cwd);
        const verdict = g.findings.length ? "BOUNCE" : "PASS";
        const summary =
          `SP:${g.nSp} AD:${g.nAd} FR:${g.nFr} findings:${g.findings.length}\n` +
          g.findings.map((f) => "  [x] " + f).join("\n");
        const r = runJudgeCli(
          ["design-gate-record", "--task", taskRel, "--verdict", verdict],
          deps,
        );
        if (r.exitCode !== 0) return judgeToTool(r, summary);

        if (verdict === "PASS") {
          return ok(
            `${r.stdout}\n` +
              `gateLint PASS\n${summary}\n` +
              `Next: spawn native critic → write findings → ` +
              `design_session(step=critic-record, task=..., findings=${arts.findingsRel}).`,
          );
        }

        // BOUNCE: budget 1 retry (attempt1 fail → retry → attempt2 fail = exhausted)
        if (priorBounces >= 1) {
          return err(
            `${r.stdout}\n` +
              `gateLint BOUNCE — bounce budget exhausted (1 retry used).\n${summary}\n` +
              `Design blocked. Fix artifacts manually or re-begin after contract change.`,
          );
        }
        return ok(
          `${r.stdout}\n` +
            `gateLint BOUNCE (retry 1 allowed).\n${summary}\n` +
            `Next: re-spawn producer with findings above → design_session(step=gate, ...) again.`,
        );
      }

      if (step === "critic-record") {
        const findingsRel = params.findings || arts.findingsRel;
        const findingsPath = path.resolve(pi.cwd, findingsRel);
        if (!fs.existsSync(findingsPath)) {
          return err(`critic-record: findings не найдены: ${findingsRel}`);
        }
        const events = readJournal(pi.cwd, ck12, "design");
        if (hasCriticRecord(events)) {
          return err(
            `critic-record budget=1: design-critic already recorded for ck12=${ck12}. ` +
              `Second critic pass denied.`,
          );
        }
        const findingsArg = path.relative(pi.cwd, findingsPath).split(path.sep).join("/");
        const r = runJudgeCli(
          ["design-critic-record", "--task", taskRel, "--findings", findingsArg],
          deps,
        );
        if (r.exitCode !== 0) return judgeToTool(r);
        return ok(
          `${r.stdout}\n` +
            `Next: if no blocking findings → design_session(step=lock, task=...).`,
        );
      }

      if (step === "lock") {
        const r = runJudgeCli(["design-lock", "--task", taskRel], deps);
        if (r.exitCode !== 0) return judgeToTool(r);
        return ok(
          `${r.stdout}\n` +
            `DESIGN LOCKED. Commit via gated_commit(message=..., task=${taskRel}) — ` +
            `do not raw-git-commit.`,
        );
      }

      return err(`unknown step: ${step}`);
    },
  };
};

export default factory;
