# Test fixtures

The unit tests check the extension against real Ceedling output, not hand-written imitations. Each fixture was captured from an actual Ceedling run or written to be run through one. A test that compares against a fixture therefore checks the extension against the Ceedling behavior users actually see.

## Layout

Fixtures are grouped by where they came from.

- `ceedling-<version>/` holds output captured from that Ceedling release: `ceedling files:test`, `ceedling version`, and `test:all` transcripts, compiler and linker failures, and CppUnit XML reports. The unit tests usually loop over the versions they cover. The `ceedling-1.2.1/` failures were captured with Ceedling’s decorators on, so their lines carry the emoji a terminal shows. `ceedling-1.2.1/` also holds two `version-vendored-*` transcripts of `ceedling version`, run in a project with another Ceedling copied into `vendor/ceedling`. `version-vendored-stdout.txt` vendors a copy of the 1.2.1 gem. `version-vendored-1.2.0-stdout.txt` vendors the 1.2.0 gem, copied out of the 1.2.0 image. Its `Ceedling App` line shows the misreport of [Ceedling#1365](https://github.com/ThrowTheSwitch/Ceedling/issues/1365), 1.2.1 with 1.2.0’s commit. `capture.sh` doesn’t make these. They were run by hand in the 1.2.1 image. `test-stdout.txt`, from `capture.sh`, is a `test:all` of `source/test_whitespace.c`.
- `ceedling-1.2.2/` came from Ceedling 1.2.2’s gem, which its image keeps at `/var/lib/gems/3.3.0/cache/ceedling-1.2.2.gem`. `CAPTURE_PRIOR=1` needs a gem; the other captures run as well from the image itself:
  - `cppunit-report-unity-parity.xml` from `source/test_unity_parity.c`;
  - `files-test-stdout.txt` from `source/test_whitespace.c` with `CAPTURE_TASK=files:test`, and `files-test-handoff-stdout.txt` with `CAPTURE_VENDOR=1` as well;
  - `cppunit-report-crash.xml` from `source/test_crash.c`, with a mixin setting `:use_backtrace: :gdb`;
  - `test-upgrade-stdout.txt` from `source/test_whitespace.c` with `CAPTURE_PRIOR=1`, the first build after 1.2.1, with Ceedling’s layout upgrade warning;
  - `compile-diagnostics-stderr.txt` from `source/test_diagnostics.c`, run from the image with `CAPTURE_MIXIN` naming a mixin that adds `-Wall` to `:flags:` ↳ `:test:` ↳ `:compile:` ↳ `:*:`. GCC reports a warning, an error, and the notes explaining the error;
  - `link-failure-stderr.txt` from `source/test_unlinked.c` and `source/unlinked.h`, run from the image. The GNU linker reports an undefined reference.

  [`tests/unit/docsExamples.test.ts`](../unit/docsExamples.test.ts) runs the How-To guides’ problem-matching examples against the last two.
- `clang-19.1/diagnostics-stderr.txt` holds Clang 19.1’s own output, not Ceedling’s, for a compile with `-Wall` and a link with an undefined reference. It was run by hand in the 1.2.2 image, with Debian’s `clang` installed, as `clang -Wall -c warn.c` and `clang -g link.c`. Both inputs sit beside it. [`tests/unit/problemMatching.test.ts`](../unit/problemMatching.test.ts) checks that the `gcc` preset reads it.
- `source/` holds C test files. Some are read directly by discovery tests. Others are the inputs whose reports live under `ceedling-<version>/`. Each file's header comment names its reports.
- `dumpconfig/` holds `ceedling dumpconfig` output. See [its own README](dumpconfig/README.md).
- `gcovr-<version>/` and `reportgenerator-<version>/` hold Cobertura coverage reports from that tool, run by Ceedling's gcov plugin. The `cobertura-mixed-paths.xml` reports came from Ceedling 1.1.6. The `cobertura-probe.xml` reports came from `capture/capture-gcov.sh` (below).
- `bullseye-<version>/` holds Bullseye Coverage's own reports, run by Ceedling 1.2.2's Bullseye plugin through `capture/capture-bullseye.sh` (below). `ceedling-1.2.2/dumpconfig-bullseye-*.yml` came from the same capture.
- `capture/` holds the tools that produce new captures (below).
- `fake-ceedling/` and `workspace-fake-ceedling/` serve the integration tests. `fake-ceedling/ceedling.js` answers the commands the extension runs, as Ceedling 1.2.0 does, from the project's scenario file. Its reports follow the structure of the captured CppUnit reports, and its compiler failure is a captured one. See [its project's README](workspace-fake-ceedling/README.md).
- `workspace-without-project/` is the integration tests' folder without a Ceedling project.

## Capturing new fixtures

[`capture/capture.sh`](capture/capture.sh) runs test files through a Ceedling release’s image in Docker, or through a Ceedling gem installed over one. It uses the `throwtheswitch/madsciencelab-plugins:<version>` images. An absolute path to a `.gem` file works in place of a version, e.g. for a release not yet published. The script installs it over 1.2.1’s image.

```sh
tests/fixtures/capture/capture.sh 1.2.0 /tmp/out tests/fixtures/source/test_unity_parity.c
cp /tmp/out/cppunit_tests_report.xml tests/fixtures/ceedling-1.2.0/cppunit-report-unity-parity.xml
```

The script copies each file into `test/` of a minimal project ([`capture/project.yml`](capture/project.yml)). It then runs `ceedling test:all` with the extension's bundled report mixin, [`assets/mixins/report-tests-log-factory.yml`](../../assets/mixins/report-tests-log-factory.yml). The output directory receives `stdout.txt`, `stderr.txt`, and `cppunit_tests_report.xml`. Pass a source file and its header alongside a test, and Ceedling finds them in `test/` too.

The project enables `:unity` ↳ `:use_param_tests` and disables test preprocessing, so parametrized markers expand on every Ceedling version. A run under Ceedling 1.0.0 needs the latter.

Four environment variables vary the run.
- `CAPTURE_TASK` replaces `test:all`, e.g. with `files:test`.
- `CAPTURE_MIXIN` names a mixin file to apply too, e.g. one setting `:use_backtrace: :gdb`.
- `CAPTURE_VENDOR=1` copies the running Ceedling into the project’s `vendor/ceedling`. Ceedling then hands off to that copy, as to any other installation. From 1.2.2 it says so on stdout.
- `CAPTURE_PRIOR=1`, with a gem, first builds the project with 1.2.1, as a project upgraded from it.

### Coverage reports

[`capture/capture-gcov.sh`](capture/capture-gcov.sh) runs Ceedling's gcov plugin against [`capture/gcov-probe/`](capture/gcov-probe), using the gcov, gcovr, and ReportGenerator in the same Docker image.

```sh
tests/fixtures/capture/capture-gcov.sh 1.2.0 /tmp/out
cp /tmp/out/single/gcovr/GcovCoverageCobertura.xml tests/fixtures/gcovr-7.2/cobertura-probe.xml
cp /tmp/out/single/ReportGenerator/Cobertura.xml tests/fixtures/reportgenerator-5.5.11/cobertura-probe.xml
cp /tmp/out/dumpconfig-gcov-*.yml tests/fixtures/ceedling-1.2.0/
```

The probe's Ceedling project has `src/Calculator.c` inside it and `../lib/Clamp.c` above it, so the reports show both kinds of path. Its mixins select the variants.
- `both.yml` enables gcovr and ReportGenerator with a Cobertura report.
- `multi.yml` adds an HTML report, which moves ReportGenerator's Cobertura report into a `Cobertura/` subdirectory.
- `filename.yml` renames gcovr's report.
- `task.yml` defers reports to the `report:gcov` task.

[`reportgenerator-5.5.11/artifacts-listing.txt`](reportgenerator-5.5.11/artifacts-listing.txt) lists the files each variant left under `build/artifacts/gcov`, showing where each tool writes its report. The output's `versions.txt` names the gcovr and ReportGenerator versions, which name the fixture directories. The first capture used gcovr 7.2 and ReportGenerator 5.5.11. With its default `:report_root: "."`, gcovr 7.2 leaves `../lib/Clamp.c` out of its report. ReportGenerator includes it.

### Bullseye reports

[`capture/capture-bullseye.sh`](capture/capture-bullseye.sh) runs Ceedling's Bullseye plugin against [`capture/bullseye-probe/`](capture/bullseye-probe) in a release's image. Bullseye Coverage is commercial and can't live in an image, so the script installs it into its throwaway container from your installer and license key. Nothing of it outlives the container. Its output has license numbers and the key redacted, so it can be committed.

```sh
BULLSEYE_LICENSE_KEY=... tests/fixtures/capture/capture-bullseye.sh 1.2.2 ~/Downloads/BullseyeCoverage-9.27.1 /tmp/out
cp /tmp/out/cobertura-cumulative.xml tests/fixtures/bullseye-9.27.1/cobertura-probe.xml
cp /tmp/out/cobertura-after-clear.xml tests/fixtures/bullseye-9.27.1/cobertura-cleared.xml
cp /tmp/out/native.xml tests/fixtures/bullseye-9.27.1/native-probe.xml
cp /tmp/out/dumpconfig-bullseye-*.yml tests/fixtures/ceedling-1.2.2/
```

The probe follows the gcov probe, with `src/Calculator.c` inside the project and `../lib/Clamp.c` above it. `test_add` calls `add` three times, so a report shows whether Bullseye counts hits. `test_add_more` shares `test_add`'s prefix, so `--test-case=test_add` selects both. `both()`'s `a && b` gives a decision with two conditions. Its mixins select the variants.
- `cobertura.yml`, `native.yml`, and `task.yml` choose the XML report, and defer reports to `report:bullseye`.
- `license-manager.yml` names a floating license's manager file, and `env-path.yml` sets `:environment` ↳ `:path`, for the dumpconfigs.
- `both-plugins.yml` enables gcov beside Bullseye, and `other-root.yml` builds a second project in the same directory under `build2`.

Each experiment's command, exit status, and output land in the output's `steps/`, one file each, and each report it leaves beside them. The design the extension rests on came from these.
- `covclear -q --file test.cov` resets the measurements and keeps the instrumentation, and a delta build that compiles nothing then measures again. It fails on a missing file.
- Bullseye's Cobertura names sources relative to its one `<source>`, the project directory, and marks each line run or not, at most one hit. A filtered run followed by its whole file measures what the whole file does alone.
- The report covers the whole coverage file, so each later report includes earlier runs', and two projects in one directory share them.
- The CppUnit report lands in `artifacts/bullseye/`, and dumpconfig's `:environment` holds the plugin's `COVFILE` and `COVLM`.
- A deferred report after a clean includes test files and the frameworks, which later reports leave out.

## Golden reports

The `cppunit-report-<name>.xml` reports for `source/test_<name>.c` are golden data for test discovery. [`tests/unit/unityTestDiscovery.test.ts`](../unit/unityTestDiscovery.test.ts) and [`tests/unit/ceedlingEngine.test.ts`](../unit/ceedlingEngine.test.ts) require the names discovery produces to equal the reported names exactly, for every captured version.

When a discovery rule changes, extend the source file first. Then recapture it for 1.0.0, 1.1.10, 1.2.0, and 1.2.2. The versions differ only in XML escaping. From 1.2.0, Ceedling escapes `"` as `&quot;`, and the XML parser decodes both forms to the same name.
