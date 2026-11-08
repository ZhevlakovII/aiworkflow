// zone-guard — OpenCode plugin (порт OMP hooks/pre/zone-guard.ts + CC .claude/hooks/zone-guard.py).
// Enforcement-слой: детерминированный рельс, держит независимо от режима/модели.
// Хук `tool.execute.before` (deny = throw) блокирует:
//   0. PATH-TOOL BRIDGE: write/edit/patch/notebook → opencodeGuardDecision (SWP +
//      execute lead-freeze via prodHookDeps). Casing normalized in opencode-adapter.
//   0b. BASH BRIDGE: bash → opencodeGuardDecision(tool Bash + command) FIRST
//      (core SWP/freeze deny wins); then harness-local regex belts.
//   1. PROTECTED: write/edit/patch в .git/.omp/.opencode — belt after core allow
//      (OC protected includes `.opencode`; operator_zone / SWP may not cover it).
//   2. RAW-GIT: git-мутации через bash-тул → стир к нативным рельсам gated_commit/push/merge.
//   3. SECURITY: pipe-to-shell, nc/ssh, rm -rf, shell-запись под protected.
// Bash/git regex remain harness-local after core (full classify rebind parked).
// НЕ трогает рельсы: .opencode/tools/gated_*.ts зовут git через Bun `$` (lib/exec), НЕ через bash-тул →
//   этот хук их не видит (аналог pi.exec в OMP).
// ГЭП (осознанно, как в CC-порте): lead-delegation-guard не портирован (opencode не отдаёт lead/worker-маркер
//   в tool.execute.before). Enforcement делегирования — на КОММИТЕ (gated_commit zone-check staged).
import type { Plugin } from "@opencode-ai/plugin";
import { prodHookDeps } from "../../../core/src/shim/command-hook.ts";
import { opencodeGuardDecision } from "../../../core/src/shim/opencode-adapter.ts";
import { recordGuard } from "../lib/telemetry";

const WRITE_TOOLS = new Set(["write", "edit", "patch", "notebook"]);
const PROTECTED = /(^|[\\/])\.(git|omp|opencode)([\\/]|$)/i;
const PROTECTED_IN_CMD = /\.(git|omp|opencode)[\\/]/i;
// git-мутации (первое слово подкоманды). READ-подкоманды (status/diff/log/...) НЕ здесь → разрешены.
const GIT_MUT = /\bgit\s+(commit|add|push|merge|reset|checkout|restore|clean|stash|rm|apply|cherry-pick|rebase|tag)\b/i;
const RAIL: Record<string, string> = {
  commit: "gated_commit(message, task?)",
  push: "gated_push(pr?, base?)",
  merge: "gated_merge(branch, base?, class?)",
};
const PIPE_SHELL = /\|\s*(sh|bash)\b/;
const NC_SSH = /(^|[;&|]\s*)(nc|ssh)\s/;
const RM_RF = /\brm\s+(-\w*r\w*f|-\w*f\w*r|-rf|-fr)\b/;
const BASH_WRITE_PROTECTED = /(>>?|tee\s+|\brm\s+|\bmv\s+|\bcp\s+)[^\n]*\.(git|omp|opencode)\b/;

function coreGuardEvent(reason: string): string {
  if (/lead freeze/i.test(reason)) return "lead-freeze";
  if (/session_write_protected/i.test(reason)) return "session-write-protected";
  return "zone-guard-core";
}

export const ZoneGuard: Plugin = async ({ directory }) => {
  const cwd = directory ?? process.cwd();
  const deps = prodHookDeps(cwd);
  return {
    "tool.execute.before": async (input: { tool: string }, output: { args?: Record<string, unknown> }) => {
      const name = input.tool;
      const args = (output?.args ?? {}) as Record<string, unknown>;

      // 0+1. write/edit-тулы → core SWP/lead-freeze, then PROTECTED belt
      if (WRITE_TOOLS.has(name)) {
        const p = String(args.filePath ?? args.path ?? args.notebookPath ?? "");
        const coreDeny = opencodeGuardDecision(
          { tool: name, args, directory: cwd },
          deps,
        );
        if (coreDeny) {
          recordGuard(cwd, {
            event: coreGuardEvent(coreDeny.reason),
            tool: "zone-guard",
            detail: `${name} → ${p}`,
          });
          throw new Error(coreDeny.reason);
        }
        const strs = [p, ...Object.values(args)].filter((v): v is string => typeof v === "string");
        if (strs.some((v) => PROTECTED.test(v))) {
          recordGuard(cwd, { event: "protected-write", tool: "zone-guard", detail: `${name} → ${p}` });
          throw new Error(
            "zone-guard: запись в protected-путь (.git/.omp/.opencode) запрещена. " +
              "Код/контент — через worker в его allow-зоне; ledger lead'а — в .workflow/.",
          );
        }
        return;
      }

      // 0b+2+3. bash — core SWP/freeze first, then harness-local regex
      if (name === "bash") {
        const cmd = String(args.command ?? "");
        const coreDeny = opencodeGuardDecision(
          { tool: name, args, directory: cwd },
          deps,
        );
        if (coreDeny) {
          recordGuard(cwd, {
            event: coreGuardEvent(coreDeny.reason),
            tool: "zone-guard",
            detail: cmd.slice(0, 200),
          });
          throw new Error(coreDeny.reason);
        }
        if (PIPE_SHELL.test(cmd)) {
          recordGuard(cwd, { event: "raw-git-deny", tool: "zone-guard", detail: cmd.slice(0, 200) });
          throw new Error("zone-guard: pipe-to-shell (download→exec) запрещён.");
        }
        if (NC_SSH.test(cmd)) throw new Error("zone-guard: nc/ssh запрещены (exfil/reverse-shell surface).");
        if (RM_RF.test(cmd)) throw new Error("zone-guard: `rm -rf` запрещён.");
        if (PROTECTED_IN_CMD.test(cmd) && BASH_WRITE_PROTECTED.test(cmd)) {
          recordGuard(cwd, { event: "protected-write", tool: "zone-guard", detail: cmd.slice(0, 200) });
          throw new Error("zone-guard: shell-запись/удаление под .git/.omp/.opencode запрещена.");
        }
        const m = GIT_MUT.exec(cmd);
        if (m) {
          const sub = m[1].toLowerCase();
          const rail = RAIL[sub];
          recordGuard(cwd, { event: "raw-git-deny", tool: "zone-guard", detail: cmd.slice(0, 200) });
          throw new Error(
            rail
              ? `commit-rail: raw \`git ${sub}\` заблокирован — коммить/пушь/мёржи ТОЛЬКО нативным тулом ${rail}. ` +
                "Рельс делает zone-check staged + test-cmd/probe (детерминир. enforcement на чокпоинте)."
              : `zone-guard: raw git-мутация \`git ${sub}\` запрещена (рельсы держат дерево чистым; ` +
                "используй gated_commit/push/merge или читай состояние).",
          );
        }
        return;
      }
    },
  };
};
