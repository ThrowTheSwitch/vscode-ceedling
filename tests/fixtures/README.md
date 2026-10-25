# Test fixtures

The unit tests check the extension against real Ceedling output, not hand-written imitations. Each fixture was captured from an actual Ceedling run or written to be run through one. A test that compares against a fixture therefore checks the extension against the Ceedling behavior users actually see.

## Layout

Fixtures are grouped by where they came from.

- `ceedling-<version>/` holds output captured from that Ceedling release: `ceedling files:test` and `ceedling version` transcripts, compiler and linker failures, and CppUnit XML reports. The unit tests usually loop over the versions they cover. The `ceedling-1.2.1/` failures were captured with Ceedling’s decorators on, so their lines carry the emoji a terminal shows.
- `source/` holds C test files. Some are read directly by discovery tests. Others are the inputs whose reports live under `ceedling-<version>/`. Each file's header comment names its reports.
- `dumpconfig/` holds `ceedling dumpconfig` output. See [its own README](dumpconfig/README.md).
- `gcovr-<version>/` and `reportgenerator-<version>/` hold Cobertura coverage reports from that tool, run by Ceedling's gcov plugin. The `cobertura-mixed-paths.xml` reports came from Ceedling 1.1.6. The `cobertura-probe.xml` reports came from `capture/capture-gcov.sh` (below).
- `capture/` holds the tools that produce new captures (below).
- `fake-ceedling/` and `workspace-fake-ceedling/` serve the integration tests. `fake-ceedling/ceedling.js` answers the commands the extension runs, as Ceedling 1.2.0 does, from the project's scenario file. Its reports follow the structure of the captured CppUnit reports, and its compiler failure is a captured one. See [its project's README](workspace-fake-ceedling/README.md).
- `workspace-without-project/` is the integration tests' folder without a Ceedling project.

## Capturing new fixtures

[`capture/capture.sh`](capture/capture.sh) runs test files through a released Ceedling in Docker. It uses the `throwtheswitch/madsciencelab-plugins:<version>` images.

```sh
tests/fixtures/capture/capture.sh 1.2.0 /tmp/out tests/fixtures/source/test_unity_parity.c
cp /tmp/out/cppunit_tests_report.xml tests/fixtures/ceedling-1.2.0/cppunit-report-unity-parity.xml
```

The script copies each file into `test/` of a minimal project ([`capture/project.yml`](capture/project.yml)). It then runs `ceedling test:all` with the extension's bundled report mixin, [`assets/mixins/report-tests-log-factory.yml`](../../assets/mixins/report-tests-log-factory.yml). The output directory receives `stdout.txt`, `stderr.txt`, and `cppunit_tests_report.xml`. Pass a source file and its header alongside a test, and Ceedling finds them in `test/` too.

The project enables `:unity` ↳ `:use_param_tests` and disables test preprocessing, so parametrized markers expand on every Ceedling version. A run under Ceedling 1.0.0 needs the latter.

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

## Golden reports

The `cppunit-report-<name>.xml` reports for `source/test_<name>.c` are golden data for test discovery. [`tests/unit/unityTestDiscovery.test.ts`](../unit/unityTestDiscovery.test.ts) and [`tests/unit/ceedlingEngine.test.ts`](../unit/ceedlingEngine.test.ts) require the names discovery produces to equal the reported names exactly, for every captured version.

When a discovery rule changes, extend the source file first. Then recapture it for 1.0.0, 1.1.10, and 1.2.0. The versions differ only in XML escaping: 1.2.0 escapes `"` as `&quot;`, and the XML parser decodes both forms to the same name.
