/**
 * gate-setup (T7-4) — TS port of `tools/gate_setup.py`: builds the `.workflow/
 * gate.cmd` shell line (the commit rail's quality-gate override, contract
 * L-3) from a task-file's `zone.allow`/`zone.deny`/`test-cmd`/`gate-optional`
 * YAML-frontmatter.
 *
 * Ported behaviour (contract §L-1, verbatim from `gate_setup.py`):
 *  - `zone.allow` is mandatory (empty -> error, "зона обязательна, Q4").
 *  - `.workflow/**` is auto-appended to allow (lead-state — ledger/task-file/
 *    gate.cmd — must always be committable) and stripped from deny (deny
 *    would otherwise win over the auto-allow, breaking the lead's own
 *    ledger-write commit — the exact bug this comment documents in Python).
 *  - the generated command: `node core/src/zone/zone-check-cli.ts --staged
 *    --allow "<csv>"` [+ ` --deny "<csv>"`] [+ ` && <test-cmd>`], OR (no
 *    test-cmd AND not gate-optional) a WARN echo appended instead — same
 *    three-way branch as the Python original. NOTE (T7-2 rewire, already
 *    live in `tools/gate_setup.py` at the time of this port): the generated
 *    zone-check invocation is the TS CLI (`zone-check-cli.ts`), not the
 *    retired `tools/zone_check.py`.
 *
 * Pure-core (`buildGateSetup`, frontmatter text in, gate.cmd string out) +
 * thin CLI shell (`./gate-setup-cli.ts`) — same split as every other
 * `core/src/design` module. `design-stage.ts` calls `buildGateSetup`
 * IN-PROCESS (contract L-3: internal TS-to-TS calls stay in-process, no
 * subprocess for our own TS code — only external binaries go through a
 * seam).
 *
 * (phase-b1, contract L-1): `frontmatter`/`globList`/`scalar` are no longer
 * private copies here — they live in `./task-zone.ts` (also home to
 * `parseZone`, the `.omp`/`.opencode` `_lib/task.ts` counterpart) and are
 * imported below. `buildGateSetup`'s own behaviour is unchanged.
 */
import { frontmatter, globList, scalar } from "./task-zone.ts";

export interface GateSetupResult {
  gateCmd: string;
  error?: string;
}

const AUTO_ALLOW = ".workflow/**";
const DENY_STRIP = new Set([".workflow/**", ".workflow/*", ".workflow"]);

/** Frontmatter text -> gate.cmd string (Python-parity, contract L-1). */
export function buildGateSetup(taskText: string): GateSetupResult {
  const fm = frontmatter(taskText);
  const allow = globList(fm, "allow");
  let deny = globList(fm, "deny");

  if (allow.length === 0) {
    return { gateCmd: "", error: "в task-file нет zone.allow (зона обязательна, Q4)" };
  }
  if (!allow.includes(AUTO_ALLOW)) allow.push(AUTO_ALLOW);
  deny = deny.filter((d) => !DENY_STRIP.has(d));

  const testCmd = scalar(fm, "test-cmd");
  const gateOptional = (scalar(fm, "gate-optional") ?? "false").toLowerCase() === "true";

  let zc = `node core/src/zone/zone-check-cli.ts --staged --allow "${allow.join(",")}"`;
  if (deny.length) zc += ` --deny "${deny.join(",")}"`;

  const parts = [zc];
  if (testCmd) {
    parts.push(testCmd);
  } else if (!gateOptional) {
    // Нет test-cmd и задача не gate-optional -> зона всё равно энфорсится (zc), но
    // предупреждаем, что корректностной проверки нет (Python-parity WARN echo).
    parts.push('echo "WARN: нет test-cmd; гейт = только zone_check"');
  }

  return { gateCmd: parts.join(" && ") };
}
