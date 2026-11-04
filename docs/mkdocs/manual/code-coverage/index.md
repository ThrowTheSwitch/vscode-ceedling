# Code Coverage

_Run with Coverage_ runs tests through a Ceedling coverage plugin and shows what they executed in VS Code’s coverage views. The extension supports two plugins, [Gcov][gcov] and [Bullseye][bullseye].

This page covers what coverage runs share: what a run shows, how runs work, and why a run might show none. Each plugin’s page says what it needs and what its reports include. The [coverage guide][coverage-guide] sets up either one step by step.

<div class="grid cards" markdown>

-   :material-chart-bar: **[Gcov][gcov]**

    ---

    Free, with GCC. Line, branch, and function coverage, with hit counts, through Gcovr or ReportGenerator to generate reports.

-   :material-bullseye-arrow: **[Bullseye][bullseye]**

    ---

    Commercial, and licensed. Function and condition/decision coverage with reports generated through Bullseye’s own tools.

</div>

## What a coverage run shows

A coverage run shows each source file’s line, branch, and function coverage. The _Test Coverage_ panel lists every file the report covers. In the editor, inline coverage marks each line’s hits and each branch’s outcome. Test results appear in the _Testing_ view exactly as for a plain run.

The _Testing_ view offers _Run with Coverage_, beside _Run_ and _Debug_, while a project enables a coverage plugin. A folder whose projects enable both plugins offers a profile for each, _Coverage (gcov)_ and _Coverage (Bullseye)_. A coverage run rebuilds the tests with coverage instrumentation, which is slower. Plain runs don’t pay that cost, since only coverage runs use the plugins.

## Choosing a plugin

The plugins differ in cost and in what they measure. Both report through the same views.

| | gcov | Bullseye |
|---|---|---|
| Cost | Free, with GCC | Commercial, with node-locked or floating licenses |
| Measures | Lines, branches, and functions | Functions, and each decision and condition |
| Hit counts | How often each line ran | Whether each line ran |
| Report tools | gcovr or ReportGenerator, installed apart | Bullseye’s own |
| Ceedling | 1.0.0 and later | 1.2.0 and later |

## How coverage runs work

A coverage run uses its plugin’s tasks, `gcov:` or `bullseye:`, in place of `test:` tasks. The [`ceedlingExplorer.coverageCommandArgs`][coverage-args] setting holds the task, as `ceedlingExplorer.testCommandArgs` holds a plain run’s. Its `${PLUGIN}` tag names the run’s plugin.

- **One run, one measurement.** Each coverage run shows only what it executed. The plugins’ reports count everything earlier runs measured, so the extension first clears it: gcov’s counters, or Bullseye’s coverage file. To accumulate coverage across runs instead, as Ceedling itself does until `ceedling clean` or `clobber`, set [`ceedlingExplorer.coverageResetsCounters`][resets] to `false`.
- **Overlapping runs.** Two coverage runs at once over the same counters may each show some of the other’s coverage. gcov keeps them in the build directory, and Bullseye in the project directory.
- **Deferred reports.** With `:report_task: TRUE` in the plugin’s settings, reports come only from its `report:gcov` or `report:bullseye` task. A coverage run then adds that task to its own command line.
- **Several projects.** A run spanning several projects shows their coverage together. A source file that several projects test shows their combined hits. Projects sharing one Bullseye coverage file are the exception, since each one’s report counts the whole file.
- **Projects without the plugin.** A coverage run still runs their tests, and a notification says why they have no coverage.
- **Both plugins in one project.** Each profile measures through its own plugin. Each plugin builds apart, in its own build directory.
- **Same-named test files.** Before Ceedling 1.2.1, coverage tasks take a test file’s name without its directory, so they can’t tell apart same-named test files in different directories. Ceedling 1.2.0 then stops with an ambiguous file reference error, and earlier versions may run the other file. The extension warns in its log when that applies. Ceedling 1.2.1 and later take the file’s path, as `test:` tasks do.

## When no coverage appears

A run can show no coverage for a handful of reasons, and a notification names most of them. Each reason is notified once a session. Every run also logs it, and notes it in the _Test Results_ panel beside Ceedling’s full output.

- **No Cobertura report configured.** The extension reads the Cobertura report each plugin can write. A notification says which setting chooses it.
- **No report written.** The plugin’s tools aren’t installed where Ceedling runs, aren’t on that shell’s `PATH`, or, for Bullseye, aren’t licensed. A notification names the report it expected.
- **No sources in the report.** A notification says so, and what the plugin leaves out.
- **A failed build.** No report is written, and the _Testing_ view shows the build’s errors.

Each plugin’s page lists its own causes, for [gcov][gcov-none] and for [Bullseye][bullseye-none].

[gcov]: gcov.md
[bullseye]: bullseye.md
[coverage-guide]: ../../howto/code-coverage.md
[coverage-args]: ../configuration.md#ceedlingexplorercoveragecommandargs
[resets]: ../configuration.md#ceedlingexplorercoverageresetscounters
[gcov-none]: gcov.md#when-no-coverage-appears
[bullseye-none]: bullseye.md#when-no-coverage-appears

<br/><br/>
