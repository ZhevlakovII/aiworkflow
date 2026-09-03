// gated_commit — L1 commit-рельс как НАТИВНЫЙ OMP-тул (Phase-1 интеграция).
// Логика зоны портирована в TS (_lib), git — через pi.exec. Raw `git commit` блочит zone-guard хук →
// модель обязана звать этот тул. Тул execs git напрямую (не через bash-тул → хук/patterns не мешают).
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { zoneCheck } from "./_lib/zonecheck";
import { parseZone } from "./_lib/task";
import { ok, err } from "./_lib/result";

const factory: CustomToolFactory = (pi) => {
  const git = (args: string[]) => pi.exec("git", args, { cwd: pi.cwd });
  return {
    name: "gated_commit",
    label: "Gated commit",
    loadMode: "essential",
    description:
      "Единственный разрешённый путь к коммиту (raw `git commit` заблокирован). Стейджит, " +
      "проверяет staged-изменения против зоны task-file (allow/deny) и test-cmd, коммитит только на зелёном.",
    parameters: pi.zod.object({
      message: pi.zod.string().describe("commit message"),
      task: pi.zod
        .string()
        .optional()
        .describe("путь к task-file — из него берётся зона (allow/deny/test-cmd). Без него зона не проверяется (gate-optional)."),
    }),
    async execute(_id, params, _u, _ctx, _sig) {
      if ((await git(["rev-parse", "--git-dir"])).code !== 0) return err("не git-репо");

      const add = await git(["add", "-A"]);
      if (add.code !== 0) return err("git add failed: " + add.stderr);

      let allow: string[] = [];
      let deny: string[] = [];
      let testCmd: string | undefined;
      let gateOptional = false;
      if (params.task) {
        const tp = path.resolve(pi.cwd, params.task);
        if (!fs.existsSync(tp)) {
          await git(["reset", "-q"]);
          return err("task-file не найден: " + params.task);
        }
        const z = parseZone(fs.readFileSync(tp, "utf8"));
        allow = z.allow;
        deny = z.deny;
        testCmd = z.testCmd;
        gateOptional = z.gateOptional;
      }

      // zone-check (если зона задана)
      if (allow.length) {
        const staged = (await git(["diff", "--cached", "--name-only"])).stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const v = zoneCheck(staged, allow, deny);
        if (v.length) {
          await git(["reset", "-q"]);
          return err("ZONE VIOLATION — коммит отменён (staged сброшен):\n" + v.map((x) => "  [x] " + x).join("\n"));
        }
      }

      // test-cmd (корректностный гейт)
      if (testCmd) {
        const tr = await pi.exec("sh", ["-c", testCmd], { cwd: pi.cwd });
        if (tr.code !== 0) {
          await git(["reset", "-q"]);
          return err(`GATE RED (test-cmd exit ${tr.code}) — коммит отменён:\n${tr.stdout}\n${tr.stderr}`);
        }
      } else if (!gateOptional && allow.length) {
        // зона энфорсится, но корректностной проверки нет — предупреждаем в выводе
      }

      // Трейлер [omp-rail:*] — единая rail-подпись для bypass-аудита (tools/audit_commits.py):
      // коммит БЕЗ неё = потенциальный обход рельса.
      const c = await git(["commit", "-m", params.message, "-m", "[omp-rail:gated_commit]"]);
      if (c.code !== 0) return err("git commit failed: " + c.stderr);
      const gateNote = testCmd ? "gate green (zone+test)" : allow.length ? "zone green (нет test-cmd)" : "gate-optional";
      return ok(`COMMITTED (${gateNote})\n${c.stdout}`);
    },
  };
};

export default factory;
