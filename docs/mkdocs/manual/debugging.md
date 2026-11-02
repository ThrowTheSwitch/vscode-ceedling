# Debugging

Debugging a test builds its test file, runs it, then starts your debugger on the test executable Ceedling built. The extension supplies the executable’s path to a `launch.json` configuration you provide. This page covers how that works, what a session covers, and how crashing tests are caught without a debugger. The [How-To guides][howto] add ready-to-use configurations for Linux, macOS, and Windows.

## The launch configuration

Each project debugs with the `launch.json` configuration that its `ceedlingExplorer.projects` entry names in [`debugLaunchConfig`][projects]. The setting holds the configuration’s *name*, its `"name"` field. A project that names none, like a folder without any `ceedlingExplorer.projects` entry, debugs with a configuration named `ceedling`.

The configuration’s `program` names the test executable with `${command:ceedlingExplorer.debugTestExecutable}`. The extension replaces this token with the executable’s path, relative to the project’s test output directory. That directory is `build/test/out/` in the project, unless `:project` ↳ `:build_root` moves `build/`. So `program` starts with the project’s own path to it.

This example uses Microsoft’s C/C++ extension, `ms-vscode.cpptools`, with gdb.

```json
{
    "name": "ceedling",
    "type": "cppdbg",
    "request": "launch",
    "program": "${workspaceFolder}/build/test/out/${command:ceedlingExplorer.debugTestExecutable}",
    "args": [],
    "stopAtEntry": false,
    "cwd": "${workspaceFolder}",
    "environment": [],
    "externalConsole": false,
    "MIMode": "gdb",
    "setupCommands": [
        {
            "description": "Enable pretty-printing for gdb",
            "text": "-enable-pretty-printing",
            "ignoreFailures": true
        }
    ]
}
```

On Windows, add `"miDebuggerPath"` with the path to MinGW’s or MSYS2’s `gdb.exe`, e.g. `"C:/msys64/ucrt64/bin/gdb.exe"`.

A project in a subdirectory of the workspace folder includes that directory, e.g. `${workspaceFolder}/firmware/build/test/out/`. The token’s part of the path follows the Ceedling version’s own build layout, so the same configuration works across Ceedling upgrades.

## Starting a debug session

Debugging must start from a test’s debug button, in the _Testing_ view or the editor’s gutter. The extension replaces the token only then. Starting the same configuration with F5, or from the _Run and Debug_ view, leaves the token unresolved. A clear error then says to start from a test’s debug button, instead of a confusing “path does not exist” failure.

A debug session takes three steps.

1. The extension builds and runs the test file, as a plain run does. The _Testing_ view shows that run’s real results.
2. It finds the executable that build just wrote, and replaces the token with its path.
3. It starts the configuration. The session ends when the debugger stops, or when you cancel the run.

A failed build starts no debugger. The _Testing_ view and the _Test Results_ panel show the build’s errors.

## What a session covers

Debugging always covers a whole test file. Ceedling compiles and runs each test file as one executable, so debugging one test function, or one parametrized case, still debugs its entire file. Set breakpoints in the test you care about, and expect the file’s other tests to run too.

Debugging several files at once debugs only the first, with a notification saying so.

## Crashing tests

Finding a crashing test needs no debugger. Ceedling’s own [`:use_backtrace`][use-backtrace-docs] project setting reports a crash as a failed test. Without it, a crash ends in a bare timeout or a silently stopped run. The extension shows that failure like any other, with no extra configuration.

The setting offers two ways to find a crash.

- **`:simple`**, the default, reruns each test case alone to find which one crashed. It needs no gdb. It also works with a simulator-based test fixture, not just native builds.
- **`:gdb`** also finds the exact crashing line. On Ceedling 1.1.0 and later, it writes a gdb log file per test case, and the extension turns the failure message’s reference to that log into a clickable link. `:gdb` needs gdb installed, and supports only the native build platform. Stay on `:simple` for a cross-compiled or simulator-based test fixture.

```yaml
:project:
  :use_backtrace: :gdb
```

[howto]: ../howto/index.md
[projects]: configuration.md#ceedlingexplorerprojects
[use-backtrace-docs]: https://docs.throwtheswitch.org/Ceedling/latest/configuration/reference/project/#use_backtrace

<br/><br/>
