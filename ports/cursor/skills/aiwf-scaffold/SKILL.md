---
name: aiwf-scaffold
description: Scaffold stage — legacy + scaffold lever only; new work uses aiwf-roadmap
---

**Retired from default spine.** For `generation: spec-roadmap` use skill `aiwf-roadmap` instead.

This skill remains for **legacy** `generation: sp-adr` (or absent) **with** scaffold lever on only.

1. Read task-file (`allow`, DoD). Task id = basename without `.md`. Refuse if generation is `spec-roadmap`.
2. Judge begin:
   ```
   node "<clone>/core/src/stage/judge-cli.ts" scaffold-begin --task <task-file>
   ```
3. Write `.workflow/active-zone.json` `{"task":"<id>","allow":[...],"by":"judge"}` (UTF-8, no BOM).
4. Spawn subagent `scaffolder` (fixed; no zonemap domain resolve) in zone; narrow return only.
5. Zone check staged vs allow (diagnostic; no judge event):
   ```
   node "<clone>/core/src/zone/zone-check-cli.ts" --allow "<csv>" [--deny "<csv>"] --staged
   ```
6. Judge done (`ok` if zone clean, else `violation`):
   ```
   node "<clone>/core/src/stage/judge-cli.ts" scaffold-done --task <task-file> --outcome ok|violation
   ```
7. Commit via rail (no `--gate` while zone active):
   ```
   node "<clone>/core/src/rails/cli.ts" commit -m "<msg>"
   ```
8. Delete `.workflow/active-zone.json`. Report files / zone / gate / commit.
