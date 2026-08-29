# VSCode-Ceedling Known Issues

Complemented by three other documents: [../CHANGELOG.md](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), and [BreakingChanges.md](BreakingChanges.md).

---

## All versions

1. Individual parametrized test-case debugging is not supported — Ceedling always builds and runs a whole test file's executable, so debugging always targets the containing file, never a single `TEST_CASE`/`TEST_RANGE` case.
2. `compileForDebug` doesn't acquire the same mutex `runInternal` does around its Ceedling invocation and XML report read — a concurrent Run and Debug could theoretically race on the shared report file.

## 2.0.0 — Unreleased

1. Integration-test coverage of `src/testController.ts` and `src/problemMatcher.ts` (the VS Code Testing API wiring and diagnostics surfacing) is currently thin — `tests/integration/simple.test.ts` is still generator boilerplate. The new `tests/unit/` suite covers the pure Ceedling-output-parsing logic in `src/ceedlingEngine.ts`'s extracted modules, not the Testing API integration itself.
