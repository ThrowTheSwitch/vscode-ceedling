# VSCode-Ceedling Known Issues

Complemented by three other documents: [../CHANGELOG.md](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), and [BreakingChanges.md](BreakingChanges.md).

---

## Ceedling versions before 1.2.0

1. A parametrized test whose arguments contain `<` or `&` (e.g. `TEST_CASE(1 < 2)`) makes every test in its file show an error. Ceedling before 1.2.0 writes these characters unescaped into its XML test report, and the extension cannot read the malformed report. Ceedling 1.2.0 fixes this.

## All versions

1. Individual parametrized test-case debugging is not supported — Ceedling always builds and runs a whole test file’s executable, so debugging always targets the containing file, never a single `TEST_CASE`/`TEST_RANGE` case.
2. `compileForDebug` doesn't acquire the same mutex `runInternal` does around its Ceedling invocation and XML report read. A concurrent Run and Debug could theoretically race on the shared report file.
3. Test-case discovery in the Testing view is based on matching `:test_runner:test_prefix` against function names in source text. If a project uses Unity's `UNITY_SKIP_DEFAULT_RUNNER`/custom `RUN_TEST` to hand-write its own runner and invoke functions that don't follow the configured prefix convention, this extension cannot correlate those functions to test results — this is a fundamental limit of prefix-based source scanning, not something a configuration change can fix.
