# Measure Code Coverage

This guide adds code coverage, so _Run with Coverage_ shows which lines and branches your tests execute. It takes a report tool and a small mixin that enables Ceedling’s gcov plugin. At the end, the _Test Coverage_ panel lists each source file’s coverage, and the editor marks each line’s hits.

## What you need

- A project the _Testing_ view already lists. See [Start Testing in Your Project][first-run].
- GCC and its `gcov`. Ceedling’s gcov plugin builds its coverage tests with GCC, whatever compiler the project’s other tests use.
- A report tool where Ceedling runs, either [gcovr] or [ReportGenerator]. gcovr is the usual choice. ReportGenerator, a .NET tool, is common on Windows.

## Steps

1. **Install the report tool**, in the shell Ceedling runs in.
2. **Save a coverage mixin** as `coverage.yml` in the project’s directory, beside `project.yml`.
3. **Add the mixin** to the folder’s `.vscode/settings.json`.
4. **Run with coverage.** Choose _Run with Coverage_ for a test, a file, or the whole project in the _Testing_ view. The _Test Coverage_ panel opens with the results.

=== "gcovr"

    Install gcovr with Python’s pip.

    ```sh
    pip install gcovr
    ```

    The mixin enables the gcov plugin, with gcovr writing the Cobertura report the extension reads.

    <!-- example: mixin coverage-gcovr -->

    ```yaml
    :plugins:
      :enabled:
        - gcov
    :gcov:
      :utilities:
        - gcovr
      :reports:
        - Cobertura
    ```

=== "ReportGenerator"

    Install ReportGenerator as a .NET global tool.

    ```sh
    dotnet tool install -g dotnet-reportgenerator-globaltool
    ```

    The mixin enables the gcov plugin, with ReportGenerator writing the Cobertura report the extension reads.

    <!-- example: mixin coverage-reportgenerator -->

    ```yaml
    :plugins:
      :enabled:
        - gcov
    :gcov:
      :utilities:
        - ReportGenerator
      :reports:
        - Cobertura
    ```

The setting applies the mixin to every project in the folder that names no mixins of its own. A mixin’s path is relative to the project’s directory.

<!-- example: settings coverage-mixin -->

```json
{
    "ceedlingExplorer.mixins": ["coverage.yml"]
}
```

A mixin keeps the plugin out of `project.yml`, so builds outside VS Code stay as they were. Every run has the plugin available, and only coverage runs use it. The same settings can go in `project.yml` instead.

## Variations

Each variation below changes one thing about the basic setup.

### Sources above the project

gcovr reports only sources beneath its report root, which is the project’s directory by default. A project whose sources sit above it, e.g. in a sibling `../src`, needs a wider root. ReportGenerator includes every source directory in `:paths:` already.

<!-- example: mixin coverage-report-root -->

```yaml
:gcov:
  :gcovr:
    :report_root: ".."
```

### Coverage across several runs

Each coverage run shows only what it executed, since the extension clears earlier runs’ counters first. To add each run’s coverage to the last, as Ceedling itself does, turn the reset off.

<!-- example: settings coverage-accumulate -->

```json
{
    "ceedlingExplorer.coverageResetsCounters": false
}
```

The counters then accumulate until `ceedling clean` or `ceedling clobber`. The _Testing_ view’s Clean button clears them.

### Reports from a separate task

A project with `:gcov:` ↳ `:report_task:` set to `TRUE` writes reports only from Ceedling’s `report:gcov` task. The extension adds that task to each coverage run by itself, so no other setting is needed.

<!-- example: mixin coverage-report-task -->

```yaml
:gcov:
  :report_task: TRUE
```

## When no coverage appears

A coverage run that shows nothing usually says why in a notification. The usual causes are a report tool missing from the shell’s `PATH`, or a report other than Cobertura. [Code Coverage][no-coverage] lists each reason and its fix.

[first-run]: first-run.md
[gcovr]: https://gcovr.com/
[ReportGenerator]: https://reportgenerator.io/
[no-coverage]: ../manual/code-coverage.md#when-no-coverage-appears

<br/><br/>
