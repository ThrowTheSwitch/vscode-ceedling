# Debug a Test

This guide sets up debugging, so any test runs under the debugger from its debug button. It takes a debugger extension and one `launch.json` configuration. At the end, a test’s debug button builds its file and stops at your breakpoints.

## What you need

- A project the _Testing_ view already lists. See [Start Testing in Your Project][first-run].
- A native debugger: gdb on Linux and Windows, lldb on macOS.
- A VS Code debugger extension. Microsoft’s [C/C++ extension][cpptools], `ms-vscode.cpptools`, drives gdb and lldb. On macOS, [CodeLLDB][codelldb], `vadimcn.vscode-lldb`, brings its own lldb.

## Steps

1. **Install the debugger extension**, from VS Code’s _Extensions_ view.
2. **Add a launch configuration.** Open `.vscode/launch.json` in the workspace folder, creating it if needed, and add the configuration for your platform below. Name it `ceedling`, which the extension looks for by default.
3. **Set a breakpoint** in a test function.
4. **Debug the test.** Choose the debug button beside the test, in the _Testing_ view or the editor’s gutter. The extension builds and runs the test file, then starts the debugger at your breakpoint.

## A configuration for each platform

Each configuration names the test executable with the token `${command:ceedlingExplorer.debugTestExecutable}`. The extension replaces it with the executable’s path, relative to the `test/out/` directory under the project’s build root. The examples assume the build root is `build`, as `ceedling new` sets it.

=== "Linux"

    The C/C++ extension with gdb.

    <!-- example: launch linux-gdb -->

    ```json
    {
        "version": "0.2.0",
        "configurations": [
            {
                "name": "ceedling",
                "type": "cppdbg",
                "request": "launch",
                "program": "${workspaceFolder}/build/test/out/${command:ceedlingExplorer.debugTestExecutable}",
                "args": [],
                "cwd": "${workspaceFolder}",
                "MIMode": "gdb",
                "setupCommands": [
                    { "description": "Enable pretty-printing for gdb", "text": "-enable-pretty-printing", "ignoreFailures": true }
                ]
            }
        ]
    }
    ```

=== "macOS"

    CodeLLDB, which bundles its own lldb and needs nothing else installed.

    <!-- example: launch macos-codelldb -->

    ```json
    {
        "version": "0.2.0",
        "configurations": [
            {
                "name": "ceedling",
                "type": "lldb",
                "request": "launch",
                "program": "${workspaceFolder}/build/test/out/${command:ceedlingExplorer.debugTestExecutable}",
                "args": [],
                "cwd": "${workspaceFolder}"
            }
        ]
    }
    ```

    The C/C++ extension drives lldb too, with `"MIMode": "lldb"`.

    <!-- example: launch macos-cppdbg -->

    ```json
    {
        "version": "0.2.0",
        "configurations": [
            {
                "name": "ceedling",
                "type": "cppdbg",
                "request": "launch",
                "program": "${workspaceFolder}/build/test/out/${command:ceedlingExplorer.debugTestExecutable}",
                "args": [],
                "cwd": "${workspaceFolder}",
                "MIMode": "lldb"
            }
        ]
    }
    ```

=== "Windows"

    The C/C++ extension with the gdb of MinGW or MSYS2. `miDebuggerPath` names it. This one is MSYS2’s UCRT64 gdb.

    <!-- example: launch windows-gdb -->

    ```json
    {
        "version": "0.2.0",
        "configurations": [
            {
                "name": "ceedling",
                "type": "cppdbg",
                "request": "launch",
                "program": "${workspaceFolder}/build/test/out/${command:ceedlingExplorer.debugTestExecutable}",
                "args": [],
                "cwd": "${workspaceFolder}",
                "MIMode": "gdb",
                "miDebuggerPath": "C:/msys64/ucrt64/bin/gdb.exe",
                "setupCommands": [
                    { "description": "Enable pretty-printing for gdb", "text": "-enable-pretty-printing", "ignoreFailures": true }
                ]
            }
        ]
    }
    ```

    The debugger must match the compiler that built the tests, e.g. MSYS2 UCRT64’s gdb for its gcc.

## Several projects

Each project in `ceedlingExplorer.projects` names its own configuration in `debugLaunchConfig`. Projects in subdirectories need configurations whose `program` includes the subdirectory.

<!-- example: settings debug-two-projects -->

```json
{
    "ceedlingExplorer.projects": [
        { "path": "app", "debugLaunchConfig": "Debug app test" },
        { "path": "bootloader", "debugLaunchConfig": "Debug bootloader test" }
    ]
}
```

<!-- example: launch debug-two-projects -->

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Debug app test",
            "type": "cppdbg",
            "request": "launch",
            "program": "${workspaceFolder}/app/build/test/out/${command:ceedlingExplorer.debugTestExecutable}",
            "cwd": "${workspaceFolder}/app",
            "MIMode": "gdb"
        },
        {
            "name": "Debug bootloader test",
            "type": "cppdbg",
            "request": "launch",
            "program": "${workspaceFolder}/bootloader/build/test/out/${command:ceedlingExplorer.debugTestExecutable}",
            "cwd": "${workspaceFolder}/bootloader",
            "MIMode": "gdb"
        }
    ]
}
```

## A build root of your own

A project that moves its build with `:project` ↳ `:build_root` moves the executable with it. The `program` path then starts with that build root instead of `build`.

<!-- example: mixin build-root -->

```yaml
:project:
  :build_root: out
```

With that build root, `program` becomes `${workspaceFolder}/out/test/out/${command:ceedlingExplorer.debugTestExecutable}`.

## What to expect

A debug session covers a whole test file, since Ceedling builds each file into one executable. The file’s other tests run too, so set breakpoints in the test you care about.

Start a session only from a test’s debug button. Starting the configuration with F5 shows an error, since only a test’s debug button tells the extension which executable to debug. [Debugging][debugging] explains the whole sequence.

[first-run]: first-run.md
[cpptools]: https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools
[codelldb]: https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb
[debugging]: ../manual/debugging.md

<br/><br/>
