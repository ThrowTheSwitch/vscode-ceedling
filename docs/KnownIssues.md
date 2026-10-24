# VSCode-Ceedling Known Issues

This document lists the problems currently known, grouped by the Ceedling versions they affect. The [Changelog](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), and [BreakingChanges.md](BreakingChanges.md) complete the set.

---

## Ceedling versions before 1.2.1

1. A coverage run can’t tell apart same-named test files in different directories, e.g. `test/unit/test_foo.c` and `test/integration/test_foo.c`. Ceedling’s `gcov:` tasks before 1.2.1 take a test file’s name without its directory. Ceedling 1.2.0 then stops with an ambiguous file reference error, and earlier versions may run the other file. The extension warns in its log when a coverage run is ambiguous this way. Plain runs tell the files apart from Ceedling 1.2.0. The fix is tracked in [Ceedling#1362](https://github.com/ThrowTheSwitch/Ceedling/issues/1362).

## Ceedling versions before 1.2.0

1. A parametrized test whose arguments contain `<` or `&` (e.g. `TEST_CASE(1 < 2)`) makes every test in its file show an error. Ceedling before 1.2.0 writes these characters unescaped into its XML test report, and the extension cannot read the malformed report. Ceedling 1.2.0 fixes this.

## All versions

1. Debugging a single parametrized test case is not supported. Ceedling builds and runs a whole test file as one executable, so debugging always covers the containing file, never one `TEST_CASE`, `TEST_RANGE`, or `TEST_MATRIX` case.
2. A hand-written test runner is not supported. The extension finds tests by matching `:test_runner` ↳ `:test_prefix` against function names in source, as Ceedling’s generated runner does. A project that writes its own runner with Unity’s `UNITY_SKIP_DEFAULT_RUNNER` and `RUN_TEST`, calling functions outside that convention, can’t have those results matched to tests. No setting changes this.
