# 🌱 Ceedling Changelog

This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

# [2.0.0] - Unreleased

## ⚠️ Changed

Migrated from the third-party [Test Explorer UI](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer) extension and `vscode-test-adapter-api` to Visual Studio Code's native Testing API. The Testing view, gutter run/debug icons, and inline failure messages are now provided natively by VS Code — the `hbenl.vscode-test-explorer` extension is no longer a dependency and may be uninstalled if you don't use it elsewhere.

Debugging a test no longer relies on the `ceedlingExplorer.debugTestExecutable` command being resolved by VS Code at an unpredictable time; the extension now resolves and substitutes the test executable path directly before starting the debug session. Existing `launch.json` configurations that use `${command:ceedlingExplorer.debugTestExecutable}` in their `program` property continue to work unchanged. This also fixes the "wrong executable path"/"No debug test executable found" class of bugs (#2). Individual-test debugging is still not supported — Ceedling always builds and runs a whole test file's executable.

## 💪 Fixed

* Multi-root workspaces no longer log a noisy error and fail the whole folder's test discovery when one folder simply isn't a Ceedling project (#4).
* Fixed a crash (`a.join is not a function`) when parsing a `TEST_CASE`/`TEST_RANGE` test containing only a single range clause (#3).
* When Ceedling fails to produce its XML test report (for example, a Ruby/Ceedling encoding exception on non-ASCII source), the captured stdout/stderr is now always shown in the Test Results output instead of a bare "file not found" (#7).
* Projects using `:test_runner: :test_prefix:` alongside Unity's default test prefix are now recognized correctly, contributed by [@Edoardo-en](https://github.com/ThrowTheSwitch/vscode-ceedling/pull/1) (PR #1).
* Added Clean/Clobber toolbar buttons to the Testing view, contributed by [@JannisRln](https://github.com/ThrowTheSwitch/vscode-ceedling/pull/8) (PR #8).

# [1.0.0] - 2025-09-14

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
