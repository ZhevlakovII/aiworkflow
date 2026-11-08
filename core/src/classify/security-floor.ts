/**
 * Security floor — always-on deny patterns, independent of profile/rail/zone.
 *
 * T7-6 (contract L-4): `tools/policy/intent.py`/`guard-rules.yml` below are a
 * HISTORICAL source — both deleted in T7; this file is the source of truth
 * now (see `./rules.ts` header for the full note).
 *
 * Ported from `tools/policy/intent.py` `_security_patterns` (compiled from
 * `guard-rules.yml` `security_deny`). MUST run FIRST in classify.ts, ahead
 * of git/zone (contract L-2, security-floor-first invariant).
 */
import { SECURITY_DENY } from "./rules.ts";

interface CompiledRule {
  re: RegExp;
  message: string;
}

const COMPILED: readonly CompiledRule[] = SECURITY_DENY.map((rule) => ({
  re: new RegExp(rule.pattern),
  message: rule.message,
}));

/**
 * Returns the deny reason if `cmd` matches any security-floor pattern, else
 * `null`.
 *
 * Fail-safe note (contract L-2): pattern matching here is pure regex.test
 * against a string — it does not throw for any string input. Callers (see
 * classify.ts) must treat an unexpected upstream error as deny, never as a
 * silent allow — this function itself has no fallible I/O to fail on.
 */
export function matchSecurityFloor(cmd: string): string | null {
  for (const { re, message } of COMPILED) {
    if (re.test(cmd)) return message;
  }
  return null;
}
