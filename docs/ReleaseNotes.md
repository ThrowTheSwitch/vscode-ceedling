# VSCode-Ceedling Release Notes

Complemented by three other documents: [Changelog.md](Changelog.md), [KnownIssues.md](KnownIssues.md), and [BreakingChanges.md](BreakingChanges.md). Where the Changelog is a terse, itemized record of what changed, this document is the narrative version — the highlights worth reading before upgrading.

---

# 2.0.0 — Unreleased

## 👀 Highlights

This release replaces the extension's dependency on the third-party [Test Explorer UI](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer) extension with Visual Studio Code's own native Testing API. The Testing view, gutter run/debug icons, and inline failure messages are now provided directly by VS Code — `hbenl.vscode-test-explorer` is no longer required and may be uninstalled if you don't use it elsewhere.

Debugging a test is also more reliable: the extension now resolves the test executable's path itself before starting the debug session, rather than relying on a VS Code command being resolved at an unpredictable time, fixing the "wrong executable path" / "No debug test executable found" class of bugs.

## 🚨 Important Changes in Behavior to Be Aware Of

See [BreakingChanges.md](BreakingChanges.md) for the full detail on the Test Explorer UI migration — in short, if your `settings.json` or workflow assumed the third-party Test Explorer view, you'll now use VS Code's built-in Testing view instead.
