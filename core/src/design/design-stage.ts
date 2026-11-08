/**
 * design-stage (T7-4) — TS port of `tools/design_stage.py`: the deterministic
 * design-stage driver (P5, autonomous flow). Thesis: design orchestration must
 * NOT be left to model judgement — enforcement > instruction. Sequence in code:
 * producer -> gate_lint -> (1 bounce-retry) -> [opt-in critic] -> ledger -> commit.
 *
 * Flow:
 *   1. gate_setup  -> `.workflow/gate.cmd` (zone-check из зоны task-file)
 *   2. producer    -> spec + ADR (valid source-ref)
 *   3. gate_lint   -> PASS | BOUNCE; on BOUNCE — 1 producer-retry with findings
 *   4. critic      -> ONLY when opted-in (task frontmatter / `--critic` / options.critic);
 *                    default OFF for all classes (AD-critic-default-off-opt-in).
 *                    When on: one semantic pass; lock iff 0 blocker/major.
 *   5. ledger      -> gate verdict + critic findings|skipped + status
 *   6. locked (gate PASS; + no blocker/major when critic ran) -> commit; else exit 1
 *
 * Exit: 0 = design locked+committed; 1 = bounced/blocked (nothing committed);
 * 2 = driver error (matches Python's argv exit-code contract).
 *
 * Internal TS-to-TS calls are now IN-PROCESS (contract L-3 — this is the key
 * behavioural delta vs the Python original, which subprocessed even its own
 * already-ported `gate-lint-cli.ts` — see that module's history): `gate_setup`
 * -> `./gate-setup.ts`'s `buildGateSetup`, `gate_lint` -> `./gate-lint.ts`'s
 * `gateLint`. Only genuinely external processes stay behind an injectable
 * seam: the strong-model worker (`./claude-worker.ts`'s `ClaudeSeam`) and git
 * (`../rails/git-seam.ts`'s `GitSeam`, used by `../rails/commit.ts`'s
 * `gatedCommit` for the final commit step — contract L-3's "выбрать и
 * обосновать": IN-PROCESS `gatedCommit` was chosen over shelling out to
 * `node core/src/rails/cli.ts commit --gate "<gate.cmd>"` because the
 * generated gate.cmd line is itself a multi-command shell string containing
 * `&&` and nested quotes — passing it as a single extra subprocess-hop CLI
 * arg adds Windows-shell-quoting risk for no benefit; calling `gatedCommit`
 * directly gives the same GitSeam/ResolvedPolicy injection this whole module
 * already uses, so the full flow — including the commit step — is testable
 * with a real tmp-repo `GitSeam`, no subprocess spawned anywhere in tests).
 */
import * as path from "node:path";

import { buildGateSetup } from "./gate-setup.ts";
import { gateLint } from "./gate-lint.ts";
import { runClaudeWorker, type ClaudeSeam } from "./claude-worker.ts";
import { resolveCriticOptIn } from "./critic-opt-in.ts";
import { gatedCommit } from "../rails/commit.ts";
import type { GitSeam } from "../rails/git-seam.ts";
import type { ResolvedPolicy } from "../policy/policy.ts";
import { splitMaxsplit } from "./py-text.ts";

// ---------------------------------------------------------------------------
// parse_task (verbatim Python `parse_task`)
// ---------------------------------------------------------------------------

export interface ParsedTask {
  id: string;
  stage: string;
  klass: string;
  model: string;
  outDir: string;
  /** True when frontmatter has critic-opt-in / critic truthy (AD-critic-default-off-opt-in). */
  criticOptIn: boolean;
}

/** Python `parse_task`'s frontmatter extraction: `text.split("---", 2)[1] if text.startswith("---") else text`. */
function taskFrontmatterOrWhole(text: string): string {
  if (!text.startsWith("---")) return text;
  const parts = splitMaxsplit(text, "---", 2);
  return parts[1] as string; // guaranteed >=2 parts once text starts with the separator
}

function scalarWithComment(fm: string, key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(fm);
  if (!m) return "";
  return (m[1] as string).replace(/\s+#\s.*$/, "").trim();
}

/** task-file text + filename-stem -> `{id, stage, class, model, out_dir, criticOptIn}`. */
export function parseTask(taskText: string, taskStem: string): ParsedTask {
  const fm = taskFrontmatterOrWhole(taskText);
  const id = scalarWithComment(fm, "id") || taskStem;
  const stage = scalarWithComment(fm, "stage");
  const klass = scalarWithComment(fm, "class");
  const model = scalarWithComment(fm, "design-model");
  const criticOptIn = resolveCriticOptIn(taskText);

  const m = /allow:\s*\[([^\]]*)\]/.exec(fm);
  let allow0 = "";
  if (m) {
    const items: string[] = [];
    const re = /["']([^"']+)["']/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(m[1] as string)) !== null) items.push(mm[1] as string);
    allow0 = items[0] ?? "";
  }
  const outDir = allow0.replace(/\/\*\*/g, "").replace(/\/\*/g, "").trim() || "docs/design";
  return { id, stage, klass, model, outDir, criticOptIn };
}

// ---------------------------------------------------------------------------
// critic_severity (verbatim Python `critic_severity`)
// ---------------------------------------------------------------------------

export function criticSeverity(
  exists: (p: string) => boolean,
  readFile: (p: string) => string,
  findingsPath: string,
): { blocking: string[]; other: string[] } {
  if (!exists(findingsPath)) return { blocking: ["критик не создал findings-файл"], other: [] };
  const blocking: string[] = [];
  const other: string[] = [];
  for (const raw of readFile(findingsPath).split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    const low = s.toLowerCase();
    if (low.startsWith("[none]")) continue;
    if (low.startsWith("[blocker]") || low.startsWith("[major]")) blocking.push(s);
    else if (low.startsWith("[minor]")) other.push(s);
  }
  return { blocking, other };
}

// ---------------------------------------------------------------------------
// write_ledger (Python `write_ledger`, WITH a deliberate deviation from
// Python: the original hardcodes the literal `date: 2026-08-26` — an
// authoring leftover, not a real "current date" — in every ledger it writes.
// Lead decision: fix, don't preserve. `date` is now the real current date
// (`YYYY-MM-DD`), sourced from an injectable `DesignStageDeps.now()` clock
// seam (contract L-2 pattern: external/nondeterministic inputs go through an
// injectable seam, same as `ClaudeSeam`/`GitSeam`) — tests inject a fixed
// clock and stay fully deterministic.
// ---------------------------------------------------------------------------

function writeLedgerText(
  id: string,
  model: string,
  date: string,
  gateVerdict: string,
  gateOut: string,
  blocking: string[],
  other: string[],
  status: string,
  criticSkipped: boolean,
): string {
  const lines: string[] = [
    "---", `id: ${id}`, "stage: design", `status: ${status}`,
    `model: ${model}`, `date: ${date}`, "---", "",
    "## Design ledger (deterministic driver)", "",
    `**Contract:** \`.workflow/tasks/${id}.md\` (locked, INV-1)`, "",
    "### Gate-1/2 (gate_lint.py — механический)",
    `Вердикт: **${gateVerdict}**`, "```", gateOut.trim(), "```", "",
    "### Critic (свежий контекст, сильная модель — семантика)",
  ];
  if (criticSkipped) {
    lines.push("critic=skipped (default off; no opt-in)");
  } else {
    if (blocking.length) {
      lines.push("**Blocking (blocker/major):**");
      for (const b of blocking) lines.push(`- ${b}`);
    }
    if (other.length) {
      lines.push("**Non-blocking (minor):**");
      for (const o of other) lines.push(`- ${o}`);
    }
    if (!blocking.length && !other.length) lines.push("clean");
  }
  lines.push("", `### Итог: **${status}**`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// runDesignStage — orchestration (verbatim Python `main`, minus argv/exit)
// ---------------------------------------------------------------------------

export interface DesignStageOptions {
  /** resolved absolute path */
  taskPath: string;
  model?: string;
  timeout: number;
  noCommit?: boolean;
  /** Explicit critic opt-in (OR'd with task frontmatter). Default off. */
  critic?: boolean;
  /** port dir holding `agents/<role>.md` (project overlay) for the producer/critic role-prompt lookup
   *  (A1, `../roles/resolve.ts`). This driver is CC-native (invoked by `/aiwf-design`), so the default
   *  is ".claude" — NOT ".omp" (the fact this task fixes: CC-only projects have no `.omp/agents/`). */
  portDir?: string;
}

export interface DesignStageDeps {
  repoRoot: string;
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  mkdirp(p: string): void;
  claude: ClaudeSeam;
  git: GitSeam;
  policy: ResolvedPolicy;
  /** Clock seam for the ledger's `date:` field (`YYYY-MM-DD`) — injectable so tests stay deterministic. */
  now(): string;
}

export interface DesignStageResult {
  /** 0 = locked+committed; 1 = bounced/blocked; 2 = driver error. */
  exitCode: number;
  stdoutLines: string[];
  stderrLines: string[];
}

function formatGateOut(g: { nSp: number; nAd: number; nFr: number; findings: string[] }): string {
  const lines = [`SP-points: ${g.nSp} | AD-decisions: ${g.nAd} | FR-points: ${g.nFr} | findings: ${g.findings.length}`];
  for (const f of g.findings) lines.push(`  [x] ${f}`);
  lines.push(g.findings.length ? "GATE: BOUNCE" : "GATE: PASS");
  return lines.join("\n");
}

export function runDesignStage(options: DesignStageOptions, deps: DesignStageDeps): DesignStageResult {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  if (!deps.exists(options.taskPath)) {
    stderrLines.push(`ERROR: task-file не найден: ${options.taskPath}`);
    return { exitCode: 2, stdoutLines, stderrLines };
  }

  const taskText = deps.readFile(options.taskPath);
  const taskStem = path.basename(options.taskPath, path.extname(options.taskPath));
  const t = parseTask(taskText, taskStem);
  const model = options.model || t.model || "sonnet";
  const portDir = options.portDir ?? ".claude";
  const tid = t.id;
  const criticOptIn = resolveCriticOptIn(taskText, options.critic);

  const out = path.join(deps.repoRoot, t.outDir);
  const spec = path.join(out, `${tid}-spec.md`);
  const adr = path.join(out, `${tid}-adr.md`);
  const findings = path.join(deps.repoRoot, ".workflow", "ledger", `${tid}-findings.md`);
  const ledger = path.join(deps.repoRoot, ".workflow", "ledger", `${tid}.md`);

  stdoutLines.push(`=== DESIGN STAGE: ${tid} (model=${model}, out=${t.outDir}/) ===`);

  // 1. gate_setup (in-process) -> .workflow/gate.cmd
  const gateSetup = buildGateSetup(taskText);
  if (gateSetup.error) {
    stderrLines.push(`ERROR: gate_setup: ${gateSetup.error}`);
    return { exitCode: 2, stdoutLines, stderrLines };
  }
  deps.mkdirp(path.join(deps.repoRoot, ".workflow"));
  deps.writeFile(path.join(deps.repoRoot, ".workflow", "gate.cmd"), gateSetup.gateCmd + "\n");

  // 2-3. producer -> gate_lint, up to 2 attempts (bounce-retry with findings)
  let gateOut = "";
  let gateVerdict: "PASS" | "BOUNCE" = "BOUNCE";
  let notes = "";
  for (const attempt of [1, 2]) {
    const pr = runClaudeWorker(
      { role: "producer", task: options.taskPath, spec, adr, model, notes, timeout: options.timeout, portDir },
      { seam: deps.claude, exists: deps.exists, readFile: deps.readFile, mkdirp: deps.mkdirp, repoRoot: deps.repoRoot },
    );
    stdoutLines.push(...pr.stdoutLines);
    stderrLines.push(...pr.stderrLines);
    if (pr.exitCode !== 0) {
      stderrLines.push(`ERROR: producer rc=${pr.exitCode}`);
      return { exitCode: pr.exitCode === 1 ? 1 : 2, stdoutLines, stderrLines };
    }

    const g = gateLint(options.taskPath, spec, adr, deps.repoRoot);
    gateOut = formatGateOut(g);
    stdoutLines.push(gateOut);

    if (g.findings.length === 0) {
      gateVerdict = "PASS";
      break;
    }
    gateVerdict = "BOUNCE";
    notes = gateOut;
    stdoutLines.push(
      `  gate_lint BOUNCE (попытка ${attempt}) → ` + (attempt === 1 ? "retry producer с findings" : "исчерпано"),
    );
  }

  // 4. critic — opt-in only (AD-critic-default-off-opt-in); skip entirely when off
  let blocking: string[] = [];
  let other: string[] = [];
  const criticSkipped = !criticOptIn;
  if (criticOptIn) {
    const cr = runClaudeWorker(
      { role: "critic", task: options.taskPath, spec, adr, findings, model, timeout: options.timeout, portDir },
      { seam: deps.claude, exists: deps.exists, readFile: deps.readFile, mkdirp: deps.mkdirp, repoRoot: deps.repoRoot },
    );
    stdoutLines.push(...cr.stdoutLines);
    stderrLines.push(...cr.stderrLines);
    if (cr.exitCode !== 0) {
      stderrLines.push(`WARN: critic rc=${cr.exitCode} (findings могут быть неполными)`);
    }
    ({ blocking, other } = criticSeverity(deps.exists, deps.readFile, findings));
  } else {
    stdoutLines.push("  critic=skipped (default off; no opt-in)");
  }

  // 5. status: locked if gate PASS; when critic ran, also require 0 blocker/major
  const locked = gateVerdict === "PASS" && blocking.length === 0;
  const status = locked ? "locked" : "blocked";
  deps.mkdirp(path.dirname(ledger));
  deps.writeFile(
    ledger,
    writeLedgerText(tid, model, deps.now(), gateVerdict, gateOut, blocking, other, status, criticSkipped),
  );
  stdoutLines.push(
    `\n--- DESIGN ${status.toUpperCase()}: gate=${gateVerdict}, blocking=${blocking.length}, minor=${other.length}` +
      (criticSkipped ? ", critic=skipped" : "") +
      " ---",
  );

  if (!locked) {
    stdoutLines.push("Design НЕ залочен → не коммичу (blocked). Артефакты+ledger на диске для ревью/итерации.");
    return { exitCode: 1, stdoutLines, stderrLines };
  }

  // 6. commit via rail (zone-check on commit = the real rail)
  if (options.noCommit) {
    stdoutLines.push("--no-commit: пропускаю коммит.");
    return { exitCode: 0, stdoutLines, stderrLines };
  }
  const commitMsg = criticSkipped
    ? `design(${tid}): spec+ADR locked (gate PASS, critic skipped)`
    : `design(${tid}): spec+ADR locked (gate PASS, critic clean)`;
  const commitResult = gatedCommit({
    git: deps.git,
    policy: deps.policy,
    message: commitMsg,
    gateCmd: gateSetup.gateCmd,
    actor: "operator",
    repoRoot: deps.repoRoot,
  });
  if (!commitResult.ok) {
    stderrLines.push(`ERROR: commit ${commitResult.status}: ${commitResult.detail ?? ""}`);
    return { exitCode: 1, stdoutLines, stderrLines };
  }
  stdoutLines.push("DESIGN STAGE: locked + committed.");
  return { exitCode: 0, stdoutLines, stderrLines };
}
