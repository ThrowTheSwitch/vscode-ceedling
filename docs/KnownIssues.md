# VSCode-Ceedling Known Issues

This document lists the problems currently known, grouped by the Ceedling versions they affect. The [Changelog](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), and [BreakingChanges.md](BreakingChanges.md) complete the set.

---

## Ceedling 1.2.0 and 1.2.1

1. Ceedling can’t build a test file whose path within its test path ends another same-named test file’s path. Every run of that file, and of the whole project, stops with Ceedling’s `Ambiguous file reference` error, which leads each test’s error message. For example, with the test path `+:test/**`, `test/test_calc.c` can’t be built beside `test/unit/test_calc.c`, though `test/unit/test_calc.c` can. Renaming one of the files avoids it. Ceedling 1.2.2 fixes this ([Ceedling#1364](https://github.com/ThrowTheSwitch/Ceedling/issues/1364)).

## Ceedling versions before 1.2.2

1. A project running its own Ceedling of another build than the installed one, vendored in `vendor/ceedling` or selected by `WHICH_CEEDLING`, is treated as the installed Ceedling’s version. Ceedling before 1.2.2 reports that version for it ([Ceedling#1365](https://github.com/ThrowTheSwitch/Ceedling/issues/1365)). The extension then uses the installed version’s command-line features, logs a warning, and has the project’s rediscoveries wait for its runs. A copy of the installed build, as `ceedling new --local` makes, is unaffected. Ceedling 1.0.0 reports no build commit, so such a copy still gets the warning there.
2. With Ceedling 1.2.1 installed, a project vendoring Ceedling 1.2.0 can’t load. Every Ceedling command in it but `ceedling version` stops with an `undefined method` exception ([Ceedling#1365](https://github.com/ThrowTheSwitch/Ceedling/issues/1365)).

## Ceedling versions before 1.2.1

1. A coverage run can’t tell apart same-named test files in different directories, e.g. `test/unit/test_foo.c` and `test/integration/test_foo.c`. Ceedling’s `gcov:` tasks before 1.2.1 take a test file’s name without its directory. Ceedling 1.2.0 then stops with an ambiguous file reference error, and earlier versions may run the other file. The extension warns in its log when a coverage run is ambiguous this way. Plain runs tell the files apart from Ceedling 1.2.0. Ceedling 1.2.1 fixes this ([Ceedling#1362](https://github.com/ThrowTheSwitch/Ceedling/issues/1362)).
2. The _Testing_ view can’t update during a long run in the same project, or in one sharing its directory or build directory. A rediscovery, e.g. after adding a test file or editing `project.yml`, waits for the run to finish, since discovery before Ceedling 1.2.1 rewrites files the run uses. Ceedling 1.2.1 fixes this ([Ceedling#1361](https://github.com/ThrowTheSwitch/Ceedling/issues/1361)).

## Ceedling versions before 1.2.0

1. A parametrized test whose arguments contain `<` or `&` (e.g. `TEST_CASE(1 < 2)`) makes every test in its file show an error. Ceedling before 1.2.0 writes these characters unescaped into its XML test report, and the extension cannot read the malformed report. Ceedling 1.2.0 fixes this.

## All versions

1. Debugging a single parametrized test case is not supported. Ceedling builds and runs a whole test file as one executable, so debugging always covers the containing file, never one `TEST_CASE`, `TEST_RANGE`, or `TEST_MATRIX` case.
2. A hand-written test runner is not supported. The extension finds tests by matching `:test_runner` ↳ `:test_prefix` against function names in source, as Ceedling’s generated runner does. A project that writes its own runner with Unity’s `UNITY_SKIP_DEFAULT_RUNNER` and `RUN_TEST`, calling functions outside that convention, can’t have those results matched to tests. No setting changes this.
3. A project whose `:project` ↳ `:which_ceedling` selects a Ceedling other than the installed gem or its own `vendor/ceedling` is treated as the Ceedling `ceedling version` reports for the project directory. `ceedling version` never reads the project file. The extension then uses the reported version’s command-line features. From Ceedling 1.2.1, such a project still waits for runs before rediscovering, so an older Ceedling it selects can’t corrupt a build. To avoid this, vendor that Ceedling in `vendor/ceedling` or select it with `WHICH_CEEDLING`. This works from Ceedling 1.2.2, or with a copy of the installed build.
