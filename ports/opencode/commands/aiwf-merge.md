---
description: "L3 автономный merge-рельс (тул gated_merge): capability-probe→merge→свежий gate→откат на red"
---

Автономный merge ТОЛЬКО через рельс — нативный тул `gated_merge` (raw `git merge` блокирован).

Аргументы: $ARGUMENTS (branch; опц. base/class/findings/allowRisky).

Вызови тул:
```
gated_merge(branch="<b>", base?="main", class?=<feature|refactor|security|migration>, findings?="<f>", allowRisky?=false)
```

**CAPABILITY-PROBE (гейт L3):** требуемые способности класса ДОЛЖНЫ быть — иначе INSUFFICIENT, автономия капается (мёржит человек через L2-PR):
- green-gate (свежий гейт на РЕЗУЛЬТАТ merge, `gate` → zone-gate из `task` → `policy.quality_gate.cmd`; `.workflow/gate.cmd` не читается), clean-rebase (конфликт → отказ),
- forced-critic (feature/refactor: critic-findings без `[blocker]`), rollback (migration: pre-ref+reset).
- security/migration — L3 запрещён по умолчанию (`allowRisky:true` для явного включения).

Секвенс: probe → merge `--no-ff` → свежий gate на слитом дереве → RED? откат (`reset --hard` pre-ref)+отказ. Доложи probe-вердикт и итог.
