# Architecture

This document explains how the extension works, for contributors and coding agents changing its code. Each section opens with the concepts and moves on to the exact functions, data, and invariants that implement them. [Development.md](Development.md) covers the daily workflow, local debugging, the manual testing plan, and the sidecar.

---

## 1. Overview

The extension connects Ceedling’s command line to VS Code’s native Testing API. Ceedling does the real work. It resolves the project’s configuration, lists its test files, builds and runs the tests, and writes XML reports. The extension finds the tests in source, starts the right Ceedling commands, and maps the reports back onto the tests it found. It reads nothing from `project.yml` itself.

```mermaid
flowchart LR
    subgraph VSC["VS Code"]
        TV[Testing view]
        ED[Editors and gutter icons]
        PP[Problems panel]
        CV[Coverage views]
        DB[Debugger]
    end
    subgraph AD["Adapters"]
        M[main.ts]
        TC[testController.ts]
        PM[problemMatcher.ts]
        LG[logger.ts]
    end
    subgraph CORE["Pure core"]
        EN[ceedlingEngine.ts]
        MOD[parsing, planning,<br/>reporting, concurrency]
    end
    subgraph CEED["Ceedling"]
        CLI[ceedling CLI]
        RPT[CppUnit and<br/>Cobertura reports]
    end
    TV & ED & CV & DB <--> TC
    PP <--> PM
    M --> TC
    TC --> EN
    EN --> PM
    EN --> LG
    EN --> MOD
    EN -- runs --> CLI
    CLI -- writes --> RPT
    EN -- reads --> RPT
```

### Two layers

The code has two layers. Most modules have no `vscode` dependency and are unit-tested in plain Node. A thin layer of VS Code adapters wires them to the editor. A decision an adapter makes belongs in a pure module, where a unit test can reach it.

| Module | Layer | Responsibility |
|---|---|---|
| `src/main.ts` | VS Code | Activation, commands, one controller per workspace folder |
| `src/testController.ts` | VS Code | TestItems, run, debug, and coverage profiles, watchers, and the `TestRun` sink |
| `src/problemMatcher.ts` | VS Code | Publishes diagnostics to the Problems panel’s `DiagnosticCollection` |
| `src/logger.ts` | VS Code | The “Ceedling Explorer” log output channel |
| `src/ceedlingEngine.ts` | Pure | Orchestration: discover, run, debug build, coverage, clean, clobber |
| `src/ceedlingProjectConfig.ts` | Pure | Settings → projects; resolved configuration → `ProjectState`; Ceedling version → capabilities |
| `src/ceedlingProcess.ts` | Pure | Running Ceedling, with per-run cancellation |
| `src/unityTestDiscovery.ts` | Pure | Test functions and cases in source, named as Unity names them |
| `src/testResults.ts` | Pure | The CppUnit report, mapped onto discovered ids |
| `src/coberturaReport.ts` | Pure | Cobertura coverage reports, each file’s candidate paths, and merging a run’s reports |
| `src/parsedXml.ts` | Pure | Field access into XML as `xml2js` parses it |
| `src/runPlan.ts` | Pure | A run request → the fewest Ceedling invocations |
| `src/testModel.ts` | Pure | The test tree types, the `RunReporter` interface, and the controller’s label |
| `src/testReporting.ts` | Pure | A `RunReporter` that resolves ids to items and builds plain messages for a `RunSink` |
| `src/debugLaunch.ts` | Pure | The file a debug request debugs, and its launch configuration |
| `src/watchPolicy.ts` | Pure | What settings changes, file events, and edits make the controller do |
| `src/diagnosticsStore.ts` | Pure | Each run scope’s diagnostics, shown by file without duplicates |
| `src/singleFlight.ts` | Pure | Coalesces overlapping discovery requests into one rerun |
| `src/concurrency.ts` | Pure | Grouped concurrent mapping, locks by key, and a limit shared by every caller |
| `src/ceedlingOutputParsing.ts` | Pure | Ceedling’s console output and exceptions, report names, and pretty labels |
| `src/ceedlingMixinArgs.ts` | Pure | The `--project`/`--mixin` flags for a project |
| `src/problemMatching.ts` | Pure | Compiler-output patterns and their matches |

### Two Ceedling constraints

Two Ceedling constraints shape everything else. Ceedling always compiles a whole test file, and its `--test-case` filter narrows a run to one function, never to one parametrized case. Every Ceedling call for a project carries `--project` with its project file, `project.yml` or `ceedling.yml`, then any alternate project file and configured mixins, and last the bundled mixin [`assets/mixins/report-tests-log-factory.yml`](../assets/mixins/report-tests-log-factory.yml). That mixin enables the CppUnit report the extension reads.

## 2. The VS Code APIs it builds on

The extension is a native Testing API client, plus a handful of workspace, debug, diagnostics, and window APIs. Every `vscode` call lives in the four adapter modules. Its minimum, VS Code 1.88, is the release that finalized the test coverage API.

### Activation and lifetime

VS Code activates the extension once startup finishes, or sooner in a workspace containing `project.yml` or `ceedling.yml` (`activationEvents`). `activate()` in `main.ts` creates one `CeedlingTestController` per workspace folder, keyed by folder URI. `workspace.onDidChangeWorkspaceFolders` adds and disposes them, and relabels the rest. `context.extensionMode` selects two variants. `Development` adds Ceedling debug verbosity to runs, and `Test` makes `activate()` return `CeedlingExplorerApi` for the integration tests.

### The Testing API

A `CeedlingTestController` owns at most one `vscode.TestController`, created by `tests.createTestController()` once discovery finds a project. A folder without one adds nothing to the Testing view. A failed discovery keeps the TestController, emptied, until the next discovery.

- **The tree.** `createTestItem()` builds a project item (with several projects), file items, function items, and case items. Function and case items carry a `range`, which places their gutter icons. `items.replace()` and `children.replace()` swap whole levels. A `WeakMap<TestItem, PlanTarget>` maps each item back to what it runs.
- **Handlers.** `resolveHandler` for the root, and `refreshHandler` for the refresh button, both start discovery.
- **Run profiles.** `createRunProfile()` makes three. _Run_ (`TestRunProfileKind.Run`) and _Debug_ (`TestRunProfileKind.Debug`) are defaults. _Coverage_ (`TestRunProfileKind.Coverage`) exists only while some project enables Ceedling’s gcov plugin. `syncCoverageProfile()` creates or disposes it after each discovery.
- **Runs.** `createTestRun()` starts a `TestRun`. `handleRun()` marks every planned item `enqueued()`. The controller’s reporter, which the engine reports through, calls `started()`, `passed()`, `failed()`, `skipped()`, and `errored()`. `handleRun()` calls `end()` once every entry has run. `appendOutput()` takes Ceedling’s transcript, with `\r\n` line ends, as the Test Results terminal needs.
- **Messages.** A `TestMessage` carries a failure’s `location`. A crash’s gdb log becomes a link in a `MarkdownString` message.

### The test coverage API

A coverage run hands VS Code one `FileCoverage` per source file, through `TestRun.addCoverage()`. `FileCoverage.fromDetails()` builds each from its details: a `StatementCoverage` per line, with a `BranchCoverage` per branch outcome, and a `DeclarationCoverage` per function. The Coverage profile’s `loadDetailedCoverage` returns those details when the editor shows inline coverage. VS Code asks with the same `FileCoverage` object it was given, so a `WeakMap` keyed by that object keeps each run’s details its own. Cobertura numbers lines from 1, and VS Code’s `Position` from 0.

### The debug API

Debugging builds a test file, then starts a `launch.json` configuration on its executable. `handleDebug()` reads the configurations through `workspace.getConfiguration('launch')`, splices in the executable path, and calls `debug.startDebugging()`. A unique `__ceedlingDebugRequest` value in the configuration identifies its session in `debug.onDidStartDebugSession` and `debug.onDidTerminateDebugSession`. Cancelling the run calls `debug.stopDebugging()`. The command `ceedlingExplorer.debugTestExecutable` is registered but never contributed. It throws a clear error when a user starts that launch configuration with F5, where VS Code would otherwise resolve `${command:…}` itself.

### Workspace, diagnostics, and window

The remaining APIs keep the tree current and report what happened.

| API | Used for | Where |
|---|---|---|
| `workspace.getConfiguration('ceedlingExplorer', folderUri)` | Settings, scoped to the folder | `testController.ts`, read by the engine through `configProvider` |
| `workspace.onDidChangeConfiguration`, `affectsConfiguration()` | Settings that rediscover or clear diagnostics | `onConfigurationChanged()` |
| `workspace.createFileSystemWatcher(RelativePattern)` | Configuration files and each project directory’s `**/*.c` | `updateWatchers()` |
| `workspace.onDidChangeTextDocument`, `onDidCloseTextDocument` | Reparsing unsaved edits, and dropping them on close | `scheduleReparse()`, `reparse()` |
| `languages.createDiagnosticCollection('Ceedling')` | Compiler problems in the Problems panel | `problemMatcher.ts` |
| `window.createOutputChannel(…, { log: true })` | The “Ceedling Explorer” log, at VS Code’s log level | `logger.ts` |
| `window.showWarningMessage`, `showErrorMessage`, `showInformationMessage` | Notifications, e.g. a coverage problem once a session, or a debug request naming several files | `logger.ts`, `testController.ts` |
| `window.withProgress` | Cancellable Clean and Clobber | `runTask()` |
| `commands.registerCommand` | `clean`, `clobber`, and the debug guard | `main.ts` |

`package.json` contributes the settings, the two commands, and their `view/title` buttons in the Testing view (`when: view == workbench.view.testing`).

## 3. Discovery

Discovery turns settings and Ceedling’s answers into the test tree. `CeedlingTestController.refresh()` calls `CeedlingEngine.discover()` through a `SingleFlight`. `discover()` builds the tree in five steps.

```mermaid
sequenceDiagram
    participant TC as testController
    participant EN as CeedlingEngine
    participant C as ceedling
    TC->>EN: discover()
    EN->>EN: projectsFromSettings()
    par each project directory
        EN->>C: version
        EN->>C: dumpconfig (under the project's locks before 1.2.1)
    end
    par each project directory
        EN->>C: files:test (under the project's locks before 1.2.1)
    end
    EN->>EN: read sources (16 at a time), discoverTests()
    EN-->>TC: CeedlingProjectNode[]
    TC->>TC: rebuildTree(), syncCoverageProfile(), updateWatchers()
```

1. `projectsFromSettings()` turns `ceedlingExplorer.projects` and `ceedlingExplorer.mixins` into `CeedlingProject`s: key, absolute path, project file, launch configuration name, and mixins. Projects whose project file exists become the engine’s `candidates`.
2. For each candidate, `checkCeedlingVersion()` runs `ceedling version` in the project directory and requires 1.0.0 or later. `capabilitiesOf()` turns the version into the features this extension may use. See [Ceedling versions](#ceedling-versions). `ceedling version` honors a Ceedling vendored in the directory’s `vendor/ceedling`, or `WHICH_CEEDLING`, and then reports the launcher and the application it runs apart. It never loads the project file, though. So a `:project` ↳ `:which_ceedling` there selects a Ceedling it doesn’t check. `ProjectState.whichCeedling` records that choice.
3. `resolveConfig()` runs `ceedling dumpconfig` with the project’s flags and parses the YAML. Ceedling 1.2.0 writes it to stdout (`--stdout`). Earlier versions write it to a uniquely named temporary file, which is then removed. `projectState()` reads the `ProjectState` from it: `buildRoot`, `reportFilename`, `testPrefix`, `testFilePrefix`, `executableExtension`, `useParamTests`, `reportPluginEnabled`, `coverage`, and `testPaths`.
4. Once every project has loaded, `listTestFiles()` runs `ceedling files:test` and parses its bullets with `parseFileListBullets()`. A failed listing fails discovery, naming each project whose listing failed.
5. `testFileNodes()` reads each file and calls `discoverTests(source, { testPrefix, useParamTests })`. It finds tests in source exactly as Ceedling’s test runner generator does, so every reported result lands on a discovered item. A function’s id is `file::name`, and a case’s is `file::name(args)`, exactly the names in Ceedling’s report.

Steps 2 through 4 run concurrently across project directories, one project at a time within a directory. Their outcomes apply in settings order, so errors read the same however the work interleaves. Sources are read concurrently and parsed in listed order.

The engine replaces its `projects` map only after every project loads. A failed discovery throws `CeedlingLoadError` and leaves the last good map in place for runs. The controller then turns the tree into TestItems. It keeps a `PlanTarget` for each item, and item lookups per project, since ids are unique only within one project.

### Staying current

The controller keeps the tree current without polling. Its refreshes go through the `SingleFlight`, so startup, watchers, and settings changes arriving together cause one discovery plus at most one rerun.

- **Configuration files.** `CeedlingEngine.configurationFiles()` lists every file a project’s configuration can come from, existing or not: both default project files, any alternate project file, and file-path mixins. A watcher on each triggers discovery, so creating a project file in an empty folder starts one.
- **Test sources.** A watcher on each project directory’s `**/*.c` reparses a changed test file alone, through `rediscoverFile()`, with no Ceedling call. A created file that `mayBeTestFile()` accepts, or a deleted test file, triggers discovery, since only `ceedling files:test` knows the full list. `sourceEventEffect()` makes that choice.
- **Unsaved edits.** An open test file is reparsed from its buffer once typing pauses for 400 ms, through a `Debouncer` keyed by file.
- **Settings.** `settingsChangeEffects()` decides. A change to a setting that shapes discovery, such as `projects` or `mixins`, triggers discovery. Turning problem matching off clears its diagnostics. Others apply on the next run.

## 4. Runs

A run turns the request into a plan, then reports each plan entry’s results.

```mermaid
sequenceDiagram
    participant TC as testController
    participant EN as CeedlingEngine
    participant C as ceedling
    TC->>TC: buildRunPlan(), enqueued()
    loop each plan entry, in tree order
        TC->>EN: runFile / runFunction / runProjectAll
        EN->>EN: started(), take the project's locks
        EN->>EN: delete stale reports
        EN->>C: test:FILE, with --test-case and --force-test-rerun
        C-->>EN: transcript, cppunit_tests_report.xml
        EN->>EN: diagnostics, read the report
        EN-->>TC: passed / failed / skipped / errored
    end
    TC->>TC: end()
```

- **Planning.** `buildRunPlan(projects, include, exclude)` returns `RunPlanEntry`s of three kinds. A `project` entry runs `test:all`. A `file` entry runs `test:<file>`. A `function` entry adds `--test-case=<name>`. Excluded items narrow the plan to function granularity at most. The reporter drops their results.
- **Running.** `runTests()` marks every id started, then takes its project’s locks. `buildAndRun()` deletes stale reports in `artifacts/test` and `artifacts/gcov`, runs Ceedling, appends the transcript to the run’s output, updates diagnostics, and reads the newest report.
- **Reporting.** `testResults(report, leafIds)` yields `passed`, `skipped`, `failed`, and `unreported` results. An `unreported` id gets an error naming the likely cause: discovery and Ceedling disagree about its name. With no report at all, every id errors. The Testing view shows a message’s first line, so the most severe compiler diagnostic leads the message, then Ceedling’s `EXCEPTION` block from `extractCeedlingException()`, then the transcript. The controller’s reporter, from `createRunReporter()`, maps each id to its TestItem. It drops results for excluded items and, with a warning, for unknown ids, and turns a crash’s gdb log path into a link.
- **Edge cases.** A `--test-case` run whose report also names another function, from Ceedling’s substring filter, reruns the whole file. A cancelled run kills only its own process tree, through `CeedlingRunner`, and marks its tests skipped.

Diagnostics are keyed by run scope: the project key for a project run, `projectKey::fileId` for a file or function run. A project run replaces its own entry and drops its files’ entries. A file run replaces its own entry and drops the project entry’s diagnostics located in that file. A build that outlives a rediscovery dropping its project or file publishes none, since from Ceedling 1.2.1 that rediscovery needn’t wait for it.

### Test build directories

Ceedling builds each test file in directories named for it, under `test/out`, `gcov/out`, and the rest of the build root. Debugging needs the executable there, and a coverage collision needs the counters. `testBuildName(testId, testPaths, nested)` in `ceedlingProjectConfig.ts` computes that name exactly as Ceedling does.

- **Before 1.2.0** the name is the test file’s base name, e.g. `test_foo` for `test/unit/test_foo.c`.
- **From 1.2.0** the file’s directory within its test path comes first, e.g. `unit/test_foo`. Ceedling’s `TestBuildSetup` derives it through `PathMirror.relative_subdir` over `:paths` ↳ `:test`, which `ProjectState.testPaths` holds as configured.
- **Roots.** Each test path loses a leading `+:` or `-:` and the whitespace around it. A test path with a glob (`*`, `?`, `{`, `}`) is cut back to the directory before its first glob, so `+:test/**` gives `test`. One led by a glob gives nothing. Subtractive paths count as roots too, as in Ceedling.
- **Choice.** The longest root that equals the file’s directory, or contains it, decides. A file under no root, or directly in one, builds under its base name. Paths compare as written, with backslashes read as `/`.

Ceedling itself can’t build some same-named layouts ([Ceedling#1364](https://github.com/ThrowTheSwitch/Ceedling/issues/1364)). To find a test’s own source, it searches every test file for the test’s build name. When that name ends another test file’s path, the search finds both and stops with `EXCEPTION: Ambiguous file reference`, whatever path the task named.
- With the single test path `+:test/**`, `test/test_calc.c` builds as `test_calc`, which ends `test/unit/test_calc.c`. The first file can’t be built. The second can.
- With `+:test/unit/**` and `+:extra/**`, `test/unit/test_calc.c` builds as `test_calc` and `extra/unit/test_calc.c` as `unit/test_calc`. Each name ends both paths, so neither file can be built.

`test:all` fails in both. `testBuildName()` still names every directory correctly.

### Debugging

`handleDebug()` debugs one test file. `compileForDebug()` runs the file exactly as a run does and reports its real results. It then returns the executable’s path relative to Ceedling’s test output directory. That path is `<build name>/<name><executableExtension>`, from `testBuildName()`. See [Test build directories](#test-build-directories). `resolveLaunchConfig()` in `debugLaunch.ts` splices that path into every `${command:ceedlingExplorer.debugTestExecutable}` in a copy of the named launch configuration.

### Coverage

A coverage run is an ordinary run with a `RunMode` of `coverage`. The controller creates a fresh one per request with `coverageMode()`. Its `CoverageRun` remembers which counter directories the request has already reset.

- **Configuration.** `coverageState()` reads the resolved configuration. It says whether reports wait for `report:gcov`. It also lists where each enabled utility writes its Cobertura report, relative to the build root, gcovr’s first. ReportGenerator writes `ReportGenerator/Cobertura.xml`, or `ReportGenerator/Cobertura/Cobertura.xml` with several report types. `coverageProblem()` explains a project that writes no Cobertura report.
- **Building.** `commandArgs()` uses `coverageCommandArgs`. Before Ceedling 1.2.1 it passes the bare file name, since the `gcov:` task prepends the test file prefix to a name lacking it. From 1.2.1 it passes the path. It appends `report:gcov` when reports wait for that task. Under the project’s locks, `prepareCoverage()` deletes stale Cobertura reports. Once per counter directory per request, it also deletes the `.gcda` counters, and the `.gcov` files gcov writes from them, under `<build>/gcov/out`, unless `coverageResetsCounters` is off.
- **Collisions.** A `--test-case` collision clears only its test’s own counters before the whole-file fallback. `clearTestCounters()` deletes those beneath the test’s build directory in `gcov/out`, from `testBuildName()`, so same-named test files elsewhere keep theirs.
- **Paths.** Cobertura names files relative to one of its `<source>` roots, or absolutely. `reportedFiles()` gives each file a candidate per source, resolved against the project directory, where Ceedling runs the tools. The engine keeps the first candidate that exists.
- **Showing.** Each build that produced test results reports a `CoverageOutcome` through `RunReporter.coverage()`. A failed build reports one only for a configuration that can’t give coverage. `mergeCoverage()` keeps the last report per report path, and adds up reports from separate build directories. A `missing` outcome becomes a notification and a line in the run’s output.

## 5. Concurrency

The extension overlaps work wherever Ceedling allows it, and serializes it wherever Ceedling shares state. Every Ceedling start costs a Ruby startup, so overlapping discovery across projects saves real time. But two Ceedling commands sharing a build root can corrupt each other’s builds and read each other’s reports.

### What runs at once

Each kind of work has its own bound. Each workspace folder has its own `CeedlingEngine`, so its locks and its read limit apply within that folder only.

| Work | Overlaps with | Bounded by |
|---|---|---|
| Discovery requests | Each other | `SingleFlight`: one discovery plus at most one rerun |
| Project loads and listings within a discovery | Other project directories | `mapGrouped()`: concurrent across directories, in order within one |
| Source reads | Every other read in the engine | `Limiter`: 16 open reads at once |
| Builds, cleans, and discovery before 1.2.1 | Commands for projects apart in both directory and build root | `KeyedLock`: one command per key at a time |
| Plan entries of one run request | Nothing | The controller awaits each in turn, so results arrive in tree order |
| Separate run requests | Each other | The engine’s locks |
| Discovery’s `dumpconfig` and `files:test` | Runs, debug builds, clean, and clobber, from Ceedling 1.2.1 | `mapGrouped()` alone from 1.2.1. Before, also the engine’s locks |
| Reparses of unsaved edits | Each other | `Debouncer`: the latest edit per file, after 400 ms |

```mermaid
flowchart TB
    subgraph PA["Project a (dir /ws/a, build /ws/a/build)"]
        A1["run test:x"] --> LA{{"directory:/ws/a<br/>build:/ws/a/build"}}
    end
    subgraph PB["Project b (dir /ws/b, build /ws/shared)"]
        B1["debug build of b"] --> LB{{"directory:/ws/b<br/>build:/ws/shared"}}
    end
    subgraph PC["Project c (dir /ws/c, build /ws/shared)"]
        C1["run test:y"] --> LC{{"directory:/ws/c<br/>build:/ws/shared"}}
    end
    LA -.-|"run at once"| LB
    LB ==>|"one at a time on build:/ws/shared"| LC
```

### Locks

Runs, debug builds, clean, and clobber run inside `CeedlingEngine.exclusively(project, work)`. So does clearing a test’s coverage counters, which deletes files in the build root. Before Ceedling 1.2.1, discovery’s `dumpconfig` and `files:test` do too. Each holds two keys of the engine’s `KeyedLock`.

- `directory:<pathKey(project directory)>` serializes work in one directory, where several projects may share files.
- `build:<pathKey(resolved build root)>` serializes work in one build root, which projects in different directories share when a common mixin sets `:project` ↳ `:build_root`. It is known once `dumpconfig` has resolved the project. Before 1.2.1, a rediscovery’s `dumpconfig` takes the build root the last discovery found, which any build still running uses. Its `files:test` takes the one just resolved.

The build root is where Ceedling’s shared state lives. Before Ceedling 1.2.1, every command that loads a project rewrites the vendored Unity and CMock sources under `build/vendor/` in place, so a second command can leave a build compiling a half-written header. In every version, builds in one build root share its CppUnit report, its Cobertura reports, and its coverage counters. `ceedling version` loads no project and takes no lock. From 1.2.1, discovery’s commands take no lock either, since they write nothing. See [Discovery without the locks from 1.2.1](#discovery-without-the-locks-from-121).

Before Ceedling 1.2.1, a project no discovery has loaded yet holds only its directory key, since its build root is what its `dumpconfig` is about to resolve. That first `dumpconfig` can rewrite a shared build root’s vendored sources under another project’s build. This happens only for a project added while a sibling sharing its build root runs. Taking every known build root instead would make every discovery wait behind every run.

### Invariants

The concurrency design rests on these invariants. A change that breaks one needs a new argument for safety.

1. **Every Ceedling command runs inside `exclusively()` except `version` and, from 1.2.1, discovery’s.** Callers of `buildAndRun()` hold the project’s locks. `resolveConfig()` and `listTestFiles()` run through `discovering()`, which takes the locks only before 1.2.1.
2. **Locks are taken in sorted key order.** `KeyedLock.runAll()` dedupes and sorts its keys, then takes them one at a time, so two callers never each hold a key the other waits for. Within one key, work runs in arrival order.
3. **A build reads its own reports before it releases its locks.** `buildAndRun()` deletes stale CppUnit and Cobertura reports first, and reads the new ones under the same locks, so no other build’s report can pass as this one’s.
4. **Each plan entry uses the project as it was when that entry began.** `discover()` replaces the engine’s `projects` map only after every project loads. An entry already holding its `LoadedProject` keeps its arguments, directory, and build root through a concurrent discovery, failed or not. So does a function run’s whole-file fallback. A later entry of the same request looks its project up afresh.
5. **Cancellation stops only its own work.** `CeedlingRunner` kills only the cancelled command’s process tree. Its tests end skipped, and the locks it held release in `finally`.
6. **Coverage counters reset once per counter directory per request.** `CoverageRun.resetDirectories` records each reset. Two coverage requests at once in one build root share its counters, so each may show some of the other’s coverage. The README documents this.

### Ceedling versions

Every version gate reads one table, `FIRST_RELEASES` in `ceedlingProjectConfig.ts`. It names the first Ceedling release with each feature the engine uses only where it exists. Code asks about features, never versions.

- **Reading a version.** `checkCeedlingVersion()` parses `ceedling version` with `parseCeedlingVersions()`. A project running another installation, e.g. one in `vendor/ceedling`, reports two: the launcher that `ceedlingExplorer.ceedlingCommand` starts, and the application it runs. `applicationRelease()` reduces the application’s to its release through `ceedlingRelease()`. A build suffix such as `1.2.0-13a540f`, or `1.2.1.dev`, counts as its release, though semver ranks it below. `isSupportedRelease()` compares the release with `MINIMUM_CEEDLING_VERSION`, 1.0.0. The loaded project keeps it as `LoadedProject.release`.
- **An exact release.** Before 1.2.2, a launcher reports another installation’s release as its own, with that installation’s commit ([Ceedling#1365](https://github.com/ThrowTheSwitch/Ceedling/issues/1365)). So `applicationRelease()` counts the application’s release as exact only from a 1.2.2 launcher, or when both report the same build, commit and all. Otherwise the launcher’s release stands in, `LoadedProject.exactRelease` is false, and the engine logs a warning. `reportsApplicationVersion` is the one capability read from the launcher’s release, not the project’s.
- **Gating.** `capabilitiesOf(release)` turns the release into one boolean per feature, kept as `LoadedProject.capabilities`. The engine branches on those booleans alone.
- **Messages.** Text that names a version takes it from the table, through `firstRelease()`, or from the project’s own release. The coverage warning for same-named test files in `commandArgs()` uses both.
- **Adding a gate.** A new feature needs a table entry, with a comment saying what it changes, and a row in the table below. The `capabilitiesOf` unit tests spell out every feature’s value per release, so a new entry fails them until they say what each release has. Another test checks that each feature switches on exactly at its first release.
- **Validation.** The validation suites gate on the same table, through `capabilities()` and `requires()` in `tests/validation/harness.ts`. Each run therefore checks the engine’s claims about a release against that release. The fake Ceedling in `tests/fixtures/fake-ceedling/` keeps its own version rules, since it models Ceedling, not the extension.

| Capability | From | Effect |
|---|---|---|
| `dumpconfigStdout` | 1.2.0 | `dumpconfig --stdout`, with no temporary file |
| `forceTestRerun` | 1.2.0 | Every build adds `--force-test-rerun` |
| `pathQualifiedTestTasks` | 1.2.0 | `test:` tasks take the file’s project-relative path |
| `pathQualifiedCoverageTasks` | 1.2.1 | `gcov:` tasks take the path too |
| `ceedlingYml` | 1.2.0 | `ceedling.yml` is a default project file |
| `nestedTestBuilds` | 1.2.0 | A test’s build directories nest under its directory within its test path |
| `readOnlyDiscovery` | 1.2.1 | `dumpconfig` and `files:test` run without the project’s locks |
| `reportsApplicationVersion` | 1.2.2 | A launcher’s report of another installation’s release is exact |

Ceedling 1.2.1 resolves three problems this extension works around ([#1360](https://github.com/ThrowTheSwitch/Ceedling/issues/1360), [#1361](https://github.com/ThrowTheSwitch/Ceedling/issues/1361), [#1362](https://github.com/ThrowTheSwitch/Ceedling/issues/1362)). Not every workaround can go.

- **`--force-test-rerun` stays.** Before 1.2.1, delta builds ignore a changed `--test-case` filter and report another run’s cached results. 1.2.1 resolves that, but in every version a delta build also ignores deleted coverage counters. A coverage run after a reset would then write a valid report with every hit at 0. Plain runs on 1.2.1 could drop the flag, at the cost of _Run_ reporting cached results for an unchanged test. The flag stays for both.
- **Path-qualified `gcov:` tasks are gated.** Before 1.2.1, `gcov:` tasks take a bare name. Ceedling 1.2.0 stops with an ambiguous file reference error on a same-named test file, and earlier versions may run the other one. `commandArgs()` logs a warning for that case.
- **Discovery drops the locks, and builds keep them.** See the next section.

### Discovery without the locks from 1.2.1

From Ceedling 1.2.1, discovery’s `dumpconfig` and `files:test` take none of the project’s locks, so a rediscovery never waits for a run. `discovering()` runs them directly when the project’s `readOnlyDiscovery` capability holds, and through `exclusively()` otherwise. In the `latency` validation suite on 1.2.1, a rediscovery during a 4.4-second build takes about 1.0 second, its own cost, instead of about 4.9 seconds with the locks. That suite checks both behaviors. From 1.2.1, a rediscovery during a build must finish first. Before 1.2.1, it must finish after the build (see [Development.md](Development.md#5-validation-against-real-ceedling)).

**Why it is safe from 1.2.1.** From 1.2.1, discovery writes nothing a build reads. Ceedling 1.2.1 brings `build/vendor/` up to date only for test and release builds, writes only changed files, and replaces each whole by renaming a temporary copy. Nothing discovery reads under `build/` changes its output.
- **No writes.** `probe:syscalls` traces every filesystem call both commands make under a build root populated by a full test and coverage build. On 1.2.1 neither writes anything outside `/dev`, `/proc`, and `/tmp`. They list `build/vendor/unity/src` and `build/vendor/cmock/src`, and check that other directories exist. On 1.2.0 the same commands open the 8 vendored sources for writing and truncate them. Ceedling writes a log file only with `--log` or `--logfile`, which discovery never passes.
- **Directories only.** Before the first build, discovery creates the build root’s skeleton, 20 empty directories. Builds create the same ones, and both tolerate a directory that already exists.
- **Clean and clobber.** Discovery needs no lock against them either. Ceedling lists what they delete up front, then deletes each entry on its own, ignoring failures. A discovery during either can only recreate empty directories, which the next command would create anyway. `probe:overlap` shows that a `clobber` of 20,000 padded files, overlapped by discovery, leaves nothing outside `build/vendor/` and forces a full rebuild. `stress` overlaps discovery with both.

**What the gate guards.** Each project’s own Ceedling decides, since its commands are the ones that write. A 1.2.0 project sharing a build root with a 1.2.1 project still waits for the 1.2.1 project’s builds. The version check must show that Ceedling’s release exactly, so before 1.2.2 a project vendoring another build always waits. The check can’t see a `:which_ceedling` in the project file, so `discovering()` also requires the project’s last known configuration to select no other Ceedling. A project not yet loaded therefore takes the locks for its first `dumpconfig`, and one selecting another Ceedling in its configuration always does. Without the gate, `stress --shared-build-root` on 1.2.0 caught a run compiling a half-written `unity.h`, so the suite can tell the two policies apart. On 1.2.1, with no discovery locks, it passes. `latency --vendored` checks that a copy of the installed build in `vendor/ceedling` gates as the installed one does.

**The risk.** The capability holds for every release from 1.2.1, but a later Ceedling could start writing during discovery again. [Development.md](Development.md#on-a-new-ceedling-release) lists the checks to rerun on each new release.

## 6. Test seams

The pure core is tested through injected collaborators, and the adapters through a real VS Code running a fake Ceedling.

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

The validation suites in [`tests/validation/`](../tests/validation/) run the compiled engine against real Ceedling releases in Docker, with only `configProvider`, `problemMatcher`, and the logger stubbed. The real `runner` and `fileSystem` run real Ceedling. They check what a simulation can’t: the locks under real build times and random cancellation, each version’s command lines, and real coverage reports. They run by hand, not in CI. See [Development.md](Development.md#5-validation-against-real-ceedling).
