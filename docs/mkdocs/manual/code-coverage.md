# Code Coverage

_Run with Coverage_ runs tests through Ceedling’s gcov plugin and shows what they executed in VS Code’s coverage views. This page covers how coverage runs work, what each report tool includes, and why a run might show none. The [coverage guide][coverage-guide] sets it up step by step, with gcovr or ReportGenerator.

## What a coverage run shows

A coverage run shows each source file’s line, branch, and function coverage. The _Test Coverage_ panel lists every file the report covers. In the editor, inline coverage marks each line’s hit count and each branch’s outcome. Test results appear in the _Testing_ view exactly as for a plain run.

The _Testing_ view offers _Run with Coverage_, beside _Run_ and _Debug_, while a project enables the gcov plugin. A coverage run rebuilds the tests with coverage instrumentation, which is slower. Plain runs don’t pay that cost, since only coverage runs use the plugin.

## What coverage needs

Coverage needs three pieces where Ceedling runs.

- Ceedling’s [gcov plugin][gcov-plugin], enabled in `project.yml` or a mixin.
- `gcov`, from the GCC toolchain.
- A report tool, either [gcovr] or [ReportGenerator]. Install gcovr with `pip install gcovr`. Install ReportGenerator, a .NET tool common on Windows, with `dotnet tool install -g dotnet-reportgenerator-globaltool`.

The extension reads the Cobertura XML report either tool writes, so the project must list `Cobertura` among `:gcov:` ↳ `:reports:`.

```yaml
:plugins:
  :enabled:
    - gcov
:gcov:
  :utilities:
    - gcovr           # or ReportGenerator, or both
  :reports:
    - Cobertura       # the report the extension reads; add any others you want
```

A mixin keeps these settings out of `project.yml`. Save the YAML above as, e.g., `coverage.yml`, and add it to [`ceedlingExplorer.mixins`][mixins]. Every run then has the plugin available, and only coverage runs use it.

## How coverage runs work

A coverage run uses Ceedling’s `gcov:` tasks in place of `test:` tasks. The [`ceedlingExplorer.coverageCommandArgs`][coverage-args] setting holds the task, as `ceedlingExplorer.testCommandArgs` holds a plain run’s.

- **One run, one measurement.** Each coverage run shows only what it executed. The tools report every coverage counter in the build directory, so the extension clears the counters earlier runs left before each coverage run. To accumulate coverage across runs instead, as Ceedling itself does until `ceedling clean` or `clobber`, set [`ceedlingExplorer.coverageResetsCounters`][resets] to `false`.
- **Overlapping runs.** Two coverage runs at once in the same build directory share its counters, so each may show some of the other’s coverage.
- **Which report.** With both tools enabled, the extension reads gcovr’s report.
- **Deferred reports.** With `:gcov:` ↳ `:report_task: TRUE`, reports come only from Ceedling’s `report:gcov` task. A coverage run then adds that task to its own command line.
- **Several projects.** A run spanning several projects shows their coverage together. A source file that several projects test shows their combined hits.
- **Projects without the plugin.** A coverage run still runs their tests, and a notification says why they have no coverage.
- **Same-named test files.** Before Ceedling 1.2.1, `gcov:` tasks take a test file’s name without its directory, so they can’t tell apart same-named test files in different directories. Ceedling 1.2.0 then stops with an ambiguous file reference error, and earlier versions may run the other file. The extension warns in its log when that applies. Ceedling 1.2.1 and later take the file’s path, as `test:` tasks do.

## What each tool reports

gcovr and ReportGenerator write the same report format, but they differ in what they include.

- **Sources outside the project.** gcovr reports only files beneath its `:gcov:` ↳ `:gcovr:` ↳ `:report_root:`, which defaults to the project directory. To include sources above the project, set it to a directory that holds them all, e.g. `".."`. ReportGenerator includes every source directory in `:paths:`.
- **Functions.** The _Test Coverage_ panel lists functions when the report names them. ReportGenerator’s reports do. gcovr’s do in some versions, e.g. 8.6, and not in others, e.g. 5.0 and 7.2. Line and branch coverage appear either way.
- **Sources earlier runs built.** ReportGenerator lists every source an earlier coverage build compiled, at 0% when this run didn’t execute it. gcovr leaves those out.

## When no coverage appears

A run can show no coverage for a handful of reasons, and a notification names most of them. Each reason is notified once a session. Every run also logs it, and notes it in the _Test Results_ panel beside Ceedling’s full output.

- **No Cobertura report configured.** A notification says to add `Cobertura` to `:gcov:` ↳ `:reports:`.
- **No report tool.** The report tool isn’t installed where Ceedling runs, or isn’t on that shell’s `PATH`. A notification names the report it expected.
- **No sources in the report.** A notification says so. gcovr reports only sources beneath its `:report_root:`, as above.
- **A failed build.** No report is written, and the _Testing_ view shows the build’s errors.

[coverage-guide]: ../howto/index.md
[gcov-plugin]: https://docs.throwtheswitch.org/Ceedling/latest/plugins/gcov/
[gcovr]: https://gcovr.com/
[ReportGenerator]: https://reportgenerator.io/
[coverage-args]: configuration.md#ceedlingexplorercoveragecommandargs
[resets]: configuration.md#ceedlingexplorercoverageresetscounters
[mixins]: configuration.md#ceedlingexplorermixins

<br/><br/>
