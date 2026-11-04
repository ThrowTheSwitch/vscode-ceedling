# gcov

Ceedling’s [Gcov plugin][gcov-plugin] measures coverage with GCC’s instrumentation and GCC’s own `gcov`. A report tool then turns its counters into the Cobertura report the extension reads. This page covers what gcov coverage needs, how its counters reset, what each report tool includes, and why a gcov run might show none. [Code Coverage][coverage] covers what every coverage run shares, and the [coverage guide][coverage-guide] sets it up step by step.

## What gcov coverage needs

gcov coverage needs three pieces where Ceedling runs.

- Ceedling’s Gcov plugin, enabled in `project.yml` or a mixin.
- `gcov`, from the GCC toolchain. The plugin builds its coverage tests with GCC, whatever compiler the project’s other tests use.
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

## How its counters reset

Gcov counts each test’s hits in counter files beneath the build directory’s `gcov/out`. Before a request’s first gcov build, the extension deletes them, so the run shows only what it executed. A rebuilt test writes them afresh. With [`ceedlingExplorer.coverageResetsCounters`][resets] off, they stay and add up.

A single test’s run reruns its whole file when Ceedling’s filter also selects another test. The extension then clears that test file’s own counters first, so its first attempt isn’t counted twice.

## What each tool reports

gcovr and ReportGenerator write the same report format, but they differ in what they include.

- **Sources outside the project.** gcovr reports only files beneath its `:gcov:` ↳ `:gcovr:` ↳ `:report_root:`, which defaults to the project directory. To include sources above the project, set it to a directory that holds them all, e.g. `".."`. ReportGenerator includes every source directory in `:paths:`.
- **Functions.** The _Test Coverage_ panel lists functions when the report names them. ReportGenerator’s reports do. gcovr’s do in some versions, e.g. 8.6, and not in others, e.g. 5.0 and 7.2. Line and branch coverage appear either way.
- **Sources earlier runs built.** ReportGenerator lists every source an earlier coverage build compiled, at 0% when this run didn’t execute it. gcovr leaves those out.
- **Both tools.** With both enabled, the extension reads gcovr’s report.

## When no coverage appears

A gcov run shows no coverage for one of a few gcov reasons, beside those every plugin shares.

- **No Cobertura report configured.** A notification says to add `Cobertura` to `:gcov:` ↳ `:reports:`.
- **No report tool.** The report tool isn’t installed where Ceedling runs, or isn’t on that shell’s `PATH`. A notification names the report it expected.
- **No sources in the report.** gcovr reports only sources beneath its `:report_root:`, as above.

[coverage]: index.md
[coverage-guide]: ../../howto/code-coverage.md
[gcov-plugin]: https://docs.throwtheswitch.org/Ceedling/latest/plugins/gcov/
[gcovr]: https://gcovr.com/
[ReportGenerator]: https://reportgenerator.io/
[mixins]: ../configuration.md#ceedlingexplorermixins
[resets]: ../configuration.md#ceedlingexplorercoverageresetscounters

<br/><br/>
