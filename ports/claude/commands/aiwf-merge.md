---
description: L3 автономный merge-рельс (gated_merge): capability-probe→merge→свежий gate→откат на red
argument-hint: --branch <b> [--base <b> --class feature|refactor|security|migration --findings <f>]
allowed-tools: Bash(node:*), Read
---

Автономный merge ТОЛЬКО через рельс (raw `git merge` блокирован).

```
node "$CLAUDE_PROJECT_DIR/core/src/rails/cli.ts" merge $ARGUMENTS
```

**CAPABILITY-PROBE (гейт L3):** требуемые способности класса ДОЛЖНЫ быть — иначе INSUFFICIENT, автономия капается (мёржит человек через L2-PR):
- green-gate (свежий гейт на РЕЗУЛЬТАТ merge), clean-rebase (конфликт → отказ),
- forced-critic (feature/refactor: critic без `[blocker]`), rollback (migration: pre-ref+reset).
- security/migration — L3 запрещён по умолчанию (`--allow-risky` для явного включения).

Секвенс: probe → merge `--no-ff` → свежий gate на слитом дереве → RED? откат (`reset --hard` pre-ref)+отказ. Доложи probe-вердикт и итог.
