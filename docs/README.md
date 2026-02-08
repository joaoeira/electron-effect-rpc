# Documentation

This folder is the maintainers' map for `electron-effect-rpc`. It is meant to
explain intent and tradeoffs, not to walk line by line through implementation.
When you need to understand why a piece of code exists, start here.

The architecture overview lives in `docs/architecture.md`. It describes how the
main process, preload bridge, and renderer cooperate, and how RPC and event
traffic move across process boundaries.

Design rationale is now tracked as ADRs in `docs/adr/`. Those records capture
the key decisions that shaped the library, including what alternatives were
considered and what consequences we accepted.

If you are making a non-trivial change, read the architecture overview first and
then the ADRs most related to your change. That combination gives enough context
to evolve behavior safely without drifting away from the original constraints.
