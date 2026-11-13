#!/usr/bin/env node
// aiwf — single Node CLI entry for setup | install | uninstall | head
import { resolveMode, ModeError, type Mode } from "./install/mode.ts";
import { FlowError, expandFlow, LIVE_FLAVORS } from "./install/matrix.ts";
import {
  runSetup,
  runInstallFlavor,
  runUninstallFlavor,
  runHeadCmd,
} from "./install/setup.ts";
import type { FlavorId } from "./install/registry.ts";

const USAGE = `usage: aiwf.ts <setup|install|uninstall|head> [options]

subcommands:
  setup                 interactive/automated install (modes: full|key|soft|yolo)
  install <flavor|all>  install selected flavors
  uninstall <flavor|all>  remove managed flavor trees + vendored core (never shared head)
  head [ensure|resolve] shared-head ensure / resolve

common:
  --mode <full|key|soft|yolo>   mutually exclusive mode (also -y/--yes => yolo)
  --flow <omp|opencode|cursor|dsh|all>
  --target <dir>                project-scoped install root
  --keep-agents                 never overwrite existing agents/*.md
  --skip-smoke                  skip omp load-smoke after setup
  --check                       dry-run / report only where supported
  -h, --help                    print this usage

live flavors: ${LIVE_FLAVORS.join(", ")}
rejected flows: claude, codex, both
`;

function printUsage(): void {
  console.log(USAGE.trimEnd());
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) return argv[i + 1];
  return undefined;
}

function parseFlavors(token: string | undefined): FlavorId[] {
  return expandFlow(token || "all");
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    printUsage();
    return cmd ? 0 : 2;
  }

  const rest = argv.slice(1);
  const isTTY = Boolean(process.stdin.isTTY);
  let mode: Mode;
  try {
    mode = resolveMode(rest, isTTY);
  } catch (e) {
    if (e instanceof ModeError) {
      console.error(e.message);
      return e.exitCode;
    }
    throw e;
  }
  const check = rest.includes("--check");
  const keepAgents = rest.includes("--keep-agents");
  const target = argValue(rest, "--target");
  const skipSmoke = rest.includes("--skip-smoke");

  try {
    switch (cmd) {
      case "setup":
        return await runSetup({
          mode,
          check,
          argv: rest,
          flow: argValue(rest, "--flow") || "all",
          keepAgents,
          target,
          skipSmoke,
        });
      case "install": {
        const flavors = parseFlavors(rest[0] && !rest[0].startsWith("-") ? rest[0] : argValue(rest, "--flow"));
        let code = 0;
        for (const id of flavors) {
          const c = await runInstallFlavor(id, { check, target, keepAgents, argv: rest });
          if (c !== 0) code = c;
        }
        return code;
      }
      case "uninstall": {
        const flavors = parseFlavors(rest[0] && !rest[0].startsWith("-") ? rest[0] : argValue(rest, "--flow"));
        let code = 0;
        for (const id of flavors) {
          const c = await runUninstallFlavor(id, { check, target });
          if (c !== 0) code = c;
        }
        return code;
      }
      case "head":
        return await runHeadCmd(rest);
      default:
        printUsage();
        console.error(`unknown subcommand: ${cmd}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof FlowError) {
      console.error(e.message);
      return e.exitCode;
    }
    if (e instanceof ModeError) {
      console.error(e.message);
      return e.exitCode;
    }
    throw e;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
