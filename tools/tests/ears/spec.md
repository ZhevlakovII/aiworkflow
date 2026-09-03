# Synthetic spec (B.1a regression fixture)

3 valid FR (one per EARS core-3 pattern) + 4 intentionally broken FR.
Expected gate findings: 4 (noshall, empty-trigger, bad-pattern, bad-source).

```spec
id: SP-theme-scope
source: tools/tests/ears/task.md#L9-L11
statement: system manages theme behavior (problem-space)
```

```fr
id: FR-toggle-event
source: tools/tests/ears/task.md#L9
pattern: event
statement: WHEN the user taps the toggle THE SYSTEM SHALL switch theme and persist the choice
```

```fr
id: FR-default-ubiq
source: tools/tests/ears/task.md#L10
pattern: ubiquitous
statement: THE SYSTEM SHALL default theme selection to the system preference
```

```fr
id: FR-offline-unwanted
source: tools/tests/ears/task.md#L11
pattern: unwanted
statement: IF the network is offline THEN THE SYSTEM SHALL skip sync
```

```fr
id: FR-bad-noshall
source: tools/tests/ears/task.md#L9
pattern: event
statement: WHEN the user taps THE SYSTEM switches theme
```

```fr
id: FR-bad-emptytrigger
source: tools/tests/ears/task.md#L9
pattern: event
statement: WHEN THE SYSTEM SHALL switch theme
```

```fr
id: FR-bad-pattern
source: tools/tests/ears/task.md#L10
pattern: continuous
statement: THE SYSTEM SHALL do something
```

```fr
id: FR-bad-source
source: tools/tests/ears/task.md#L999
pattern: ubiquitous
statement: THE SYSTEM SHALL have a valid source
```
