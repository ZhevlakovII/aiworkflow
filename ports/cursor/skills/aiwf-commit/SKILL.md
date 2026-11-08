---
name: aiwf-commit
description: L1 commit rail — stage→zone-check→gate→commit on green only
---

```
node "<clone>/core/src/rails/cli.ts" commit -m "<message>" [--gate "<cmd>"]
```

Raw `git commit` is blocked. Report SHA or refusal reason; non-zero exit ≠ success.
