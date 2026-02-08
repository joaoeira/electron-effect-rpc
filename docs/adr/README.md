# Architecture Decision Records

This directory tracks the decisions that shaped `electron-effect-rpc`. Each ADR
captures the context at the time, the decision that was made, and the
consequences we accepted.

These records are not meant to duplicate API docs. Their job is to preserve
intent, so future changes can be evaluated against original constraints.

The current accepted ADRs are:

- `docs/adr/0001-contract-first-schema-api.md`
- `docs/adr/0002-effect-handlers-and-runtime-injection.md`
- `docs/adr/0003-envelope-based-rpc-protocol.md`
- `docs/adr/0004-dual-mode-response-decoding.md`
- `docs/adr/0005-explicit-lifecycle-handles.md`
- `docs/adr/0006-bounded-event-queue-with-drop-oldest.md`
- `docs/adr/0007-safe-diagnostics-and-boundary-validation.md`
- `docs/adr/0008-esm-only-subpath-entrypoints.md`

When adding a new ADR, continue the numbering and mark status clearly. If a
decision is superseded, do not rewrite history; create a new ADR and reference
the earlier one.
