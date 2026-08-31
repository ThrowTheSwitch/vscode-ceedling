# Manual Test Project

A small real Ceedling project. It exists to manually exercise this extension's own features.

See [docs/Development.md](../../docs/Development.md) for how to use it.

`test_calculator_parametrized.c` requires Ceedling 1.1.0 or later. Ceedling 1.0.0 has no `TEST_CASE` support. It is kept in its own file so a 1.0.0 build failure there does not affect `test_calculator.c`.

Even on 1.1.0, this file can fail to build with GCC 14 or later. This is a real Ceedling code-generation bug, not a bug in this project. `test_calculator.c` is unaffected either way.
