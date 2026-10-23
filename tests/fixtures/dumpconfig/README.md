# `dumpconfig` fixtures

Real `ceedling dumpconfig` output, captured against a copy of
[`tests/manual`](../../manual), with `report_tests_log_factory` removed from its
`project.yml`. Captured with Ceedling **1.1.8** (a released version within this
extension's supported range).

- `manual-project-no-report-plugin.yml` — `ceedling dumpconfig` with no `--mixin`.
  `:plugins` ↳ `:enabled` has no `report_tests_log_factory`.
- `manual-project-with-bundled-mixin.yml` — the same project, `--mixin
  assets/mixins/report-tests-log-factory.yml` added. `:plugins` ↳ `:enabled` now
  includes `report_tests_log_factory`, and `:report_tests_log_factory` ↳ `:reports`
  includes `cppunit`. A full `ceedling test:all` with this same mixin was also run by
  hand (Ceedling 1.1.8) against the stripped project and did produce
  `build/artifacts/test/cppunit_tests_report.xml`, confirming the mixin is
  sufficient on its own, with no other change to `project.yml`.
