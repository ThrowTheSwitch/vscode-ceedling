# Development

This document is for contributors changing the extension’s own code. It starts with the daily workflow and a pointer to the architecture, which [Architecture.md](Architecture.md) covers in full. Then it covers running and debugging locally, the VS Code tools this work relies on, validation against real Ceedling releases, the manual testing plan, and the Docker sidecar.

---

## 1. Development Workflow

Edit source on the host. Use the sidecar for everything else.

The loop is: edit, build, F5, iterate, test, commit.

Source edits happen directly on the host. They happen in your real VS Code window. Docker never touches that window.

The sidecar handles install, build, test, package, and publish. It runs in Docker. See [Section 7](#7-the-sidecar).

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

The extension connects Ceedling’s command line to VS Code’s native Testing API. A thin layer of VS Code adapters (`main.ts`, `testController.ts`, `problemMatcher.ts`, `logger.ts`) wires a pure, unit-tested core to the editor. Ceedling resolves the configuration, builds and runs the tests, and writes the reports the core reads.

[Architecture.md](Architecture.md) explains it in full:
- the modules and their layers;
- the VS Code APIs the extension builds on;
- discovery, runs, debugging, and coverage;
- the concurrency model, its locks and invariants, and the Ceedling version gates;
- the test seams.

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

## 4. VS Code Tools for This Work

A small, fixed set of VS Code tools covers nearly all of this repo’s dev and debug needs. The VS Code APIs the extension itself uses are in [Architecture.md](Architecture.md#2-the-vs-code-apis-it-builds-on).

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

## 5. Validation Against Real Ceedling

The unit and integration tests run against a simulated Ceedling. The validation suites run the engine against real Ceedling releases instead, to catch what a simulation can’t: races at real build speeds, each version’s own behavior, and real gcovr and ReportGenerator output. They aren’t part of `just test` or CI. Before a release, run `just validate-matrix`. Also run them on each new Ceedling release, and after changing the engine’s locking, its Ceedling command lines, or its coverage handling.

```sh
just validate 1.2.1                   # every suite, on Ceedling 1.2.1
just validate 1.2.0 gated             # one suite
just validate 1.1.10 stress 120 6 7   # 120 seconds, 6 operations at once, seed 7
just validate 1.2.1 probe:syscalls    # one probe
just validate /abs/ceedling-1.2.2.gem # every suite, on a local Ceedling gem
just validate-matrix 45               # every suite and probe, on each version in MATRIX
```

A suite prints what it ran and every violation it found. It exits 0 only when every check held.

`all`, the default, runs every suite in a fixed order. `stress` runs first, then again with one build root. `coverage`, `gated`, and `layout` follow. `latency` runs next, then again with a vendored Ceedling. `mixed` and `upgrade` run last. Trailing numbers go to `stress` and `coverage` only. `just validate 1.2.1 all 45` gives each of their overlap phases 45 seconds, and takes about six minutes. The default of 60 seconds takes about a minute more.

### How they run

- `just validate` compiles the tests into `out-test/` in the sidecar, then runs [`tests/validation/run.sh`](../tests/validation/run.sh) on the host. Run it from the host, not in `just shell`, since it needs Docker. `just install` must have run, to fill the `node_modules` volume.
- Compiling replaces `out-test/`, as `just test` and `just coverage` do, so run one `just validate` at a time. To run several versions at once, compile once with `just _run "npm run -s build:tests"`. Then call `tests/validation/run.sh <version> <suite>` for each.
- `run.sh` builds an image from [`sidecar/validate.Dockerfile`](../sidecar/validate.Dockerfile). For a version, it is `vscode-ceedling-validate:<version>`: `throwtheswitch/madsciencelab-plugins:<version>` plus the sidecar’s Node and `strace`. Any tag of that image works as a version.
- Every image also holds each published release’s installation under `/opt/ceedling/<version>`, for `mixed` and `upgrade` to select. The first build therefore pulls every release’s image. The Dockerfile names each release. See [On a new Ceedling release](#on-a-new-ceedling-release).
- A Ceedling `.gem` file’s path works in place of a version. Use it for a release not yet published. `run.sh` installs the gem over `CEEDLING_BASE`, which defaults to 1.2.1, and tags the image `<gem version>-<hash>`. The hash is the gem’s content hash, so a rebuilt gem never reuses an older image. Give the path absolute, since `just` runs from the repo root.
- `CEEDLING_GEM=<path>` adds a gem’s installation to `/opt/ceedling` in any version’s image, tagged `<version>-with-<hash>`. `mixed` and `upgrade` then run each older launcher against the newer application. A gem given as the version can’t also be given this way.
- `run.sh` always passes the Docker build a `gem` context, empty when there is no gem. Without one, BuildKit can reuse a gem build’s cached copy, and a plain image then holds that gem.
- `just validate-matrix [seconds]` runs [`tests/validation/matrix.sh`](../tests/validation/matrix.sh) on each version in `MATRIX`. The default is 1.0.0, 1.1.10, 1.2.0, and 1.2.1, and a `CEEDLING_GEM` gem joins as one more version. Each version runs every entry of `all`, which `run.sh <version> list` prints, then `stress` with seeds 2 and 3. From 1.2.0 it also runs each probe. Versions and runs go one at a time.
- The matrix prints each version’s failed suites and exits 1 if any suite failed. The probes judge nothing, so their output is only in the logs. Each run’s log lands in `out-validate/<timestamp>/<name>/<run>.log`, where a gem’s name is its file’s. `out-validate/` is ignored by git, and `just clean` keeps it.
- Each suite runs in a fresh container, with the repo and the `node_modules` volume mounted read-only. It copies its projects from fixtures into the container’s own `/ws` and builds them there, so nothing is left on the host.
- A suite drives the compiled `CeedlingEngine` directly, with VS Code’s side stubbed: settings, the logger, and the Problems panel. Every Ceedling command it issues is real.

### The suites

| Suite | Checks | Versions |
|---|---|---|
| `stress` | Random runs of files, functions, and projects, debug builds, discoveries, reparses, cleans, and clobbers overlap across four projects, two of them sharing a directory. A fifth are cancelled at a random moment. Each completed run must report each of its own tests once, with the outcome [`tests/manual/`](../tests/manual/) expects. Each discovery must list every project’s test files. No Ceedling process or temporary file may be left. `--shared-build-root` gives all four projects one build root. Takes seconds (60), operations at once (6), and a seed (1). | All |
| `coverage` | Exact outcomes one run at a time: gcovr preferred over ReportGenerator, counters reset or kept, a function run, a source above the project, ReportGenerator alone. Then coverage runs overlapping plain runs, discovery, reparses, and clean. Takes seconds (60), operations at once (5), and a seed (1). | All. 1.0.0’s image has no ReportGenerator, so its checks skip. |
| `gated` | The engine’s per-version command lines, on same-named test files: coverage tasks named by path from 1.2.1, or by bare name with a warning on 1.2.0. Also `:report_task:`, a changed `--test-case` filter, plain runs, and a debug build’s executable, checked against what Ceedling built. | 1.2.0 and later |
| `layout` | Exact test build directories in a project with two test roots. Each debug build must return the newest executable of its name, which is what Ceedling just built. A coverage request whose filter falls back to a whole-file rerun must give the hits of a request that ran the whole file at once. | 1.2.0 and later. Coverage from 1.2.1, since 1.2.0’s `gcov:` tasks can’t name either file. |
| `latency` | Runs a rediscovery during a full build that a slow test keeps running about 4 seconds. From 1.2.1, the rediscovery’s `dumpconfig` must start before the build ends. Before 1.2.1, the rediscovery must end after the build, since it waits for the build’s locks, as [Architecture.md](Architecture.md#discovery-without-the-locks-from-121) explains. The build’s results must be unchanged. `--vendored` first copies the image’s own Ceedling into the project’s `vendor/ceedling`, without `:which_ceedling`. `ceedling version` must then report a launcher and an application, and the copy must gate as the installed Ceedling does. | All |
| `mixed` | Each installation under `/opt/ceedling`, selected each way Ceedling allows: `:which_ceedling` in the project file or in a mixin, `WHICH_CEEDLING`, and a copy in `vendor/ceedling`. Ceedling alone first shows whether the image’s launcher can run it, and must name the installation it launches. Where it can’t, Ceedling’s own exception must reach the user. Where it can, a run’s results must match the image’s own Ceedling’s, and a rediscovery during it must list every test file. A debug build of a nested test must return the executable Ceedling just built. Before 1.2.1 the rediscovery must take the locks. From 1.2.1 the suite only prints whether it skipped them. | All |
| `upgrade` | A project built by each older installation, through `WHICH_CEEDLING`, then by the image’s own Ceedling, as after an upgrade. A debug build of a nested test must return the executable just built, never one an older layout left. Coverage must equal a clobbered build’s. Installations the launcher can’t run are skipped. | All. On 1.0.0 nothing is older. It matters most on 1.2.2, which moves each test’s build output. |

A seed replays the same sequence of operations, though not their timing, so a failure may need several runs to recur.

### The probes

The probes run Ceedling alone, without the engine, to show the Ceedling behavior the engine’s design rests on. They report what they find without judging it. Each heading in the output states what to expect. They target 1.2.0 and later, since discovery’s writes are traced through `dumpconfig --stdout`.

- `probe:fixes` shows three things. Ceedling 1.2.1’s delta builds rerun a changed `--test-case` filter ([Ceedling#1360](https://github.com/ThrowTheSwitch/Ceedling/issues/1360)). A coverage run after a counter reset still needs `--force-test-rerun`. And discovery’s commands write under `build/` before 1.2.1 ([Ceedling#1361](https://github.com/ThrowTheSwitch/Ceedling/issues/1361)).
- `probe:syscalls` traces every filesystem call `dumpconfig --stdout` and `files:test` make under a populated build root, and every write they make outside `/dev`, `/proc`, and `/tmp`. It runs as root, which `strace` needs.
- `probe:overlap` loops discovery’s commands against six clean builds in the same directory, and counts the builds that fail. Then it loops them during a `clobber` of a build root padded to 20,000 files. It reports the files `clobber` leaves and how many the next build recompiles.

### On a new Ceedling release

Each new Ceedling release needs these checks before the extension supports it, since discovery skips the engine’s locks on every release from 1.2.1.
1. Run `just validate <version>`, then `just validate <version> probe:syscalls` and `just validate <version> probe:overlap`. Before the release is published, run `CEEDLING_GEM=<path> just validate-matrix` instead. It runs every check on the gem, and every older launcher against it.
2. `probe:syscalls` must show no writes under `build/`, nor any outside `/dev`, `/proc`, and `/tmp`. `probe:overlap` must show `clobber` leaving no files outside `build/vendor/`, and the next build recompiling every file.
3. To confirm that `stress --shared-build-root` can still catch the race, temporarily make `discovering()` in `ceedlingEngine.ts` always skip the locks. Then run that suite on 1.2.0 with several seeds, where it should fail.
4. Record the release’s new features. Add each to `FIRST_RELEASES` in `ceedlingProjectConfig.ts` and to the table in [Architecture.md](Architecture.md#ceedling-versions). Update the supported range in the README, and capture `tests/fixtures/ceedling-<version>/` transcripts.
5. Once its image is published, add it to `sidecar/validate.Dockerfile`. That takes a `FROM` stage for its image and a `COPY` from that image’s Ruby gem directory. Add its version to `MATRIX`’s default in `matrix.sh` and to the versions this section names. Consider making it the `CEEDLING_BASE` default in `run.sh`.

From 1.2.2, the engine also trusts a launcher’s report of another installation’s release, which earlier launchers get wrong ([Ceedling#1365](https://github.com/ThrowTheSwitch/Ceedling/issues/1365)). Check this once on 1.2.2. Install 1.2.2 as the launcher and follow the reproduction in that issue. `ceedling version` with `WHICH_CEEDLING` must report the older application’s own version.

### Changing them

- The suites live in [`tests/validation/`](../tests/validation/), as TypeScript compiled with the tests. They typecheck against the engine and lint with the other tests.
- [`harness.ts`](../tests/validation/harness.ts) holds what the suites share:
  - the engine and its stubs;
  - `stage()`, which copies a fixture into `/ws`;
  - `capabilities()` and `requires()`, which gate a suite on the engine’s own version table, never on a version literal;
  - recording reporters;
  - `churn()` for random overlap;
  - `removeExecutables()`, `builtExecutable()`, and `executables()`, which find the executable a debug build actually wrote;
  - `rediscoverDuringBuild()`, which times a rediscovery during a full build;
  - `ceedlingAlone()`, which runs Ceedling directly with the engine’s environment;
  - the leftover check;
  - `main()`, which prints the verdict and sets the exit code.
- Fixtures live in [`tests/validation/workspaces/`](../tests/validation/workspaces/). `stress` copies [`tests/manual/`](../tests/manual/) instead.
- A new suite is a `.ts` file in `tests/validation/`. Add it to `all` in `run.sh`, which accepts only the suites `all` names. `matrix.sh` then runs it too.

## 6. Manual Testing Plan

This checklist confirms the extension’s behavior in a real VS Code, where unit and integration tests can’t reach. Run it before a release, against the final code on the integration branch, on Ceedling 1.0.0, 1.1.10, 1.2.0, and the newest 1.2 release. Run `just validate-matrix` first.

Every step runs against [`tests/manual/`](../tests/manual/), opened as its own folder in the Development Host.

- [ ] **Discovery.** The Testing view lists all three test files, confirming discovery works.
- [ ] **Run all.** In `test_calculator.c`, two tests pass, one fails, and one is ignored. Each shows the correct message. `test_add_should_HandleSpaceBeforeParen` shows as passed, not skipped.
- [ ] **Run one.** A single test runs in isolation, from its gutter icon. The Ceedling Explorer log (Trace level) shows `--test-case=` in the invocation.
- [ ] **Debug.** A breakpoint in `src/Calculator.c` is hit, from a test’s debug icon. The file’s real results show in the Testing view, including the deliberate failure. Starting a Run while the debug build is under way waits for it, then runs.
- [ ] **Cancel.** Cancel a run of `test_calculator.c` while it builds. Its tests show as skipped, not errored.
- [ ] **Ceedling 1.2.0.** On 1.2.0, rename `project.yml` to `ceedling.yml` and refresh. Discovery and runs still work. Add `test/alpha/test_dup.c` and `test/beta/test_dup.c`, each with one test. Both run and debug correctly. Run one test alone, then its whole file with nothing changed. Every test in the file reports a result. Revert after.
- [ ] **Rediscovery during a run.** Start a run of all tests, then save `project.yml` while it runs. The run completes with correct results.
- [ ] **New test file during a run (1.2.1 and later).** On the newest release, add a test file while a run of all tests is under way. The Testing view shows it before the run finishes. Delete it after.
- [ ] **Vendored Ceedling.** Run `ceedling new --local` in a scratch folder and open it. Discovery succeeds with no warning in the Ceedling Explorer log, and on 1.2.1 or later a test file added during a run appears before the run finishes.
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
- [ ] **Coverage of same-named test files.** Add `test/alpha/test_dup.c` and `test/beta/test_dup.c`, each with one test calling a different function of `src/Calculator.c`. On 1.2.1, Run with Coverage each file. Each passes and shows only its own function as executed. On 1.2.0, the same run errors with Ceedling’s ambiguous file reference error, and the Ceedling Explorer log warns about the ambiguous name. Revert after.
- [ ] **No Cobertura report.** Use `mixins/coverage-no-cobertura.yml` in place of the gcovr mixin. Run with Coverage still runs the tests. A notification says to add `Cobertura` to `:gcov:` ↳ `:reports:`. Remove the mixin setting after, and Run with Coverage disappears.

## 7. The Sidecar

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
| `just validate <version> [suite]` | Runs the validation suites against a real Ceedling release, from the host. See [Section 5](#5-validation-against-real-ceedling) |
| `just validate-matrix [seconds]` | Runs every validation suite and probe on each version in `MATRIX`, from the host. See [Section 5](#5-validation-against-real-ceedling) |
| `just package` | Produces a `.vsix` |
| `just publish` | Publishes to the Marketplace. Requires `VSCE_PAT` |
| `just shell` | Opens an interactive container session |
| `just clean` | Removes build output, the test build, and coverage reports |

---

## See also

- [Architecture.md](Architecture.md) — how the extension works, for contributors and coding agents.
- [README.md](../README.md) — end-user features and configuration.
- [CHANGELOG.md](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), [KnownIssues.md](KnownIssues.md), [BreakingChanges.md](BreakingChanges.md) — release-facing docs.
- [tests/manual/README.md](../tests/manual/README.md) — the manual test project itself.
- [sidecar/README.md](../sidecar/README.md) — the sidecar’s own fuller explanation.
- [.github/workflows/cd.yml](../.github/workflows/cd.yml) — the release process itself.
