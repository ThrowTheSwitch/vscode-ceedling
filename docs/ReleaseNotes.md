# VSCode-Ceedling Release Notes

Complemented by three other documents: [../CHANGELOG.md](../CHANGELOG.md), [KnownIssues.md](KnownIssues.md), and [BreakingChanges.md](BreakingChanges.md). Where the Changelog is a terse, itemized record of what changed, this document is the narrative version — the highlights worth reading before upgrading.

---

# Unreleased

## 👀 Highlights

Project configuration is now resolved with Ceedling’s own `ceedling dumpconfig` command instead of the extension parsing and merging `project.yml` by hand — the same merge a real build sees, plugin defaults included.

The `report_tests_log_factory` plugin’s `cppunit` report, which the Testing view depends on to read results, is now enabled automatically via a mixin bundled with the extension. Manually editing `project.yml` to enable it is no longer necessary. New `ceedlingExplorer.mixins` and `ceedlingExplorer.projects[].mixins` settings expose Ceedling’s own mixin mechanism directly, for anyone who wants to layer toolchain targets, CI overrides, or other configuration. See [Mixins](../README.md#mixins).

Test discovery now follows Ceedling’s own test runner exactly. Every test name, and every parametrized case name, matches what Ceedling reports. A test declared with a space before its parameter list, or with its body on one line, previously stayed skipped even when it passed ([#14](https://github.com/ThrowTheSwitch/vscode-ceedling/issues/14)). Commented-out tests no longer appear. Unity’s `TEST_MATRIX()` and exclusive `TEST_RANGE(<start, end, step>)` cases now appear individually.

Ceedling 1.2.0 is supported. Projects may use `ceedling.yml`, same-named test files in different directories each work, and configuration is read directly from Ceedling’s output. Every run reruns its tests, because 1.2.0’s cached results don’t account for running a single test.

Running, cancelling, and debugging tests are more dependable. A test whose result never arrives now shows an error explaining why, instead of quietly ending as skipped. Cancelling a run marks its tests skipped and stops only that run. Debugging reports the test file’s real results. Several races between runs, debug builds, _Clean_, _Clobber_, and edits to `project.yml` are gone.

`:unity: :test_prefix:` was never a real Ceedling setting — a misunderstanding inherited from the original extension — and is no longer read. If you want to change the recognized prefix of test-case functions, set `:test_runner: :test_prefix:`, which Ceedling actually supports.

## 🚨 Important Changes

The `ceedlingExplorer.testCaseMacroAliases` and `ceedlingExplorer.testRangeMacroAliases` settings are removed. Ceedling recognizes only the literal `TEST_CASE`, `TEST_RANGE`, and `TEST_MATRIX` markers, so these settings never worked. See [BreakingChanges.md](BreakingChanges.md).

Parametrized cases now appear in the _Testing_ view only when `:unity` ↳ `:use_param_tests` is enabled, matching how Ceedling runs them. With it disabled, Ceedling runs a marked function once, and the view shows it once.

Existing `project.yml` files that already enable `report_tests_log_factory` themselves continue to work unchanged; the extension’s mixin is additive.

If a `project.yml` set `:unity: :test_prefix:` *and* also passed `-UNITY_SKIP_DEFAULT_RUNNER` or `-RUN_TEST` as a Unity define expecting it to be ignored in favor of `:test_runner: :test_prefix:`, behavior is now simpler and more predictable: `:test_runner: :test_prefix:` is always what's used, with no define-sniffing. Projects using only `:test_runner: :test_prefix:` (the real, documented setting) are unaffected.

---

# 2.0.0 — 2026-08-31

## 👀 Highlights

2.0.0 was a significant rewrite of the original extension in order to add a test suite, address open issues, and more easily support future fixes and features.

This release also replaces the extension’s dependency on the third-party [Test Explorer UI](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer) extension with Visual Studio Code’s own native Testing API. The _Testing_ view, gutter run/debug icons, and inline failure messages are now provided directly by VS Code — `hbenl.vscode-test-explorer` is no longer required and may be uninstalled if you do not use it elsewhere.

Debugging a test is also more reliable. The extension now resolves the test executable’s path itself before starting the debug session, rather than relying on a VS Code command being resolved at an unpredictable time, fixing the “wrong executable path” / “No debug test executable found” class of bugs.

## 🚨 Important Changes

See [BreakingChanges.md](BreakingChanges.md) for the full detail on the Test Explorer UI migration — in short, if your `settings.json` or workflow assumed the third-party _Test Explorer_ view, you'll now use VS Code’s built-in _Testing_ view instead.
