---
name: aiwf-merge
description: L3 merge rail — capability-probe→merge→fresh gate→rollback on red
---

```
node "<clone>/core/src/rails/cli.ts" merge --branch <b> [--base <b> --class feature|refactor|security|migration]
```

security/migration blocked without `--allow-risky`. Report probe + outcome.
