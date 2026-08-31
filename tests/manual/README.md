# Manual Test Project

A small real Ceedling project. It exists to manually exercise this extension's own features.

See [docs/Development.md](../../docs/Development.md) for how to use it.

`test_calculator_parametrized.c` needs `:unity: :use_param_tests: true` in `project.yml` (already set). Ceedling 1.0.0 also needs `:project: :use_test_preprocessor: :none` (already the default) — Ceedling 1.0.0 cannot preserve `TEST_CASE`/`TEST_RANGE` macros through its own test-file preprocessing. Ceedling 1.1.0 supports parameterized tests with or without preprocessing.
