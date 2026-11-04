# Bullseye

[Bullseye Coverage][bullseye] is a commercial code coverage tool for C and C++, from Bullseye Testing Technology. It measures function coverage and condition/decision coverage, which records whether each decision, and each condition within it, evaluated both true and false. Ceedling’s [Bullseye plugin][plugin] builds tests with Bullseye’s instrumenting compiler wrapper, and Bullseye writes the Cobertura report the extension reads.

This page covers what Bullseye coverage needs, its coverage file, what its reports include, and why a Bullseye run might show none. [Code Coverage][coverage] covers what every coverage run shares.

!!! warning "Requires a Bullseye license"

    Bullseye is commercial software, and each installation needs a license. [Ceedling’s Bullseye licensing page][licensing] explains Bullseye’s two kinds of license, and how to use Bullseye in a container.

## What Bullseye coverage needs

Bullseye coverage needs three pieces where Ceedling runs.

- **Ceedling 1.2.0 or later.** Earlier releases ship the plugin disabled, and refuse to load it.
- **A licensed Bullseye installation**, from [Bullseye’s download page][download]. Its tools must be on the `PATH` of the shell Ceedling runs in, or on the project’s `:environment` ↳ `:path`.
- **The plugin, with its Cobertura report.** The extension reads the report `:bullseye:` ↳ `:xml_report: :cobertura` writes. `:native` writes Bullseye’s own XML instead, which VS Code can’t show.

```yaml
:plugins:
  :enabled:
    - bullseye
:bullseye:
  :xml_report: :cobertura
```

A mixin keeps these settings out of `project.yml`. Save the YAML above as, e.g., `coverage.yml`, and add it to [`ceedlingExplorer.mixins`][mixins]. Every run then has the plugin available, and only coverage runs use it.

## Its coverage file

Bullseye keeps a project’s coverage in one file, `test.cov`, in the project’s directory. A build records there what it instruments, and each test run records what it executed. The file accumulates across runs until `ceedling clean` or `clobber` deletes it.

- **Resetting it.** Before a request’s first Bullseye build, the extension resets the file with Bullseye’s `covclear`, so the run shows only what it executed. `covclear` zeroes the measurements and keeps what was built, so a build that compiles nothing new still measures. With [`ceedlingExplorer.coverageResetsCounters`][resets] off, the measurements stay and add up.
- **Running `covclear`.** The extension runs `covclear` in the configured shell, with the project’s `:environment`, as Ceedling runs Bullseye’s tools. A floating license’s `:bullseye:` ↳ `:license_manager_file:` reaches it too. When `covclear` fails, or hangs for two minutes, e.g. waiting for a floating license, a notification says so. That run’s coverage then includes earlier runs’.
- **Projects sharing a directory.** Two projects in one directory, e.g. two project files, share its `test.cov`. Each one’s report then includes the other’s runs. A request resets the shared file once.

## What Bullseye reports

Bullseye’s reports differ from gcov’s in what they count and what they include.

- **Lines.** Only lines Bullseye instruments appear: function entries, decisions, and the blocks after them. Bullseye records whether each line ran, not how often, so a line that ran shows one hit.
- **Branches.** Each decision shows its true and false outcomes. Bullseye’s own reports also count each condition within a decision, e.g. `a` and `b` in `a && b`. Its condition/decision percentage can therefore differ from VS Code’s branch coverage.
- **Functions.** Each function appears with its signature, e.g. `add(int,int)`.
- **Sources.** The report lists every source the coverage file holds, including those earlier builds compiled, at 0% when this run didn’t execute them. Sources outside the project directory appear at their own paths. Test files, mocks, and the Unity, CMock, and CException frameworks are left out.
- **Deferred reports.** With `:bullseye:` ↳ `:report_task: TRUE`, the first report after a clean also includes test files and the frameworks. Ceedling leaves them out of later reports. The [Known Issues][known-issues] describe it.

## When no coverage appears

A Bullseye run shows no coverage for one of a few Bullseye reasons, beside those every plugin shares.

- **No Cobertura report configured.** A notification says to set `:bullseye:` ↳ `:xml_report:` to `:cobertura`.
- **No Bullseye where Ceedling runs.** Ceedling stops before building, saying `covc` does not exist in system search paths. The _Testing_ view shows its error.
- **No valid license.** Bullseye’s tools fail, and no report is written. `ceedling bullseye:license` reports the license’s state.
- **A coverage file deleted by hand.** A build that compiles nothing new can’t measure without it, and no report is written. Run `ceedling clean`, or the _Testing_ view’s Clean, so the next build instruments afresh.
- **Ceedling before 1.2.0.** Its plugin refuses to load, and the project’s tests don’t load either, with Ceedling’s exception.

[bullseye]: https://www.bullseye.com/
[download]: https://www.bullseye.com/cgi-bin/download
[plugin]: https://docs.throwtheswitch.org/Ceedling/latest/plugins/bullseye/
[licensing]: https://docs.throwtheswitch.org/Ceedling/latest/plugins/bullseye/licensing/
[coverage]: index.md
[mixins]: ../configuration.md#ceedlingexplorermixins
[resets]: ../configuration.md#ceedlingexplorercoverageresetscounters
[known-issues]: https://github.com/ThrowTheSwitch/vscode-ceedling/blob/master/docs/KnownIssues.md

<br/><br/>
