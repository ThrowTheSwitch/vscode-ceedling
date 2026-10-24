# VSCode-Ceedling Changelog

This document is the terse, itemized record of what changed in each release. Its format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). [docs/ReleaseNotes.md](docs/ReleaseNotes.md), [docs/KnownIssues.md](docs/KnownIssues.md), and [docs/BreakingChanges.md](docs/BreakingChanges.md) complete the set.

---

# [Unreleased]

## ⚠️ Changed

* Requires VS Code 1.88.0 or later, up from 1.74.0. VS Code 1.88.0 finalized the test coverage API that _Run with Coverage_ uses. See [BreakingChanges.md](docs/BreakingChanges.md).
* Project configuration is now resolved with Ceedling’s own `ceedling dumpconfig`, instead of the extension parsing and merging `project.yml` and any mixins itself. The extension now sees exactly the configuration a real build sees, plugin defaults included.
* `:unity` ↳ `:test_prefix` is no longer read, nor the Unity compilation defines once sniffed to select it. Neither was ever a real Ceedling option. `:test_runner` ↳ `:test_prefix` remains the way to change the test function prefix.
* A workspace folder without a Ceedling project no longer adds an empty _Ceedling_ entry to the _Testing_ view. With several workspace folders, each entry names its folder.
* Discovery checks the Ceedling version in each project’s own directory, so a project’s `:project` ↳ `:which_ceedling` is respected. It no longer runs `ceedling summary`.
* Discovery is faster in workspaces with several project directories or many test files. Projects in different directories load at the same time, and test files are read in parallel. Reading files no longer blocks VS Code’s extension host.
* Ceedling commands in different project directories may now run at the same time, e.g. a run in one project while another rediscovers. Commands within one project directory, or in projects sharing a build directory, still run one at a time.

## 🌟 Added

* Code coverage in VS Code’s own coverage views, contributed by [@jake-kim-sndk](https://github.com/jake-kim-sndk) ([PR #13](https://github.com/ThrowTheSwitch/vscode-ceedling/pull/13)). _Run with Coverage_ in the _Testing_ view runs tests through Ceedling’s gcov plugin, then shows each source file’s line, branch, and function coverage. It reads the Cobertura report from gcovr or ReportGenerator. See [Code coverage](README.md#code-coverage).
* New `ceedlingExplorer.coverageCommandArgs` and `ceedlingExplorer.coverageResetsCounters` settings, for a project’s own coverage task and for accumulating coverage across runs.
* Support for Ceedling 1.2.0:
  * A project directory may use `ceedling.yml` instead of `project.yml`. A directory holding both is reported as an error, as Ceedling itself reports it.
  * Same-named test files in different directories (e.g. `test/unit/test_foo.c` and `test/integration/test_foo.c`) each run, report, and debug correctly.
  * Project configuration is read through `ceedling dumpconfig --stdout`, without a temporary file.
  * Every run reruns its tests. Ceedling 1.2.0’s delta builds otherwise reuse cached results that ignore which single test a run selected.
* Support for Ceedling 1.2.1, whose `gcov:` tasks take a test file’s path. Coverage runs of same-named test files in different directories each run the right file.
* The `report_tests_log_factory` plugin’s `cppunit` report, which this extension reads results from, is now enabled automatically by a bundled [mixin](README.md#mixins). Enabling it in `project.yml` is no longer required.
* New `ceedlingExplorer.mixins` and `ceedlingExplorer.projects[].mixins` settings apply Ceedling mixins, for toolchain targets, CI overrides, or other configuration, without editing `project.yml`. See [Mixins](README.md#mixins).
* The _Testing_ view updates as you edit a test file, before you save. Adding or removing a test file, or editing `project.yml` or a mixin file, rediscovers the project without a manual refresh.
* Unity’s `TEST_MATRIX()` parametrized tests and exclusive `TEST_RANGE(<start, end, step>)` ranges now appear in the _Testing_ view as individual test cases.
* New `ceedlingExplorer.ceedlingCommand` setting for running Ceedling through another command, e.g. `bundle exec ceedling`.
* A one-time warning when `project.yml` or a configured mixin sets a non-default CppUnit report filename, naming the project and the filename.
* A warning in the _Ceedling Explorer_ log for a `TEST_RANGE()` with no `[start, end, step]` or `<start, end, step>` range, or a `TEST_MATRIX()` with no `[ … ]` list. Ceedling can’t build such a test.

## 💪 Fixed

* A test declared with whitespace before its parameter list, such as `void test_example (void)`, no longer stays skipped after it passes. Test discovery names each test, and each padded `TEST_CASE( … )`, exactly as Ceedling’s test runner does ([#14](https://github.com/ThrowTheSwitch/vscode-ceedling/issues/14)).
* Test discovery now follows Ceedling’s own test runner rules. Tests inside comments no longer appear in the _Testing_ view. Floating-point `TEST_RANGE()` cases carry the names Ceedling reports. Parametrized cases appear only when `:unity` ↳ `:use_param_tests` is enabled.
* A test whose result never arrives now shows an error saying so, instead of silently ending as skipped. The error names the likely cause: the extension and Ceedling disagree about the test’s name.
* Debugging a test now reports the file’s real results, instead of marking it passed when the debug session ends. A debug build no longer races a concurrent run for the shared test report.
* Cancelling a run now marks its tests skipped instead of errored, and stops only that run’s Ceedling process. Cancelling no longer crashes the extension on Linux systems without `ps`, such as minimal containers.
* _Clean_ and _Clobber_ now wait for a run in progress, instead of deleting its build.
* A failed build no longer reports results from an older run’s leftover test report.
* Saving `project.yml` while tests run no longer makes the rest of that run lose its project configuration.
* A failure Ceedling reports without a source location, or a very large test output, no longer aborts the whole run.
* A missing header now appears in the _Problems_ panel at its `#include` line. GCC reports it as a “fatal error”, which problem matching misread as a different file and line.
* Compiler problems in the _Problems_ panel no longer go stale when whole-project and single-file runs alternate.
* A compiler warning GCC places at line 0, such as a redefined command-line macro (`<command-line>:0:0`), no longer drops the other problems that run found from the _Problems_ panel.
* Running one function whose test cases have `::` in their arguments, such as `TEST_CASE("a::b")`, no longer reruns the whole file with a warning about an unrelated test.
* Two projects in one folder with the same test file path no longer mix up their results.
* Tests excluded from a run, such as hidden tests, are no longer reported.
* Ceedling 1.0.0’s encoding crash on non-ASCII source is now prevented on every platform, including macOS. The extension no longer overrides your locale to do so.
* When Ceedling can’t run at all, the error now says so and points to `ceedlingExplorer.shellPath`, instead of reporting an unsupported “version 0.0.0”.
* When Ceedling can’t list a project’s test files, an error now names the project and the settings to check, instead of the project silently showing no tests.
* Changing `ceedlingExplorer.mixins`, `ceedlingExplorer.shellPath`, or `ceedlingExplorer.ceedlingCommand` now rediscovers tests. Changing problem-matching settings no longer clears the _Problems_ panel unless problem matching is turned off.
* Pretty file labels now apply to test files at a project’s root and on Windows-style paths.
* Routine errors no longer pull the _Ceedling Explorer_ log into view and take focus.

## 👋 Removed

* The `ceedlingExplorer.testCaseMacroAliases` and `ceedlingExplorer.testRangeMacroAliases` settings. Ceedling recognizes only the literal `TEST_CASE`, `TEST_RANGE`, and `TEST_MATRIX` markers, so an alias could never produce cases Ceedling runs. See [BreakingChanges.md](docs/BreakingChanges.md).

---

# [2.0.1] — 2026-08-31

## ⚠️ Changed

Documentation improvements.

---

# [2.0.0] — 2026-08-31

## ⚠️ Changed

* Migrated from the third-party [Test Explorer UI](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer) extension and `vscode-test-adapter-api` to Visual Studio Code’s native Testing API. The Testing view, gutter run/debug icons, and inline failure messages are now provided natively by VS Code — the `hbenl.vscode-test-explorer` extension is no longer a dependency and may be uninstalled if you do not use it elsewhere.

* Debugging a test no longer relies on the `ceedlingExplorer.debugTestExecutable` command being resolved by VS Code at an unpredictable time; the extension now resolves and substitutes the test executable path directly before starting the debug session. Existing `launch.json` configurations that use `${command:ceedlingExplorer.debugTestExecutable}` in their `program` property continue to work unchanged. This also fixes the “wrong executable path”/“No debug test executable found” class of bugs ([#2](https://github.com/ThrowTheSwitch/vscode-ceedling/issues/2)). Individual-test debugging is still not supported — Ceedling always builds and runs a whole test file’s executable.

* Activation now waits for VS Code’s own startup to finish, instead of blocking it. `activationEvents` was `["*"]`, which `vsce` and VS Code both flag as a performance risk. Still activates for every window, same as before.

## 🌟 Added

* Running a single test function no longer runs and reports every test in its file. Ceedling’s own `--test-case` filter is now used for a function-level run, narrowing what runs and gets reported (Ceedling still recompiles the whole file either way). A parametrized function’s cases still run together, since Unity’s test case filtering can isolate one tet function, not one paremeterized test case within it. Falls back to a full-file run, with a logged warning, on the rare case where the filter’s substring matching also catches an unrelated test.

* A crashed test’s failure message now links directly to its gdb log file when one exists (Ceedling 1.1.0 and later, with `:use_backtrace:` ⇒ `:gdb`). Clicking it opens the log. See the new [Crashes and `:use_backtrace`](README.md#crashes-and-use_backtrace) section for background on this existing Ceedling feature and its platform tradeoffs.

## 💪 Fixed

* Multi-root workspaces no longer log a noisy error and fail the whole folder’s test discovery when one folder simply isn't a Ceedling project ([#4](https://github.com/ThrowTheSwitch/vscode-ceedling/issues/4)).

* Ceedling 1.1.0 projects no longer show zero tests in the _Testing_ view. Test discovery only recognized an older test-file listing format ([#10](https://github.com/ThrowTheSwitch/vscode-ceedling/issues/10)).

* Fixed a crash (`a.join is not a function`) when parsing a Unity parameterized `TEST_CASE()`/`TEST_RANGE()` test containing only a single range clause ([#3](https://github.com/ThrowTheSwitch/vscode-ceedling/issues/3)).

* Ceedling is now invoked with a forced UTF-8 locale (`LANG`/`LC_ALL=C.UTF-8`), fixing a Ruby encoding crash Ceedling 1.0.0 hit parsing non-ASCII source (even in comments) under a non-UTF-8 host locale; Ceedling 1.1.0 already handles this correctly on its own. When Ceedling still fails to produce its XML test report for any other reason, the captured `$stdout`/`$stderr` is always shown in the _Test Results_ output instead of a bare "file not found" ([#7](https://github.com/ThrowTheSwitch/vscode-ceedling/issues/7)).

* Projects using `:test_runner` ↳ `:test_prefix` alongside Unity’s default test prefix are now recognized correctly, contributed by [@Edoardo-en](https://github.com/Edoardo-en) ([PR #1](https://github.com/ThrowTheSwitch/vscode-ceedling/pull/1)).

* Added Clean/Clobber toolbar buttons to the _Testing_ view, contributed by [@JannisRln](https://github.com/JannisRln) ([PR #8](https://github.com/ThrowTheSwitch/vscode-ceedling/pull/8)).

* Compiler/linker problems reported via `ceedlingExplorer.problemMatching` now show as inline editor squiggles, not just entries in the Problems panel. The path passed to VS Code was relative rather than absolute, so it never matched the actually open document.

* A build failure that leaves no XML test report no longer shows as a bare `stdout:` label in the editor view with no text. The _Testing_ view’s own message for the erroring test now leads with the compiler’s actual diagnostic when `ceedlingExplorer.problemMatching` is enabled and links to its exact line.

* The `gcc` problem-matching preset now recognizes a real linker "undefined reference" error. It went unmatched on a newer `ld` toolchain, which adds a section/offset the preset's pattern did not expect.

* A Problems-panel entry found while running a single test function in isolation no longer lingers after the error is fixed and the whole file is run instead. It was stored under the function's own id, separately from the file's, and nothing ever cleared it.

* Starting a debug session from F5 or the Run and Debug panel, instead of a test's own debug icon in the Testing view, now shows a clear error explaining what to do instead of a confusing "path does not exist" failure ([#5](https://github.com/ThrowTheSwitch/vscode-ceedling/issues/5)).

---

# [1.0.0] — 2025-09-14

## 💪 Fixed

N/A

## 🌟 Added

N/A

## ⚠️ Changed

The 1.0.0 release of this VS Code extension is a fork of the orphaned _Ceedling Test Explorer_ extension [[Github][ceedling-test-explorer-github], [Marketplace][ceedling-test-explorer-marketplace]] originally authored by [Kin Numaru](https://github.com/numaru).

Ceedling 1.0.0 compatibility has been added to the original extension project by merging a [PR][1.0.0-pr] authored by [@simeon-s1](https://github.com/simeon-s1).

[ceedling-test-explorer-github]: https://github.com/numaru/vscode-ceedling-test-adapter.git
[ceedling-test-explorer-marketplace]: https://marketplace.visualstudio.com/items?itemName=numaru.vscode-ceedling-test-adapter
[1.0.0-pr]: https://github.com/numaru/vscode-ceedling-test-adapter/pull/139

## 👋 Removed

With taking over the extension and merging Ceedling 1.0.0 compatibility, support for versions preceding Ceedling 1.0.0 has been removed.
