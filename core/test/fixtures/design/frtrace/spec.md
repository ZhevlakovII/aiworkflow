# FR-trace fixture spec (B.1b regression)

2 FR requirements to trace against test files.

```spec
id: SP-money-scope
source: spec.md#L1
statement: money operations behave correctly (problem-space)
```

```fr
id: FR-add-positive
source: spec.md#L1
pattern: event
statement: WHEN two positive amounts are added THE SYSTEM SHALL return their sum
```

```fr
id: FR-reject-negative
source: spec.md#L1
pattern: unwanted
statement: IF an amount is negative THEN THE SYSTEM SHALL reject it
```
