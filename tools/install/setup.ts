// setup — orchestrate mode → prereqs → matrix → head/roles → flavors.
import * as path from "node:path";
import type { Mode } from "./mode.ts";
import { FlowError, expandFlow, softSkip, LIVE_FLAVORS } from "./matrix.ts";
import { probePrereqs, missingHard, presentHarnessSet } from "./prereqs.ts";
import { askMultiSelect, askSelect, askYesNo, askText } from "./prompts.ts";
import { getFlavorSpec, type FlavorId } from "./registry.ts";
import {
  defaultRepoRoot,
  headExists,
  runCmd,
  runNodeScript,
  sharedHeadDir,
  toolsDir,
} from "./common.ts";
import * as omp from "./flavors/omp.ts";
import * as opencode from "./flavors/opencode.ts";
import * as cursor from "./flavors/cursor.ts";
import * as dsh from "./flavors/dsh.ts";

export type SetupOptions = {
  mode: Mode;
  check?: boolean;
  argv?: string[];
  /** Flow token; default `all` → four live flavors. */
  flow?: string;
  keepAgents?: boolean;
  target?: string;
  skipSmoke?: boolean;
};

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) return argv[i + 1];
  return undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

const INSTALLERS: Record<
  FlavorId,
  { install: typeof omp.installFlavor; uninstall: typeof omp.uninstallFlavor }
> = {
  omp: { install: omp.installFlavor, uninstall: omp.uninstallFlavor },
  opencode: { install: opencode.installFlavor, uninstall: opencode.uninstallFlavor },
  cursor: { install: cursor.installFlavor, uninstall: cursor.uninstallFlavor },
  dsh: { install: dsh.installFlavor, uninstall: dsh.uninstallFlavor },
};

async function resolveSelectedFlavors(
  mode: Mode,
  argv: string[],
  flowDefault: string,
): Promise<FlavorId[]> {
  const flowFlag = argValue(argv, "--flow") || flowDefault;
  if (mode === "full" || mode === "key") {
    const picked = await askMultiSelect(
      "Select flavors to install:",
      LIVE_FLAVORS,
      expandFlow(flowFlag),
    );
    return picked;
  }
  return expandFlow(flowFlag);
}

async function resolveTarget(mode: Mode, argv: string[]): Promise<string | undefined> {
  const t = argValue(argv, "--target") || argValue(argv, "-Target") || "";
  if (t) return t;
  if (mode === "full" || mode === "key") {
    const scope = await askSelect(
      "Install scope:",
      ["global", "project"] as const,
      "global",
    );
    if (scope === "project") {
      const dir = await askText("Project directory", process.cwd());
      return dir || process.cwd();
    }
  }
  return undefined;
}

function runHead(repoRoot: string, check: boolean, soft: boolean): number {
  if (soft && headExists()) {
    console.log(`[soft] shared head present at ${sharedHeadDir()} — leave models.yml/modelRoles untouched`);
    return 0;
  }
  const headCli = path.join(repoRoot, "tools", "aiwf_head_cli.ts");
  const templates = path.join(repoRoot, "tools", "templates");
  const args = ["ensure", "--templates", templates];
  if (check) args.push("--check");
  return runNodeScript(headCli, args);
}

function runRoles(repoRoot: string, mode: Mode, check: boolean): number {
  if (mode === "soft" && headExists()) {
    console.log("[soft] skip setup_roles (head present; no force sync)");
    return 0;
  }
  const rolesTool = path.join(repoRoot, "tools", "setup_roles.ts");
  if (check) return runNodeScript(rolesTool, ["--check"]);
  if (mode === "yolo" || mode === "key" || mode === "soft") {
    return runNodeScript(rolesTool, ["--defaults"]);
  }
  return runNodeScript(rolesTool, []);
}

/**
 * Run setup pipeline.
 */
export async function runSetup(opts: SetupOptions): Promise<number> {
  const argv = opts.argv ?? [];
  const check = Boolean(opts.check || has(argv, "--check"));
  const skipSmoke = Boolean(opts.skipSmoke || has(argv, "--skip-smoke"));
  const keepAgents = Boolean(opts.keepAgents || has(argv, "--keep-agents"));
  const repoRoot = defaultRepoRoot();
  const mode = opts.mode;

  console.log("=== AI Workflow setup ===");
  console.log(`mode: ${mode}${check ? " (check)" : ""}`);

  let selected: FlavorId[];
  try {
    selected = await resolveSelectedFlavors(mode, argv, opts.flow || "all");
  } catch (e) {
    if (e instanceof FlowError) {
      console.error(e.message);
      return e.exitCode;
    }
    throw e;
  }

  const target = opts.target ?? (await resolveTarget(mode, argv));

  const probes = await probePrereqs();
  console.log("--- prereqs ---");
  for (const p of probes) {
    const tag = p.present ? "[ok]" : p.kind === "hard" ? "[MISSING]" : "[absent]";
    console.log(`  ${tag} ${p.id}`);
  }

  const hardMiss = missingHard(probes);
  if (hardMiss.length > 0 && !check) {
    console.error(`ABORT: missing required prereqs: ${hardMiss.join(", ")}`);
    return 1;
  }

  const present = presentHarnessSet(probes);
  const skip = softSkip(selected, present);
  for (const id of skip.skipped) {
    console.log(`[skip] ${id} CLI absent — flavor not installed`);
  }
  if (skip.abort) {
    if (check) {
      console.log(`[check] would abort: ${skip.reason}`);
    } else {
      console.error(`ABORT: ${skip.reason}`);
      return 1;
    }
  }
  if (skip.installable.length === 0) {
    console.log("[warn] nothing installable after soft-skip");
  }

  const needHead = skip.installable.some((id) => id === "omp" || id === "opencode" || id === "dsh");
  if (needHead) {
    console.log("--- shared-head ---");
    const hc = runHead(repoRoot, check, mode === "soft");
    if (hc !== 0) return hc;
    console.log("--- modelRoles ---");
    const rc = runRoles(repoRoot, mode, check);
    if (rc !== 0) return rc;
  }

  for (const id of skip.installable) {
    console.log(`--- install ${id} ---`);
    const spec = getFlavorSpec(id);
    const code = await INSTALLERS[id].install({
      spec,
      repoRoot,
      check,
      keepAgents,
      target,
    });
    if (code !== 0) {
      console.error(`${id} install failed (exit ${code})`);
      return code;
    }
  }

  if (!check && !skipSmoke && skip.installable.includes("omp") && present.has("omp")) {
    console.log("--- load-smoke (omp -p) ---");
    const r = runCmd("omp", ["-p", "Reply exactly: LOADED", "--yolo"]);
    if (r.status === 0) console.log("  [ok] omp smoke exit 0");
    else console.log(`  [warn] omp smoke exit ${r.status}`);
  }

  if (mode === "full" && !check) {
    // optional confirm already done via prompts; no extra gate
    void askYesNo;
  }

  console.log(check ? "CHECK done (nothing written)." : `SETUP done (flavors: ${skip.installable.join(",") || "none"}).`);
  // check: exit 0 when would-succeed (hard prereqs present OR only reporting; abort already handled)
  if (check && hardMiss.length > 0) {
    console.error(`[check] would abort: missing hard prereqs ${hardMiss.join(", ")}`);
    return 1;
  }
  return 0;
}

export async function runInstallFlavor(
  id: FlavorId,
  opts: { check?: boolean; target?: string; keepAgents?: boolean; argv?: string[] },
): Promise<number> {
  const repoRoot = defaultRepoRoot();
  const spec = getFlavorSpec(id);
  return INSTALLERS[id].install({
    spec,
    repoRoot,
    check: opts.check,
    target: opts.target,
    keepAgents: opts.keepAgents,
  });
}

export async function runUninstallFlavor(
  id: FlavorId,
  opts: { check?: boolean; target?: string },
): Promise<number> {
  const repoRoot = defaultRepoRoot();
  const spec = getFlavorSpec(id);
  console.log(`[uninstall] ${id} — managed trees only; shared head ${sharedHeadDir()} never touched`);
  return INSTALLERS[id].uninstall({
    spec,
    repoRoot,
    check: opts.check,
    target: opts.target,
  });
}

export async function runHeadCmd(argv: string[]): Promise<number> {
  const repoRoot = defaultRepoRoot();
  const headCli = path.join(repoRoot, "tools", "aiwf_head_cli.ts");
  const rest = argv[0] === "ensure" || argv[0] === "resolve" ? argv : ["ensure", ...argv];
  return runNodeScript(headCli, rest);
}

void toolsDir;
void LIVE_FLAVORS;
