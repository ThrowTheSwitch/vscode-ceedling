# VSCode-Ceedling Changelog

This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Complemented by three other documents: [docs/ReleaseNotes.md](docs/ReleaseNotes.md), [docs/KnownIssues.md](docs/KnownIssues.md), and [docs/BreakingChanges.md](docs/BreakingChanges.md).

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
