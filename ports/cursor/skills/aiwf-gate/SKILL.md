---
name: aiwf-gate
description: Mechanical design gate (gate-lint) — not free judgment
---

```
node "<clone>/core/src/design/gate-lint-cli.ts" --task <t> --spec <s> --adr <a>
```

Exit 0 = PASS. Exit 1 = BOUNCE. Do not declare PASS on non-zero.
