# VSCode-Ceedling Breaking Changes

This document explains each change that can break an existing setup, and what to do about it. The [Changelog](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), and [KnownIssues.md](KnownIssues.md) complete the set.

---

# [Unreleased]

## Test case marker alias settings removed

The `ceedlingExplorer.testCaseMacroAliases` and `ceedlingExplorer.testRangeMacroAliases` settings no longer exist. They never worked with Ceedling.

`TEST_CASE`, `TEST_RANGE`, and `TEST_MATRIX` are markers, not working C macros. Unity defines them to expand to nothing. Ceedling’s test runner generator scans your test file’s text for these exact names and builds parametrized calls from their arguments. It recognizes no other name, so a marker spelled any other way is ignored and its function runs as an ordinary test. With test preprocessing enabled, an alias macro would also expand away before the scan.

**What changes for you:**
- Remove either setting from your `settings.json`. VS Code otherwise shows it as an unknown setting. Nothing else is affected.
- Use the literal `TEST_CASE`, `TEST_RANGE`, or `TEST_MATRIX` markers in test files.

---

# [2.0.0] — 2026-08-31

## Native Testing API replaces the Test Explorer UI extension dependency

The extension now uses Visual Studio Code’s own Testing API (`vscode.tests`) instead of the third-party [Test Explorer UI](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer) extension (`hbenl.vscode-test-explorer`). Earlier versions required that extension to show the test tree, run and debug icons, and results.

**What changes for you:**
- The test tree now appears in VS Code’s built-in _Testing_ view (the flask icon in the Activity Bar), not the third-party _Test Explorer_ view.
- `hbenl.vscode-test-explorer` is no longer installed as a dependency of this extension and may be uninstalled if nothing else on your machine needs it.
- Any settings or keybindings that specifically targeted the _Test Explorer_ UI’s own commands/views no longer apply. Use VS Code’s native Testing view/commands instead.
- `launch.json` configurations using `${command:ceedlingExplorer.debugTestExecutable}` work unchanged. Only how the extension resolves that token changed.
