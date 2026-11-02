# Find a Crashing Test

This guide finds the test that crashed, without starting a debugger. Ceedling’s own `:use_backtrace` setting does the work, and its default already reports which test case crashed. With gdb, it also finds the crashing line. At the end, a crash shows as a failed test in the _Testing_ view, at the test that crashed.

## What you need

- A project the _Testing_ view already lists. See [Start Testing in Your Project][first-run].
- For the `:gdb` choice, gdb installed where Ceedling runs, and tests built for the native platform.

## Choose how to find the crash

A crash stops a test executable before it reports, so Ceedling reruns the file’s tests to find which one crashed. The setting chooses how, at different costs.

| Choice | Finds | Needs | Suits |
|---|---|---|---|
| `:simple`, the default | The test case that crashed | Nothing more | Every test fixture, simulators and cross builds included |
| `:gdb` | The test case and the crashing line | gdb, and a native build | Tests that run on the build machine itself |
| `:none` | Nothing. Every test in the file fails as crashed | Nothing | Builds where reruns cost too much |

`:simple` reruns each test case of the crashed file on its own. `:gdb` reruns each one under gdb, which reports where the crash happened.

## Steps

1. **Choose a setting**, from the table above. A project that sets none gets `:simple`.
2. **Add it** to `project.yml`, or to a [mixin][mixins].
3. **Run the tests.** A crashing test shows as failed, with Ceedling’s account of the crash as its message.

=== "simple"

    <!-- example: mixin backtrace-simple -->

    ```yaml
    :project:
      :use_backtrace: :simple
    ```

=== "gdb"

    <!-- example: mixin backtrace-gdb -->

    ```yaml
    :project:
      :use_backtrace: :gdb
    ```

## What a crash looks like

A crashed test fails like any other, in the _Testing_ view and in the editor. With `:gdb`, its message tells where the test crashed, and its failure sits at the line gdb reports.

On Ceedling 1.1.0 and later, `:gdb` also writes a gdb log for each test case. The failure message’s reference to that log is a link. Choose it to open the log, with gdb’s full backtrace.

## When you need the debugger

A crash found this way often still needs a closer look. [Debug a Test][debug] runs the test file under the debugger, stopping at your breakpoints.

[first-run]: first-run.md
[mixins]: ../manual/configuration.md#mixins
[debug]: debug-a-test.md

<br/><br/>
