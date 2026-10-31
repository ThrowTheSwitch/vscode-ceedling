# VSCode-Ceedling Known Issues

This document lists the problems currently known, grouped by the Ceedling versions they affect. The [Changelog](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), and [BreakingChanges.md](BreakingChanges.md) complete the set.

---

## Upgrading to Ceedling 1.2.2

1. A project built by an earlier Ceedling keeps that build’s output until `ceedling clobber`, since Ceedling 1.2.2 builds each test elsewhere. Coverage reports still read the old counters, so with `ceedlingExplorer.coverageResetsCounters` off, coverage counts them too. After an upgrade from 1.2.0 or 1.2.1, the first build warns, and the extension offers to clobber the project. An upgrade from an earlier release brings no warning, nor does a build whose verbosity hides Ceedling’s warnings. Clobber once by hand, with the _Testing_ view’s Clobber button.

## Ceedling 1.2.0 and 1.2.1

1. Ceedling can’t build a test file whose path within its test path ends another same-named test file’s path. Every run of that file, and of the whole project, stops with Ceedling’s `Ambiguous file reference` error, which leads each test’s error message. For example, with the test path `+:test/**`, `test/test_calc.c` can’t be built beside `test/unit/test_calc.c`, though `test/unit/test_calc.c` can. Renaming one of the files avoids it. Ceedling 1.2.2 fixes this ([Ceedling#1364](https://github.com/ThrowTheSwitch/Ceedling/issues/1364)).

## Ceedling versions before 1.2.2

1. A project running its own Ceedling of another build than the installed one, vendored in `vendor/ceedling` or selected by `WHICH_CEEDLING`, is treated as the installed Ceedling’s version. Ceedling before 1.2.2 reports that version for it ([Ceedling#1365](https://github.com/ThrowTheSwitch/Ceedling/issues/1365)). The extension then uses the installed version’s command-line features, logs a warning, and the _Testing_ view waits for the project’s runs to finish before updating. A copy of the installed build, as `ceedling new --local` makes, is unaffected. Ceedling 1.0.0 reports no build commit, so such a copy still gets the warning there.
2. A project whose `:project` ↳ `:which_ceedling`, in `project.yml` or a mixin, selects a Ceedling other than the installed gem or its own `vendor/ceedling` is treated as the installed Ceedling’s version. Ceedling before 1.2.2 reports its version without reading the project’s configuration. The extension then uses the installed version’s command-line features, and the _Testing_ view waits for the project’s runs to finish before updating. Installing Ceedling 1.2.2 fixes this.
3. After an edit to `project.yml` or a mixin file, the _Testing_ view can’t update during a long run in the same project, or in one sharing its directory or build directory. The rediscovery waits for the run to finish, since Ceedling before 1.2.2 can’t show whether the edit selected another Ceedling. A newly added project waits the same way. Ceedling 1.2.2 fixes this.
4. With Ceedling 1.2.1 installed, a project running Ceedling 1.2.0 from another installation can’t load. Every Ceedling command in it but `ceedling version` stops with an `undefined method` exception, which the extension’s error quotes ([Ceedling#1365](https://github.com/ThrowTheSwitch/Ceedling/issues/1365)). Other pairs of releases before 1.2.2 can fail the same way. Install the release the project runs, or have the project run the installed one. Installing Ceedling 1.2.2 fixes this.

## Ceedling versions before 1.2.1

1. A coverage run can’t tell apart same-named test files in different directories, e.g. `test/unit/test_foo.c` and `test/integration/test_foo.c`. Ceedling’s `gcov:` tasks before 1.2.1 take a test file’s name without its directory. Ceedling 1.2.0 then stops with an ambiguous file reference error, and earlier versions may run the other file. The extension warns in its log when a coverage run is ambiguous this way. Plain runs tell the files apart from Ceedling 1.2.0. Ceedling 1.2.1 fixes this ([Ceedling#1362](https://github.com/ThrowTheSwitch/Ceedling/issues/1362)).
2. The _Testing_ view can’t update during a long run in the same project, or in one sharing its directory or build directory. A rediscovery, e.g. after adding a test file, waits for the run to finish, since discovery before Ceedling 1.2.1 rewrites files the run uses. Ceedling 1.2.1 fixes this ([Ceedling#1361](https://github.com/ThrowTheSwitch/Ceedling/issues/1361)).

## Ceedling versions before 1.2.0

1. A parametrized test whose arguments contain `<` or `&` (e.g. `TEST_CASE(1 < 2)`) makes every test in its file show an error. Ceedling before 1.2.0 writes these characters unescaped into its XML test report, and the extension cannot read the malformed report. Ceedling 1.2.0 fixes this.

## All versions

1. Debugging a single parametrized test case is not supported. Ceedling builds and runs a whole test file as one executable, so debugging always covers the containing file, never one `TEST_CASE`, `TEST_RANGE`, or `TEST_MATRIX` case.
2. A hand-written test runner is not supported. The extension finds tests by matching `:test_runner` ↳ `:test_prefix` against function names in source, as Ceedling’s generated runner does. A project that writes its own runner with Unity’s `UNITY_SKIP_DEFAULT_RUNNER` and `RUN_TEST`, calling functions outside that convention, can’t have those results matched to tests. No setting changes this.
