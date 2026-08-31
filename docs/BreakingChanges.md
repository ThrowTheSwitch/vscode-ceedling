# VSCode-Ceedling Breaking Changes

Complemented by three other documents: [../CHANGELOG.md](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), and [KnownIssues.md](KnownIssues.md).

---

# [2.0.0] — Prerelease

## Native Testing API replaces the Test Explorer UI extension dependency

Previous versions of this extension required the third-party [Test Explorer UI](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer) extension (`hbenl.vscode-test-explorer`) to render the test tree, run/debug icons, and results. This version drops that dependency entirely in favor of Visual Studio Code’s own native Testing API (`vscode.tests`).

**What changes for you:**
- The test tree now appears in VS Code’s built-in _Testing_ view (the flask icon in the Activity Bar), not the third-party _Test Explorer_ view.
- `hbenl.vscode-test-explorer` is no longer installed as a dependency of this extension and may be uninstalled if nothing else on your machine needs it.
- Any settings or keybindings that specifically targeted the _Test Explorer_ UI’s own commands/views no longer apply. Use VS Code’s native Testing view/commands instead.
- `launch.json` configurations using `${command:ceedlingExplorer.debugTestExecutable}` continue to work unchanged; the resolution mechanism behind that token changed internally, but its usage did not.
