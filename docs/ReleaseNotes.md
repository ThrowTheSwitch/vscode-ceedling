# VSCode-Ceedling Release Notes

This document tells the story of each release: the highlights worth reading before upgrading. The [Changelog](../CHANGELOG.md) is the terse, itemized record. [KnownIssues.md](KnownIssues.md) and [BreakingChanges.md](BreakingChanges.md) complete the set.

---

# Unreleased

This release makes the _Testing_ view agree with Ceedling exactly, adds Ceedling 1.2.0 support, and makes everyday use more dependable.

## 👀 Highlights

Test discovery now follows Ceedling’s own test runner exactly. Every test name and every parametrized case name matches what Ceedling reports. Before, a test declared with a space before its parameter list, or with its body on one line, stayed skipped even when it passed ([#14](https://github.com/ThrowTheSwitch/vscode-ceedling/issues/14)). Commented-out tests no longer appear. Unity’s `TEST_MATRIX()` and exclusive `TEST_RANGE(<start, end, step>)` cases now appear individually.

Project configuration now comes from Ceedling itself. The extension reads it with `ceedling dumpconfig`, so it sees the same merge a real build does, plugin defaults included. A mixin bundled with the extension enables the `report_tests_log_factory` plugin’s `cppunit` report, which the _Testing_ view reads results from. Editing `project.yml` to enable it is no longer necessary. New `ceedlingExplorer.mixins` and `ceedlingExplorer.projects[].mixins` settings apply Ceedling mixins of your own, for toolchain targets, CI overrides, or other configuration. See [Mixins](../README.md#mixins).

Ceedling 1.2.0 is supported. Projects may use `ceedling.yml`. Same-named test files in different directories each work. Every run reruns its tests, because 1.2.0’s cached results don’t account for running a single test.

The _Testing_ view keeps itself current. It updates as you edit a test file, and rediscovers when test files come and go or a project or mixin file changes.

Running, cancelling, and debugging tests are more dependable. A test whose result never arrives now shows an error explaining why, instead of quietly ending as skipped. Cancelling a run marks its tests skipped and stops only that run. Debugging reports the test file’s real results. Several races between runs, debug builds, _Clean_, _Clobber_, and edits to `project.yml` are gone.

## 🚨 Important Changes

This release requires VS Code 1.74.0 or later.

The `ceedlingExplorer.testCaseMacroAliases` and `ceedlingExplorer.testRangeMacroAliases` settings are removed. Ceedling recognizes only the literal `TEST_CASE`, `TEST_RANGE`, and `TEST_MATRIX` markers, so these settings never worked. See [BreakingChanges.md](BreakingChanges.md).

Parametrized cases now appear in the _Testing_ view only when `:unity` ↳ `:use_param_tests` is enabled. That matches how Ceedling runs them. With it disabled, Ceedling runs a marked function once, and the view shows it once.

`:unity: :test_prefix:` is no longer read. It was never a real Ceedling setting, only a misunderstanding inherited from the original extension. To change the prefix of test functions, set `:test_runner: :test_prefix:`, which Ceedling supports. The extension also no longer inspects Unity defines such as `-UNITY_SKIP_DEFAULT_RUNNER` to choose between the two. Projects using only `:test_runner: :test_prefix:` are unaffected.

A `project.yml` that already enables `report_tests_log_factory` continues to work unchanged. The extension’s mixin adds to it.

---

# 2.0.0 — 2026-08-31

## 👀 Highlights

2.0.0 was a significant rewrite of the original extension in order to add a test suite, address open issues, and more easily support future fixes and features.

This release also replaces the extension’s dependency on the third-party [Test Explorer UI](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer) extension with Visual Studio Code’s own native Testing API. The _Testing_ view, gutter run/debug icons, and inline failure messages are now provided directly by VS Code — `hbenl.vscode-test-explorer` is no longer required and may be uninstalled if you do not use it elsewhere.

Debugging a test is also more reliable. The extension now resolves the test executable’s path itself before starting the debug session, rather than relying on a VS Code command being resolved at an unpredictable time, fixing the “wrong executable path” / “No debug test executable found” class of bugs.

## 🚨 Important Changes

See [BreakingChanges.md](BreakingChanges.md) for the full detail on the Test Explorer UI migration — in short, if your `settings.json` or workflow assumed the third-party _Test Explorer_ view, you'll now use VS Code’s built-in _Testing_ view instead.
