# Start Testing in Your Project

This guide takes a typical Ceedling project from opening it in VS Code to running its first test. Most projects need no configuration, so it usually takes a minute. At the end, the _Testing_ view lists every test, and runs any of them.

## What you need

- VS Code 1.88.0 or later.
- Ceedling 1.0.0 or later, which runs in a terminal. `ceedling version` should print its version.
- A Ceedling project, with its `project.yml`, or `ceedling.yml` from Ceedling 1.2.0.

## Steps

1. **Install the extension.** Search VS Code’s _Extensions_ view for “Ceedling”, and install _Ceedling_ by Throw The Switch.
2. **Open the project.** Open the folder holding the project file, with _File_ ↳ _Open Folder…_.
3. **Open the _Testing_ view.** Choose the flask icon in the Activity Bar. After a few seconds, the view lists the project’s test files, each with its test functions.
4. **Run a test.** Choose the run button beside a test function. Its result appears beside it, and a failure shows its message at the failing line in the editor.
5. **Run them all.** Choose _Run Tests_ at the top of the view, to run every test file.

The editor’s gutter shows run and debug buttons beside each test function too.

## When no tests appear

The extension looks for the project file at the folder’s root. Two settings cover most projects where it isn’t found, or where Ceedling won’t run.

A project in a subdirectory needs its path in `ceedlingExplorer.projects`. Add it to the folder’s `.vscode/settings.json`.

<!-- example: settings first-run-subdirectory -->

```json
{
    "ceedlingExplorer.projects": [
        { "path": "firmware" }
    ]
}
```

A Ceedling that runs only in a particular shell needs that shell in `ceedlingExplorer.shellPath`. That is common on Windows, where Ceedling may run only in an MSYS2 or Git Bash shell. [Run the Ceedling You Use][installations] shows each setup.

Any other problem shows a notification. [Troubleshooting][troubleshooting] matches each message to its fix.

## What happens when the folder opens

The extension asks Ceedling itself about the project, so it sees exactly what a real build sees. It runs `ceedling version`, then `ceedling dumpconfig` and `ceedling files:test`, in the project’s directory. It then reads each test file for its test functions. [Getting Started][getting-started] explains each step.

The test list keeps itself current from then on. Editing a test file updates its tests as you type. Adding a test file, or changing `project.yml`, rediscovers the project.

## Next steps

- [Debug a Test][debug] adds a launch configuration, so any test runs under the debugger.
- [Measure Code Coverage][coverage] adds Ceedling’s gcov plugin, for _Run with Coverage_.
- [See Compiler Errors in the Editor][problems] puts compiler and linker errors in the _Problems_ panel.

[installations]: ceedling-installations.md
[troubleshooting]: ../troubleshooting.md
[getting-started]: ../manual/getting-started.md#how-the-extension-reads-a-project
[debug]: debug-a-test.md
[coverage]: code-coverage.md
[problems]: compiler-problems.md

<br/><br/>
