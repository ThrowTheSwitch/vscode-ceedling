# `dumpconfig` fixtures

These files are real `ceedling dumpconfig` output, used to test how the extension reads a resolved project configuration. They were captured with Ceedling 1.1.8 against a copy of [`tests/manual`](../../manual) whose `project.yml` didn’t enable `report_tests_log_factory`.

- `manual-project-no-report-plugin.yml` comes from `ceedling dumpconfig` with no `--mixin`. Its `:plugins` ↳ `:enabled` lacks `report_tests_log_factory`.
- `manual-project-with-bundled-mixin.yml` comes from the same project with `--mixin assets/mixins/report-tests-log-factory.yml`. Its `:plugins` ↳ `:enabled` includes `report_tests_log_factory`, and `:report_tests_log_factory` ↳ `:reports` includes `cppunit`.

The second capture also confirms that the bundled mixin is sufficient on its own. A full `ceedling test:all` with that mixin, against the same project, produced `build/artifacts/test/cppunit_tests_report.xml`.

Ceedling 1.2.0’s `dumpconfig --stdout` output lives with the other 1.2.0 captures, in [`../ceedling-1.2.0/dumpconfig-stdout.yml`](../ceedling-1.2.0/dumpconfig-stdout.yml). See [`../README.md`](../README.md) for how fixtures are captured.
