---
id: ears-synth
stage: design-only
zone:
  allow: ["docs/**"]
---
# Synthetic EARS task (B.1a regression fixture)

on user tap, the toggle switches theme and persists it.
theme selection must always default to system preference.
if the network is offline, sync must be skipped.
cache stays bounded (invariant, not behavior).
