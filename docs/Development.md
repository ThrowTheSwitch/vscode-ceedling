# Development

This document is for contributors changing this extension’s own code. It covers: the daily workflow, the code’s architecture, running and debugging locally, key VS Code features, manual testing, and the sidecar.

---

## 1. Development Workflow

Edit source on the host. Use the sidecar for everything else.

The loop is: edit, build, F5, iterate, test, commit.

Source edits happen directly on the host. They happen in your real VS Code window. Docker never touches that window.

The sidecar handles install, build, test, package, and publish. It runs in Docker. See [Section 6](#6-the-sidecar).

First time: run `just install`. Then press F5.

Ongoing: run `just watch` in one terminal. Press F5 to try a change. Run `just test` before committing.

## 2. Architecture

The extension connects Ceedling’s command line to VS Code’s native Testing API. It reads nothing from `project.yml` itself. Ceedling resolves the configuration, builds and runs the tests, and writes a CppUnit XML report. The extension finds tests in source exactly as Ceedling’s test runner generator does, so every reported result lands on a discovered item.

### Orientation

The code has two layers. Most modules have no `vscode` dependency and are unit-tested in plain Node. A thin layer of VS Code adapters wires them to the editor.

| Module | Layer | Responsibility |
|---|---|---|
| `src/main.ts` | VS Code | Activation, commands, one controller per workspace folder |
| `src/testController.ts` | VS Code | TestItems, run and debug profiles, reporting into a `TestRun` |
| `src/problemMatcher.ts` | VS Code | The Problems panel’s `DiagnosticCollection`, keyed by run scope |
| `src/logger.ts` | VS Code | The “Ceedling Explorer” log output channel |
| `src/ceedlingEngine.ts` | Pure | Orchestration: discover, run, debug build, clean, clobber |
| `src/ceedlingProjectConfig.ts` | Pure | Settings → projects; resolved configuration → `ProjectState` |
| `src/ceedlingProcess.ts` | Pure | Running Ceedling, with per-run cancellation |
| `src/unityTestDiscovery.ts` | Pure | Test functions and cases in source, named as Unity names them |
| `src/testResults.ts` | Pure | The CppUnit report, mapped onto discovered ids |
| `src/runPlan.ts` | Pure | A run request → the fewest Ceedling invocations |
| `src/testModel.ts` | Pure | The test tree types and the `RunReporter` interface |
| `src/ceedlingOutputParsing.ts` | Pure | Ceedling stdout, report names, and pretty labels |
| `src/ceedlingMixinArgs.ts` | Pure | The `--project`/`--mixin` flags for a project |
| `src/problemMatching.ts` | Pure | Compiler-output patterns and their matches |

Two Ceedling constraints shape everything else. Ceedling always compiles a whole test file, and its `--test-case` filter narrows a run to one function, never to one parametrized case. Every Ceedling call for a project carries `--project project.yml`, any alternate project file and configured mixins, and last the bundled mixin [`assets/mixins/report-tests-log-factory.yml`](../assets/mixins/report-tests-log-factory.yml). That mixin enables the CppUnit report the extension reads.

### Discovery

`CeedlingTestController.refresh()` calls `CeedlingEngine.discover()`, which builds the test tree in five steps.

1. `projectsFromSettings()` turns `ceedlingExplorer.projects` and `ceedlingExplorer.mixins` into `CeedlingProject`s: key, absolute path, project file, launch configuration name, and mixins. Projects whose project file exists become the engine’s `candidates`. Their project files are watched even when discovery fails.
2. For each candidate, `checkCeedlingVersion()` runs `ceedling version` in the project directory and requires 1.0.0 or later. `semver.coerce()` reads a build suffix such as `1.2.0-13a540f` as its release.
3. `resolveConfig()` runs `ceedling dumpconfig <temp file>` with the project’s flags and parses the YAML. `projectState()` reads the `ProjectState` from it: `buildRoot`, `reportFilename`, `testPrefix`, `testFilePrefix`, `executableExtension`, `useParamTests`, and `reportPluginEnabled`.
4. `listTestFiles()` runs `ceedling files:test` and parses its bullets with `parseFileListBullets()`.
5. `testFileNodes()` reads each file and calls `discoverTests(source, { testPrefix, useParamTests })`. A function’s id is `file::name`, and a case’s is `file::name(args)`, exactly the names in Ceedling’s report.

The engine replaces its `projects` map only after every project loads. A failed discovery throws `CeedlingLoadError` and leaves the last good map in place for runs. The controller then turns the tree into TestItems. It keeps a `PlanTarget` for each item, and item lookups per project, since ids are unique only within one project.

### Runs

A run turns the request into a plan, then reports each plan entry’s results.

- **Planning.** `buildRunPlan(projects, include, exclude)` returns `RunPlanEntry`s of three kinds. A `project` entry runs `test:all`. A `file` entry runs `test:<file>`. A `function` entry adds `--test-case=<name>`. Excluded items narrow the plan to function granularity at most. The reporter drops their results.
- **Running.** `runTests()` marks every id started, then takes the engine’s mutex. `buildAndRun()` deletes stale reports in `artifacts/test` and `artifacts/gcov`, runs Ceedling, appends the transcript to the run’s output, updates diagnostics, and reads the newest report.
- **Reporting.** `testResults(report, leafIds)` yields `passed`, `skipped`, `failed`, and `unreported` results. An `unreported` id gets an error naming the likely cause: discovery and Ceedling disagree about its name. With no report at all, every id errors, and the most severe compiler diagnostic leads the message.
- **Edge cases.** A `--test-case` run whose report also names another function, from Ceedling’s substring filter, reruns the whole file. A cancelled run kills only its own process tree, through `CeedlingRunner`, and marks its tests skipped.

Diagnostics are keyed by run scope: the project key for a project run, `projectKey::fileId` for a file or function run. A project run replaces its own entry and drops its files’ entries. A file run replaces its own entry and drops the project entry’s diagnostics located in that file.

### Debugging

`handleDebug()` debugs one test file. `compileForDebug()` runs the file exactly as a run does and reports its real results. It then returns the executable’s path relative to Ceedling’s test output directory, `name/name<executableExtension>`. `resolveLaunchConfig()` splices that path into every `${command:ceedlingExplorer.debugTestExecutable}` in the named launch configuration. A unique `__ceedlingDebugRequest` value in that configuration identifies its debug session among any others.

### Test seams

`CeedlingEngine` takes its collaborators through its constructor’s `deps`. Unit tests replace each one.

- `configProvider` returns settings, normally `vscode.workspace.getConfiguration`.
- `problemMatcher` is the Problems panel adapter.
- `runner` is a `CeedlingRunner`, itself built on an injectable `exec`, `kill`, and environment.
- `fileSystem` implements `EngineFileSystem`.
- `platform` and `tmpdir` default to the host’s.

[`tests/unit/ceedlingEngine.test.ts`](../tests/unit/ceedlingEngine.test.ts) drives the engine against `FakeCeedling`, a simulated Ceedling with an in-memory filesystem. Golden fixtures captured from real Ceedling releases pin discovery and report parsing. See [`tests/fixtures/README.md`](../tests/fixtures/README.md).

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

This extension activates on every window. Its `activationEvents` is `["onStartupFinished"]`. Use this command to check that cost.

### The Testing View

This is the extension’s own UI under test. Open it, inside the Development Host, to see your changes.

### The Problems Panel

Shows this repo’s own TypeScript build errors. The extension has a separate problem-matching feature for Ceedling’s users. Do not confuse the two.

### Driving the Extension’s Features

Exercising the extension needs a real Ceedling project, open as its own workspace.

This repo ships one, at [`tests/manual/`](../tests/manual/).

In the Development Host: File, Open Folder, pick `tests/manual/`.

This is a separate workspace from this repo’s own root. This repo’s own `.vscode/launch.json` launches the Development Host itself, one level up. `tests/manual/`’s own `.vscode/launch.json` is what the extension uses inside that second window.

Open the Testing view. It discovers the tests in `test_calculator.c` and `test_calculator_parametrized.c`.

Click the refresh icon to re-discover after an edit.

Run all test cases. Each shows its state.

* `test_calculator.c`: Two pass. One fails. One is ignored. `test_add_should_HandleSpaceBeforeParen` has a space before its parameter list, and it still passes.
* `test_calculator_parametrized.c`: All parameterized test cases pass. `test_add_MatrixCases` lists four `TEST_MATRIX` cases. The commented-out `test_add_CommentedOut` does not appear.

Click a single test’s gutter icon to run just that test. Ceedling still recompiles the whole file — `--test-case` narrows what runs and gets reported, not what gets built. A parametrized function’s cases always run together; Ceedling’s filter can isolate one function, not one case within it.

Click a test’s debug icon to debug it. A breakpoint in `src/Calculator.c` hits through the VS Code debugger.

Try the Clean and Clobber buttons, in the Testing view’s own toolbar.

Introduce a syntax error in `test_calculator.c`. Save. Run the test again. The error lands in the Problems panel. `tests/manual/.vscode/settings.json` already enables problem matching for this. Revert the edit after.

Run `test_calculator_crash.c`. `test_should_crash` dereferences a null pointer. `project.yml`’s `:use_backtrace` ⇒ `:simple` setting catches the crash and reports it as a normal failed test at the exact crashing line instead of a bare timeout or a silently stopped run.

See [tests/manual/README.md](../tests/manual/README.md) for the `project.yml` settings the parametrized and crash tests need.

## 5. Manual Testing Plan

This is a repeatable checklist. Run it after a change that could affect the extension’s runtime behavior.

All steps run against [`tests/manual/`](../tests/manual/), opened as its own folder in the Development Host.

- [ ] **Discovery.** The Testing view lists all test files. Confirms parsing and discovery both work.
- [ ] **Run all.** In `test_calculator.c`, two tests pass, one fails, and one is ignored. Each shows the correct message. `test_add_should_HandleSpaceBeforeParen` shows as passed, not skipped.
- [ ] **Run one.** A single test runs in isolation, from its gutter icon. The Ceedling Explorer log (Trace level) shows `--test-case=` in the invocation.
- [ ] **Debug.** A breakpoint in `src/Calculator.c` is hit, from a test’s debug icon. The file’s real results show in the Testing view, including the deliberate failure. Starting a Run while the debug build is under way waits for it, then runs.
- [ ] **Cancel.** Cancel a run of `test_calculator.c` while it builds. Its tests show as skipped, not errored.
- [ ] **Ceedling 1.2.0.** On 1.2.0, rename `project.yml` to `ceedling.yml` and refresh. Discovery and runs still work. Add `test/alpha/test_dup.c` and `test/beta/test_dup.c`, each with one test. Both run and debug correctly. Run one test alone, then its whole file with nothing changed. Every test in the file reports a result. Revert after.
- [ ] **Rediscovery during a run.** Start a run of all tests, then save `project.yml` while it runs. The run completes with correct results.
- [ ] **Clean.** The Testing view’s Clean button clears `build/`.
- [ ] **Clobber.** The Clobber button does a harder reset. It also succeeds.
- [ ] **Problem matching.** A deliberate syntax error in `test_calculator.c` surfaces in the Problems panel. It squiggles at the error line. The Testing view’s own message for the erroring test shows the same compiler message, not a bare `stdout:` label. Revert the edit after.
- [ ] **Settings change.** Toggle `ceedlingExplorer.prettyTestLabel` to `true` in `tests/manual/.vscode/settings.json`. Refresh. Labels shorten. No full window reload was needed.
- [ ] **Parametrized test.** All cases in `test_calculator_parametrized.c` pass, on Ceedling 1.0.0, 1.1.10, and 1.2.0. `test_add_MatrixCases` shows four cases. `test_add_CommentedOut` is not listed.
- [ ] **Crash handling.** `test_should_crash` in `test_calculator_crash.c` shows as a failed test, at the exact crashing line, on both Ceedling 1.0.0 and 1.1.0.
- [ ] **Crash log link.** With Ceedling 1.1.0 running on a platform that supports `gdb`, set `:use_backtrace:` ⇒ `:gdb` in `project.yml` and re-run `test_should_crash`. Its failure message ends with a clickable link to the gdb log file. Revert the setting after.
- [ ] **Diagnostics don’t go stale.** Introduce a syntax error, run just `test_add_should_ReturnSum` alone from its gutter icon. Confirm the error appears in the Problems panel. Fix the error, then run the whole file (not that same test again). Confirm the Problems panel entry is gone.
- [ ] **No manual plugin setup.** `tests/manual/project.yml` deliberately does not enable `report_tests_log_factory` itself. Discovery and results still work — the bundled mixin enables it. Confirms this on every run of this checklist, not just once.
- [ ] **Configured mixin.** Add `"ceedlingExplorer.mixins": ["gcc"]` (or another [built-in toolchain target](https://throwtheswitch.github.io/Ceedling/1.1.0/configuration/mixins/#built-in-toolchain-mixins)) to `tests/manual/.vscode/settings.json`. Refresh, run all. The run still succeeds; the Ceedling Explorer log (Trace level) shows the extra `--mixin` flag in the invocation, before the extension’s own bundled mixin. Revert the setting after.

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
| `just package` | Produces a `.vsix` |
| `just publish` | Publishes to the Marketplace. Requires `VSCE_PAT` |
| `just shell` | Opens an interactive container session |
| `just clean` | Removes build output |

---

## See also

- [README.md](../README.md) — end-user features and configuration.
- [CHANGELOG.md](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), [KnownIssues.md](KnownIssues.md), [BreakingChanges.md](BreakingChanges.md) — release-facing docs.
- [tests/manual/README.md](../tests/manual/README.md) — the manual test project itself.
- [sidecar/README.md](../sidecar/README.md) — the sidecar’s own fuller explanation.
- [.github/workflows/cd.yml](../.github/workflows/cd.yml) — the release process itself.
