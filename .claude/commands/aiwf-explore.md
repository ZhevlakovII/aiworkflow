---
description: Read-only discovery через explorer-субагента → curated inventory (не raw-дамп)
argument-hint: <вопрос/цель разведки>
allowed-tools: Task, Read
---

Спавни `explorer`-субагента (Task tool, `subagent_type: explorer`) под вопрос:

$ARGUMENTS

Explorer — read-only, discovery через `ast-index` (не mass-grep), возвращает curated inventory-файл (релевантные пути + заметки), не решения. Дождись return, доложи pointer на inventory + сжатую сводку. Не читай его работу «на всякий».
