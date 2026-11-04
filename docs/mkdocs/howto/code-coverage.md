# Measure Code Coverage

This guide adds code coverage, so _Run with Coverage_ shows which lines and branches your tests execute. It takes a coverage tool and a small mixin that enables one of Ceedling’s coverage plugins, Gcov or Bullseye. At the end, the _Test Coverage_ panel lists each source file’s coverage, and the editor marks each line’s hits.

## What you need

- A project the _Testing_ view already lists. See [Start Testing in Your Project][first-run].
- A coverage tool where Ceedling runs, from one of the plugins’ choices. [Code Coverage][choosing] compares them.
    - **gcov**, free with GCC, with a report tool, either [gcovr] or [ReportGenerator]. gcovr is the usual choice. ReportGenerator, a .NET tool, is common on Windows. Ceedling’s Gcov plugin builds its coverage tests with GCC, whatever compiler the project’s other tests use.
    - **[Bullseye]**, a commercial, licensed tool, with Ceedling 1.2.0 or later.

## Steps

1. **Install the coverage tool**, in the shell Ceedling runs in.
2. **Save a coverage mixin** as `coverage.yml` in the project’s directory, beside `project.yml`.
3. **Add the mixin** to the folder’s `.vscode/settings.json`.
4. **Run with coverage.** Choose _Run with Coverage_ for a test, a file, or the whole project in the _Testing_ view. The _Test Coverage_ panel opens with the results.

=== "Gcovr"

    Install gcovr with Python’s pip.

    ```sh
    pip install gcovr
    ```

    The mixin enables the Gcov plugin, with gcovr writing the Cobertura report the extension reads.

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

    The mixin enables the Gcov plugin, with ReportGenerator writing the Cobertura report the extension reads.

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

=== "Bullseye"

    Install Bullseye from [its download page][bullseye-download], with your license key, and put its `bin` directory on the shell’s `PATH`. Here the key comes from an environment variable, which keeps it out of the shell’s history. [Ceedling’s Bullseye licensing page][bullseye-licensing] explains each kind of license.

    ```sh
    ./install --prefix ~/bullseye --key "$BULLSEYE_LICENSE_KEY" --search "$PATH"
    export PATH=~/bullseye/bin:$PATH
    ```

    The mixin enables the Bullseye plugin, with its Cobertura report, which the extension reads.

    <!-- example: mixin coverage-bullseye -->

    ```yaml
    :plugins:
      :enabled:
        - bullseye
    :bullseye:
      :xml_report: :cobertura
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

gcovr reports only sources beneath its report root, which is the project’s directory by default. A project whose sources sit above it, e.g. in a sibling `../src`, needs a wider root. ReportGenerator includes every source directory in `:paths:` already, and Bullseye every source its builds compile.

<!-- example: mixin coverage-report-root -->

```yaml
:gcov:
  :gcovr:
    :report_root: ".."
```

### Coverage across several runs

Each coverage run shows only what it executed, since the extension clears earlier runs’ measurements first. To add each run’s coverage to the last, as Ceedling itself does, turn the reset off. It applies to either plugin.

<!-- example: settings coverage-accumulate -->

```json
{
    "ceedlingExplorer.coverageResetsCounters": false
}
```

The measurements then accumulate until `ceedling clean` or `ceedling clobber`. The _Testing_ view’s Clean button clears them.

### Reports from a separate task

A project whose plugin sets `:report_task:` to `TRUE` writes reports only from that plugin’s `report:` task. The extension adds that task to each coverage run by itself, so no other setting is needed.

With gcov, reports then come from `report:gcov`.

<!-- example: mixin coverage-report-task -->

```yaml
:gcov:
  :report_task: TRUE
```

With Bullseye, they come from `report:bullseye`.

<!-- example: mixin coverage-report-task-bullseye -->

```yaml
:bullseye:
  :report_task: TRUE
```

### Both plugins

A project may enable both plugins, each in its own mixin or together in one. The _Testing_ view then offers a profile for each, _Coverage (gcov)_ and _Coverage (Bullseye)_, and each measures through its own plugin. [Code Coverage][both] explains how they share a project.

## When no coverage appears

A coverage run that shows nothing usually says why in a notification. The usual causes are a coverage tool missing from the shell’s `PATH`, a report other than Cobertura, or, for Bullseye, a missing license. [Code Coverage][no-coverage] lists each reason and its fix.

[first-run]: first-run.md
[choosing]: ../manual/code-coverage/index.md#choosing-a-plugin
[gcovr]: https://gcovr.com/
[ReportGenerator]: https://reportgenerator.io/
[Bullseye]: ../manual/code-coverage/bullseye.md
[bullseye-download]: https://www.bullseye.com/cgi-bin/download
[bullseye-licensing]: https://docs.throwtheswitch.org/Ceedling/latest/plugins/bullseye/licensing/
[both]: ../manual/code-coverage/index.md#how-coverage-runs-work
[no-coverage]: ../manual/code-coverage/index.md#when-no-coverage-appears

<br/><br/>
