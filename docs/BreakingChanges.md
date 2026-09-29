# VSCode-Ceedling Breaking Changes

Complemented by three other documents: [../CHANGELOG.md](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), and [KnownIssues.md](KnownIssues.md).

---

# [Unreleased]

## Minimum VS Code version is now 1.88.0

This extension now requires VS Code 1.88.0 or later, up from 1.71.0. 1.88.0 is the release that finalized VS Code's test coverage API, which the new **Run with Coverage** support is built on.

**What changes for you:**
- On VS Code 1.88.0 or later, nothing. Coverage is additive and opt-in; every existing behavior and setting is unchanged.
- On anything older, VS Code will not offer this version. It keeps the last version you can run, which continues to work.

---

# [2.0.0] — 2026-08-31

## Native Testing API replaces the Test Explorer UI extension dependency

Previous versions of this extension required the third-party [Test Explorer UI](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer) extension (`hbenl.vscode-test-explorer`) to render the test tree, run/debug icons, and results. This version drops that dependency entirely in favor of Visual Studio Code’s own native Testing API (`vscode.tests`).

**What changes for you:**
- The test tree now appears in VS Code’s built-in _Testing_ view (the flask icon in the Activity Bar), not the third-party _Test Explorer_ view.
- `hbenl.vscode-test-explorer` is no longer installed as a dependency of this extension and may be uninstalled if nothing else on your machine needs it.
- Any settings or keybindings that specifically targeted the _Test Explorer_ UI’s own commands/views no longer apply. Use VS Code’s native Testing view/commands instead.
- `launch.json` configurations using `${command:ceedlingExplorer.debugTestExecutable}` continue to work unchanged; the resolution mechanism behind that token changed internally, but its usage did not.
