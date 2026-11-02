# Getting Started

The extension brings a Ceedling project’s tests into VS Code’s built-in _Testing_ view, and most projects need no configuration at all. This page covers what the extension requires, how to install it, and what it does when it opens a project. The [first-run guide][first-run] walks through the same steps for a typical project.

## Requirements

The extension needs a recent VS Code and Ceedling 1.0.0 or later.

- **VS Code** 1.88.0 or later. That release added the test coverage views that _Run with Coverage_ uses.
- **Ceedling** 1.0.0 or later. Ceedling 1.0.0 through 1.2.2 are supported. The [Ceedling documentation][ceedling-docs] covers installing it.
- **Code coverage** also needs Ceedling’s gcov plugin and a coverage report tool. See [Code Coverage][coverage].
- **Debugging** needs a debugger extension, such as Microsoft’s C/C++ extension, and a `launch.json` configuration. See [Debugging][debugging].

## Installing

Install the extension from the Visual Studio Marketplace. Search the _Extensions_ view for “Ceedling”, or open the [Marketplace page][marketplace]. Its identifier is `throw-the-switch.vscode-ceedling`.

## Opening a project

Open the folder or workspace containing your Ceedling project, then open the _Testing_ view, the flask icon in the Activity Bar. The view lists every test file, test function, and parametrized test case. Run and debug tests from it, or from the icons beside each test in the editor.

Two settings cover most projects that don’t work straight away.

- When the project file isn’t at the folder’s root, name the project in [`ceedlingExplorer.projects`][projects].
- When Ceedling runs only in a particular shell, as is common on Windows, set [`ceedlingExplorer.shellPath`][shell-path].

A workspace with several folders lists each folder’s projects under an entry of its own, labeled _Ceedling (folder)_. A folder without a Ceedling project adds no entry.

## How the extension reads a project

The extension asks Ceedling itself for each project’s configuration, so it sees exactly what a real build sees. Discovering a project takes three Ceedling commands, run in the project’s directory.

1. `ceedling version` checks that Ceedling runs and is 1.0.0 or later. It honors a Ceedling vendored in the project’s `vendor/ceedling`, or named by `WHICH_CEEDLING`. From Ceedling 1.2.2, it runs again with the project’s own project file and mixins, which may select another installation through `:project` ↳ `:which_ceedling`. The version decides which of Ceedling’s features the extension uses, such as running a test file by its path from Ceedling 1.2.0.
2. [`ceedling dumpconfig`][dumpconfig-docs] resolves the project’s configuration, with its mixins and plugin defaults applied.
3. `ceedling files:test` lists the project’s test files. The extension then reads each one to find its test functions and parametrized cases.

The extension applies a mixin of its own to every command that reads or runs the project. It enables the `report_tests_log_factory` plugin’s `cppunit` report, which is where the extension reads test results. No plugin setup is needed in `project.yml`. [Configuration][mixins] explains how it combines with your own mixins.

## Keeping the test list current

The _Testing_ view keeps itself current as the project changes.

- Editing a test file updates its tests as you type, even before you save.
- Adding or removing a test file rediscovers the project.
- Changing `project.yml`, a mixin file, or the Ceedling in `vendor/ceedling` rediscovers it too.
- Changing a setting that affects discovery, such as `ceedlingExplorer.projects`, rediscovers every project in the folder.

The _Testing_ view’s refresh button rediscovers on demand, for example after upgrading the installed Ceedling gem.

## Migrating from Ceedling Test Explorer

This extension continues the original _Ceedling Test Explorer_ extension, and most of its settings carry over unchanged.

- The tests appear in VS Code’s own _Testing_ view, not the third-party _Test Explorer_ view. The _Test Explorer UI_ extension is no longer needed.
- The `ceedlingExplorer.debugConfiguration` setting no longer exists. Name each project’s launch configuration in `ceedlingExplorer.projects[].debugLaunchConfig` instead.
- `launch.json` configurations using `${command:ceedlingExplorer.debugTestExecutable}` work unchanged.

The [Breaking Changes][breaking] document describes the changes that need action when upgrading.

[first-run]: ../howto/first-run.md
[ceedling-docs]: https://docs.throwtheswitch.org/Ceedling/latest/
[coverage]: code-coverage.md
[debugging]: debugging.md
[marketplace]: https://marketplace.visualstudio.com/items?itemName=throw-the-switch.vscode-ceedling
[projects]: configuration.md#ceedlingexplorerprojects
[shell-path]: configuration.md#ceedlingexplorershellpath
[dumpconfig-docs]: https://docs.throwtheswitch.org/Ceedling/latest/getting-started/command-line/#ceedling-dumpconfig-filepath-sections
[mixins]: configuration.md#mixins
[breaking]: https://github.com/ThrowTheSwitch/vscode-ceedling/blob/master/docs/BreakingChanges.md

<br/><br/>
