# Development

This document is for contributors changing the extension’s own code. It starts with the daily workflow and the code’s architecture. Then it covers running and debugging locally, the VS Code features this work relies on, the manual testing plan, and the Docker sidecar.

---

## 1. Development Workflow

Edit source on the host. Use the sidecar for everything else.

The loop is: edit, build, F5, iterate, test, commit.

Source edits happen directly on the host. They happen in your real VS Code window. Docker never touches that window.

The sidecar handles install, build, test, package, and publish. It runs in Docker. See [Section 6](#6-the-sidecar).

First time: run `just install`. Then press F5.

Ongoing: run `just watch` in one terminal. Press F5 to try a change. Run `just test` before committing.

### Linting and coverage

Two reports point at what to fix next: lint findings and unit-test coverage gaps. Both are report-only for now. Neither fails a build, locally or in CI.

**Linting** uses ESLint with typescript-eslint’s type-checked rules. [`eslint.config.mjs`](../eslint.config.mjs) adds rules for this codebase’s real risks. Those are unhandled promises in the extension host, needless type escapes and assertions, and synchronous `fs` calls in `src/`, which block the extension host’s thread. Tests may use `any` and unsafe casts for their test doubles.

- Run `just lint`, or `npm run lint` in `just shell`. It lists each finding with its file, line, and rule.
- A justified exception is marked where it occurs, with its reason: `// eslint-disable-next-line <rule> -- <reason>`.

**Coverage** uses c8, which reads Node’s built-in V8 coverage during the unit tests and maps it back to the TypeScript through source maps. [`.c8rc.json`](../.c8rc.json) configures it.

- Run `just coverage`, or `npm run test:coverage`. It prints a table per `src/*.ts` file: statement, branch, function, and line coverage, plus the uncovered line numbers.
- `coverage/index.html` shows each file with its uncovered lines highlighted. `coverage/lcov.info` and `coverage/coverage-summary.json` serve other tools.
- Only unit tests are measured. The VS Code adapters, `testController.ts`, `problemMatcher.ts`, `main.ts`, and `logger.ts`, show 0%. Their decisions live in tested pure modules, and what remains is wiring to the editor.

The unit tests compile into `out-test/`, apart from the extension bundle in `out/`. The test build compiles every file in `src/`, so a file no test touches still appears in the coverage table.

**In CI**, the Linux job runs both after the tests.
- Lint findings appear as annotations on the pull request’s changed lines. `setup-node`’s ESLint problem matcher turns ESLint’s output into annotations.
- The coverage table appears in the job’s summary.
- The full HTML report downloads as the `coverage-report` artifact.

## 2. Architecture

The extension connects Ceedling’s command line to VS Code’s native Testing API. It reads nothing from `project.yml` itself. Ceedling resolves the configuration, builds and runs the tests, and writes a CppUnit XML report. The extension finds tests in source exactly as Ceedling’s test runner generator does, so every reported result lands on a discovered item.

### Orientation

The code has two layers. Most modules have no `vscode` dependency and are unit-tested in plain Node. A thin layer of VS Code adapters wires them to the editor. A decision an adapter makes belongs in a pure module, where a unit test can reach it.

| Module | Layer | Responsibility |
|---|---|---|
| `src/main.ts` | VS Code | Activation, commands, one controller per workspace folder |
| `src/testController.ts` | VS Code | TestItems, run and debug profiles, watchers, and the `TestRun` sink |
| `src/problemMatcher.ts` | VS Code | Publishes diagnostics to the Problems panel’s `DiagnosticCollection` |
| `src/logger.ts` | VS Code | The “Ceedling Explorer” log output channel |
| `src/ceedlingEngine.ts` | Pure | Orchestration: discover, run, debug build, clean, clobber |
| `src/ceedlingProjectConfig.ts` | Pure | Settings → projects; resolved configuration → `ProjectState` |
| `src/ceedlingProcess.ts` | Pure | Running Ceedling, with per-run cancellation |
| `src/unityTestDiscovery.ts` | Pure | Test functions and cases in source, named as Unity names them |
| `src/testResults.ts` | Pure | The CppUnit report, mapped onto discovered ids |
| `src/runPlan.ts` | Pure | A run request → the fewest Ceedling invocations |
| `src/testModel.ts` | Pure | The test tree types, the `RunReporter` interface, and the controller’s label |
| `src/testReporting.ts` | Pure | A `RunReporter` that resolves ids to items and builds plain messages for a `RunSink` |
| `src/debugLaunch.ts` | Pure | The file a debug request debugs, and its launch configuration |
| `src/watchPolicy.ts` | Pure | What settings changes, file events, and edits make the controller do |
| `src/diagnosticsStore.ts` | Pure | Each run scope’s diagnostics, shown by file without duplicates |
| `src/singleFlight.ts` | Pure | Coalesces overlapping discovery requests into one rerun |
| `src/concurrency.ts` | Pure | Grouped concurrent mapping, a lock per key, and a limit shared by every caller |
| `src/ceedlingOutputParsing.ts` | Pure | Ceedling stdout, report names, and pretty labels |
| `src/ceedlingMixinArgs.ts` | Pure | The `--project`/`--mixin` flags for a project |
| `src/problemMatching.ts` | Pure | Compiler-output patterns and their matches |
| `src/coberturaReport.ts` | Pure | Cobertura coverage reports, each file’s candidate paths, and merging a run’s reports |

Two Ceedling constraints shape everything else. Ceedling always compiles a whole test file, and its `--test-case` filter narrows a run to one function, never to one parametrized case. Every Ceedling call for a project carries `--project project.yml`, any alternate project file and configured mixins, and last the bundled mixin [`assets/mixins/report-tests-log-factory.yml`](../assets/mixins/report-tests-log-factory.yml). That mixin enables the CppUnit report the extension reads.

### Discovery

`CeedlingTestController.refresh()` calls `CeedlingEngine.discover()`, which builds the test tree in five steps.

1. `projectsFromSettings()` turns `ceedlingExplorer.projects` and `ceedlingExplorer.mixins` into `CeedlingProject`s: key, absolute path, project file, launch configuration name, and mixins. Projects whose project file exists become the engine’s `candidates`.
2. For each candidate, `checkCeedlingVersion()` runs `ceedling version` in the project directory and requires 1.0.0 or later. `semver.coerce()` reads a build suffix such as `1.2.0-13a540f` as its release.
3. `resolveConfig()` runs `ceedling dumpconfig` with the project’s flags and parses the YAML. Ceedling 1.2.0 writes it to stdout (`--stdout`). Earlier versions write it to a uniquely named temporary file, which is then removed. `projectState()` reads the `ProjectState` from it: `buildRoot`, `reportFilename`, `testPrefix`, `testFilePrefix`, `executableExtension`, `useParamTests`, and `reportPluginEnabled`.
4. `listTestFiles()` runs `ceedling files:test` and parses its bullets with `parseFileListBullets()`. A failed listing fails discovery, naming each project whose listing failed.
5. `testFileNodes()` reads each file and calls `discoverTests(source, { testPrefix, useParamTests })`. A function’s id is `file::name`, and a case’s is `file::name(args)`, exactly the names in Ceedling’s report.

Discovery overlaps the work it safely can, since every Ceedling start costs a Ruby startup. Steps 2 through 4 run concurrently across project directories and one project at a time within a directory (`mapGrouped()`). Outcomes apply in settings order, so errors read the same however the work interleaves. Test sources are read concurrently, within one limit of 16 open reads shared by every discovery and reparse (`Limiter`), and parsed in listed order.

The engine replaces its `projects` map only after every project loads. A failed discovery throws `CeedlingLoadError` and leaves the last good map in place for runs. The controller then turns the tree into TestItems. It keeps a `PlanTarget` for each item, and item lookups per project, since ids are unique only within one project.

### Staying current

The controller keeps the tree current without polling. Its refreshes go through a `SingleFlight`, so startup, watchers, and settings changes arriving together cause one discovery plus at most one rerun.

- **Configuration files.** `CeedlingEngine.configurationFiles()` lists every file a project’s configuration can come from, existing or not: both default project files, any alternate project file, and file-path mixins. A `FileSystemWatcher` on each triggers discovery, so creating a project file in an empty folder starts one.
- **Test sources.** A watcher on each project directory’s `**/*.c` reparses a changed test file alone, through `rediscoverFile()`, with no Ceedling call. A created file that `mayBeTestFile()` accepts, or a deleted test file, triggers discovery, since only `ceedling files:test` knows the full list. `sourceEventEffect()` makes that choice.
- **Unsaved edits.** `onDidChangeTextDocument` reparses an open test file from its buffer once typing pauses, through a `Debouncer` keyed by file.
- **Settings.** `settingsChangeEffects()` decides. A change to a setting that shapes discovery, such as `projects` or `mixins`, triggers discovery. Turning problem matching off clears its diagnostics. Others apply on the next run.

The TestController itself exists only while discovery finds a project, so a folder without one adds nothing to the Testing view.

### Runs

A run turns the request into a plan, then reports each plan entry’s results.

- **Planning.** `buildRunPlan(projects, include, exclude)` returns `RunPlanEntry`s of three kinds. A `project` entry runs `test:all`. A `file` entry runs `test:<file>`. A `function` entry adds `--test-case=<name>`. Excluded items narrow the plan to function granularity at most. The reporter drops their results.
- **Running.** `runTests()` marks every id started, then takes its project directory’s lock. `buildAndRun()` deletes stale reports in `artifacts/test` and `artifacts/gcov`, runs Ceedling, appends the transcript to the run’s output, updates diagnostics, and reads the newest report.
- **Reporting.** `testResults(report, leafIds)` yields `passed`, `skipped`, `failed`, and `unreported` results. An `unreported` id gets an error naming the likely cause: discovery and Ceedling disagree about its name. With no report at all, every id errors, and the most severe compiler diagnostic leads the message. The controller’s reporter, from `createRunReporter()`, maps each id to its TestItem. It drops results for excluded items and, with a warning, for unknown ids, and turns a crash’s gdb log path into a link.
- **Edge cases.** A `--test-case` run whose report also names another function, from Ceedling’s substring filter, reruns the whole file. A cancelled run kills only its own process tree, through `CeedlingRunner`, and marks its tests skipped.

**One Ceedling command per project directory at a time.** Every Ceedling command that loads a project, `dumpconfig` and `files:test` included, rewrites the vendored Unity and CMock sources under `build/vendor/` in place. A second command in the same directory can leave a build compiling a half-written header. So `dumpconfig`, `files:test`, runs, debug builds, and clean/clobber each hold their directory’s lock (`KeyedLock`, via `inDirectory()`). `ceedling version` loads no project and needs no lock. Different directories proceed independently, so builds in separate projects may overlap.

Diagnostics are keyed by run scope: the project key for a project run, `projectKey::fileId` for a file or function run. A project run replaces its own entry and drops its files’ entries. A file run replaces its own entry and drops the project entry’s diagnostics located in that file.

### Debugging

`handleDebug()` debugs one test file. `compileForDebug()` runs the file exactly as a run does and reports its real results. It then returns the executable’s path relative to Ceedling’s test output directory. Before 1.2.0 that is `name/name<executableExtension>`. Ceedling 1.2.0 nests it under the test file’s directory within its test path, e.g. `unit/name/name<executableExtension>` for `test/unit/name.c`. That test path isn’t known, so `executableSubpath()` tries each trailing part of the file’s directory and takes the newest build. `resolveLaunchConfig()` in `debugLaunch.ts` splices that path into every `${command:ceedlingExplorer.debugTestExecutable}` in a copy of the named launch configuration. A unique `__ceedlingDebugRequest` value in that configuration identifies its debug session among any others.

### Coverage

A coverage run is an ordinary run with a `RunMode` of `coverage`. The controller creates a fresh one per request with `coverageMode()`. The Coverage profile exists while `CeedlingEngine.coverageEnabled()` is true, i.e. while some project enables Ceedling’s gcov plugin. `syncCoverageProfile()` creates or disposes it after each discovery.

- **Configuration.** `coverageState()` reads the resolved configuration. It says whether reports wait for `report:gcov`. It also lists where each enabled utility writes its Cobertura report, relative to the build root, gcovr’s first. ReportGenerator writes `ReportGenerator/Cobertura.xml`, or `ReportGenerator/Cobertura/Cobertura.xml` with several report types. `coverageProblem()` explains a project that writes no Cobertura report.
- **Building.** `commandArgs()` uses `coverageCommandArgs`. Before Ceedling 1.2.1 it passes the bare file name, since the `gcov:` task prepends the test file prefix to a name lacking it. From 1.2.1 it passes the path (`capabilitiesOf().pathQualifiedCoverageTasks`). It appends `report:gcov` when reports wait for that task. Under the directory lock, `prepareCoverage()` deletes stale Cobertura reports. Once per build directory per request, it also deletes the `.gcda` counters, and the `.gcov` files gcov writes from them, under `<build>/gcov/out`, unless `coverageResetsCounters` is off. A `--test-case` collision clears only its test’s own counters before the whole-file fallback. `readCoverage()` reads the first report present before the lock is released.
- **Paths.** Cobertura names files relative to one of its `<source>` roots, or absolutely. `reportedFiles()` gives each file a candidate per source, resolved against the project directory, where Ceedling runs the tools. The engine keeps the first candidate that exists.
- **Showing.** Each build that produced test results reports a `CoverageOutcome` through `RunReporter.coverage()`. A failed build reports one only for a configuration that can’t give coverage. `mergeCoverage()` keeps the last report per report path, and adds up reports from separate build directories. The controller adds a `FileCoverage` per file, and keeps its details in a `WeakMap` that `loadDetailedCoverage` reads. A `missing` outcome becomes a notification and a line in the run’s output.

### Test seams

`CeedlingEngine` takes its collaborators through its constructor’s `deps`. Unit tests replace each one.

- `configProvider` returns settings, normally `vscode.workspace.getConfiguration`.
- `problemMatcher` is the Problems panel adapter.
- `runner` is a `CeedlingRunner`, itself built on an injectable `exec`, `kill`, and environment.
- `fileSystem` implements `EngineFileSystem`.
- `platform` and `tmpdir` default to the host’s.

[`tests/unit/ceedlingEngine.test.ts`](../tests/unit/ceedlingEngine.test.ts) drives the engine against `FakeCeedling`, a simulated Ceedling with an in-memory filesystem. Golden fixtures captured from real Ceedling releases pin discovery and report parsing. See [`tests/fixtures/README.md`](../tests/fixtures/README.md).

The integration tests run the built extension in a real VS Code, on two workspace folders. One has no Ceedling project. The other is a temporary copy of [`tests/fixtures/workspace-fake-ceedling`](../tests/fixtures/workspace-fake-ceedling), whose `ceedlingExplorer.ceedlingCommand` runs a fake Ceedling: a Node script that answers each command from the project’s scenario file. The tests then cover the wiring that unit tests can’t:
- the tree built from discovery;
- results and failure locations in the Testing view;
- compiler errors in the Problems panel;
- cancellation;
- watchers and unsaved edits;
- the Coverage profile, and file coverage and its details reaching VS Code.

On Windows they also run the engine with Windows paths. VS Code’s API can’t read another extension’s TestItems or run results, so `activate()` returns a small handle for the tests, `CeedlingExplorerApi`. See [`tests/integration/main.ts`](../tests/integration/main.ts).

## 3. Running the Extension Locally

F5 launches a second VS Code window. This extension runs inside that window.

The launch config is named "Ceedling". It lives in `.vscode/launch.json`. It is an `extensionHost` launch.

A build must exist first. `just build` or `just watch` produces `out/src/main.js`.

To pick up a new build, reload the second window. Use Developer: Reload Window. No need to restart the debug session.

Breakpoints work directly in `src/*.ts`. The second window runs the built JS. Source maps map it back to your TypeScript.

The fast loop: keep `just watch` running, edit, Reload Window. The slow loop: a fresh F5 each time.

### Troubleshooting

Behavior looks stale: rebuild, then Reload Window.

Nothing loads: same fix.

For runtime errors and logs, check the Output channel. It is named "Ceedling Explorer". Find it in the second window. See [Viewing Extension Logs](#viewing-extension-logs) for how to control its detail.

F5 runs in development mode. Development mode adds `--verbosity debug` to test runs and debug compiles. It logs their raw stdout and stderr to that channel. A packaged install never does this.

## 4. Key VS Code Features for This Work

A small, fixed set of VS Code features covers nearly all of this repo’s dev and debug needs.

### Extension Development Host

The second window F5 opens. This extension runs under test inside it.

### Breakpoints and the Debug Console

Set breakpoints in `src/*.ts`. They hit in the Development Host.

### Viewing Extension Logs

The "Ceedling Explorer" Output channel holds this extension’s own runtime log.

Open it from the Output panel, in the second window.

The Output panel has its own level filter. It controls what you see for the channel you're viewing.

For a choice that persists, use the Command Palette instead. Run "Developer: Set Log Level...". Pick "Ceedling Explorer". Pick a level: Trace, Debug, Info, Warning, Error, or Off.

Trace shows the most detail. It includes every raw Ceedling invocation this extension makes.

Development mode adds detail of its own, on top of this. See [Section 3](#troubleshooting).

### Reload Window

Command Palette command. The fastest way to pick up a rebuild.

### Toggle Developer Tools

Command Palette command. For rendering-level issues. Rarely needed here.

### Show Running Extensions

Command Palette command. Shows activation time and CPU per extension.

This extension activates in every window, once startup finishes, or sooner in a workspace containing `project.yml` or `ceedling.yml`. Use this command to check that cost.

### The Testing View

This is the extension’s own UI under test. Open it, inside the Development Host, to see your changes.

### The Problems Panel

Shows this repo’s own TypeScript build errors. The extension has a separate problem-matching feature for Ceedling’s users. Do not confuse the two.

### Driving the Extension’s Features

Exercising the extension needs a real Ceedling project, open as its own workspace.

This repo ships one, at [`tests/manual/`](../tests/manual/).

In the Development Host: File, Open Folder, pick `tests/manual/`.

This is a separate workspace from this repo’s own root. This repo’s own `.vscode/launch.json` launches the Development Host itself, one level up. `tests/manual/`’s own `.vscode/launch.json` is what the extension uses inside that second window.

Open the Testing view. It discovers the tests in all three test files. The tree follows your edits on its own. The refresh icon forces a full rediscovery.

Run all test cases. Each shows its state.

* `test_calculator.c`: Two pass. One fails. One is ignored. `test_add_should_HandleSpaceBeforeParen` has a space before its parameter list, and it still passes.
* `test_calculator_parametrized.c`: All parameterized test cases pass. `test_add_MatrixCases` lists four `TEST_MATRIX` cases. The commented-out `test_add_CommentedOut` does not appear.

Click a single test’s gutter icon to run just that test. Ceedling still recompiles the whole file. Its `--test-case` filter narrows what runs and gets reported, not what gets built. A parametrized function’s cases always run together, since the filter selects functions, not cases.

Click a test’s debug icon to debug it. A breakpoint in `src/Calculator.c` hits through the VS Code debugger.

Try the Clean and Clobber buttons, in the Testing view’s own toolbar.

Introduce a syntax error in `test_calculator.c`. Save. Run the test again. The error lands in the Problems panel. `tests/manual/.vscode/settings.json` already enables problem matching for this. Revert the edit after.

Run `test_calculator_crash.c`. `test_should_crash` dereferences a null pointer. `project.yml`’s `:use_backtrace` ⇒ `:simple` setting catches the crash and reports it as a normal failed test at the exact crashing line instead of a bare timeout or a silently stopped run.

See [tests/manual/README.md](../tests/manual/README.md) for the `project.yml` settings the parametrized and crash tests need.

## 5. Manual Testing Plan

This checklist confirms the extension’s behavior in a real VS Code, where unit and integration tests can’t reach. Run it before a release, against the final code on the integration branch, on Ceedling 1.0.0, 1.1.10, and 1.2.0.

Every step runs against [`tests/manual/`](../tests/manual/), opened as its own folder in the Development Host.

- [ ] **Discovery.** The Testing view lists all three test files, confirming discovery works.
- [ ] **Run all.** In `test_calculator.c`, two tests pass, one fails, and one is ignored. Each shows the correct message. `test_add_should_HandleSpaceBeforeParen` shows as passed, not skipped.
- [ ] **Run one.** A single test runs in isolation, from its gutter icon. The Ceedling Explorer log (Trace level) shows `--test-case=` in the invocation.
- [ ] **Debug.** A breakpoint in `src/Calculator.c` is hit, from a test’s debug icon. The file’s real results show in the Testing view, including the deliberate failure. Starting a Run while the debug build is under way waits for it, then runs.
- [ ] **Cancel.** Cancel a run of `test_calculator.c` while it builds. Its tests show as skipped, not errored.
- [ ] **Ceedling 1.2.0.** On 1.2.0, rename `project.yml` to `ceedling.yml` and refresh. Discovery and runs still work. Add `test/alpha/test_dup.c` and `test/beta/test_dup.c`, each with one test. Both run and debug correctly. Run one test alone, then its whole file with nothing changed. Every test in the file reports a result. Revert after.
- [ ] **Rediscovery during a run.** Start a run of all tests, then save `project.yml` while it runs. The run completes with correct results.
- [ ] **Clean.** The Testing view’s Clean button clears `build/`.
- [ ] **Clobber.** The Clobber button does a harder reset. It also succeeds.
- [ ] **Problem matching.** A deliberate syntax error in `test_calculator.c` surfaces in the Problems panel. It squiggles at the error line. The Testing view’s own message for the erroring test shows the same compiler message, not a bare `stdout:` label. Revert the edit after.
- [ ] **Settings change.** Toggle `ceedlingExplorer.prettyTestLabel` to `false` in `tests/manual/.vscode/settings.json`. Labels lengthen at once, with no refresh or window reload. Revert after.
- [ ] **Live editing.** Add a test function to `test_calculator.c` without saving. It appears in the Testing view within a second. Close the file without saving. It disappears.
- [ ] **New test file.** Create `test/test_extra.c` with one test. It appears without a manual refresh. Delete it. It disappears.
- [ ] **Non-Ceedling folder.** Add a folder with no project file to the workspace. No extra entry appears in the Testing view. The Ceedling entries are labelled with their folder names.
- [ ] **Parametrized test.** All cases in `test_calculator_parametrized.c` pass, on Ceedling 1.0.0, 1.1.10, and 1.2.0. `test_add_MatrixCases` shows four cases. `test_add_CommentedOut` is not listed.
- [ ] **Crash handling.** `test_should_crash` in `test_calculator_crash.c` shows as a failed test, at the exact crashing line, on every Ceedling version.
- [ ] **Crash log link.** With Ceedling 1.1.0 or later running on a platform that supports `gdb`, set `:use_backtrace:` ⇒ `:gdb` in `project.yml` and re-run `test_should_crash`. Its failure message ends with a clickable link to the gdb log file. Revert the setting after.
- [ ] **Diagnostics don’t go stale.** Introduce a syntax error, run just `test_add_should_ReturnSum` alone from its gutter icon. Confirm the error appears in the Problems panel. Fix the error, then run the whole file (not that same test again). Confirm the Problems panel entry is gone.
- [ ] **No manual plugin setup.** `tests/manual/project.yml` deliberately leaves `report_tests_log_factory` disabled. Discovery and results still work, because the bundled mixin enables it. Every pass through this checklist confirms it.
- [ ] **Configured mixin.** Add `"ceedlingExplorer.mixins": ["gcc"]`, or another [built-in toolchain target](https://throwtheswitch.github.io/Ceedling/1.1.0/configuration/mixins/#built-in-toolchain-mixins), to `tests/manual/.vscode/settings.json`. The tree rediscovers on its own. Run all, and the run still succeeds. The Ceedling Explorer log (Trace level) shows the extra `--mixin` flag, before the extension’s own bundled mixin. Revert the setting after.
- [ ] **Missing header.** On Ceedling 1.0.0, add `#include "missing.h"` to `test_calculator.c` and run it. The Problems panel shows the error at that `#include` line, in `test_calculator.c`. Revert after.
- [ ] **Coverage with gcovr.** Without a coverage mixin, the Testing view offers no Run with Coverage. Add `"ceedlingExplorer.mixins": ["mixins/coverage-gcovr.yml"]` to `tests/manual/.vscode/settings.json`, and Run with Coverage appears. Run `test_calculator.c` with coverage. Its results match a plain run. The Test Coverage panel lists `src/Calculator.c` with a percentage. Inline coverage marks its executed and unexecuted lines. Keep the setting for the next checks.
- [ ] **Coverage of one run.** Run with coverage a single test of `test_calculator.c`, then the whole file. Each run’s hit counts reflect only that run. Set `"ceedlingExplorer.coverageResetsCounters": false`, and repeat the file run twice. The hit counts grow. Revert the setting after.
- [ ] **Coverage with ReportGenerator.** With ReportGenerator installed, use `mixins/coverage-reportgenerator.yml` in place of the gcovr mixin. Coverage shows as with gcovr, including function rows in the Test Coverage panel.
- [ ] **No Cobertura report.** Use `mixins/coverage-no-cobertura.yml` in place of the gcovr mixin. Run with Coverage still runs the tests. A notification says to add `Cobertura` to `:gcov:` ↳ `:reports:`. Remove the mixin setting after, and Run with Coverage disappears.

## 6. The Sidecar

The sidecar is Docker for everything except F5. It never touches the debug loop.

### Why it exists

Development inside a devcontainer can conflict with the debugger. A devcontainer has no display server. It has no built-in support for the second GUI window a debug launch needs.

The sidecar removes Docker from that loop entirely. F5 and VS Code always run on the host.

### What’s in the image

The image is `vscode-ceedling-sidecar`. It builds from `sidecar/Dockerfile`. It contains:

- Node 22
- Xvfb, plus the Electron libraries the integration tests need
- `just` itself

Nothing in the repo is baked into the image. Source is bind-mounted at run time. The image only needs rebuilding when `sidecar/Dockerfile` itself changes.

### How to use it

All interaction goes through the Justfile. Never call `docker` directly.

There are two modes.

**One-shot from the host.** Commands like `just build` or `just test` work the same way: start a fresh container, run one command, remove the container.

**Interactive.** `just shell` opens a live session in the same image. The same recipe names work directly inside it. `just` detects it is already in the container.

`node_modules` and the downloaded test-VS Code binary persist in named Docker volumes. They do not live in the container. They do not live in the host’s own `node_modules`.

### Most needed recipes

| Recipe | Does |
|---|---|
| `just install` | First-time setup |
| `just build` | One-shot build |
| `just watch` | Continuous rebuild on save |
| `just test` | Runs the unit suite, then the integration suite, headless via Xvfb |
| `just lint` | Reports lint findings |
| `just coverage` | Runs the unit suite with coverage, writing `coverage/index.html` |
| `just package` | Produces a `.vsix` |
| `just publish` | Publishes to the Marketplace. Requires `VSCE_PAT` |
| `just shell` | Opens an interactive container session |
| `just clean` | Removes build output, the test build, and coverage reports |

---

## See also

- [README.md](../README.md) — end-user features and configuration.
- [CHANGELOG.md](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), [KnownIssues.md](KnownIssues.md), [BreakingChanges.md](BreakingChanges.md) — release-facing docs.
- [tests/manual/README.md](../tests/manual/README.md) — the manual test project itself.
- [sidecar/README.md](../sidecar/README.md) — the sidecar’s own fuller explanation.
- [.github/workflows/cd.yml](../.github/workflows/cd.yml) — the release process itself.
