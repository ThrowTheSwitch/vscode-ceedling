# Manual Test Project

This folder is a small, real Ceedling project for exercising the extension by hand. [docs/Development.md](../../docs/Development.md) explains how to open it in the Extension Development Host and walks through the manual testing plan.

## Layout

The project tests one tiny module with three test files, each exercising different extension features.

- `src/Calculator.c` and `src/Calculator.h` hold the module under test.
- `test/test_calculator.c` has passing, failing, and ignored tests. `test_add_should_HandleSpaceBeforeParen` declares itself with a space before its parameter list, which the extension must still name as Ceedling does.
- `test/test_calculator_parametrized.c` has `TEST_CASE` and `TEST_MATRIX` tests, plus a commented-out test that must not appear in the Testing view.
- `test/test_calculator_crash.c` crashes deliberately, to exercise Ceedling’s `:use_backtrace` handling.
- `.vscode/launch.json` holds the `ceedling` debug configuration. `.vscode/settings.json` turns on gcc problem matching and pretty labels.
- `mixins/` holds coverage configurations for the coverage checks: gcovr, ReportGenerator, and the gcov plugin without a Cobertura report. None applies until `ceedlingExplorer.mixins` names it.

## Settings the tests rely on

`project.yml` holds every setting the tests need, apart from the coverage mixins.

- **Parametrized tests** need `:unity` ↳ `:use_param_tests` ⇒ `true`. Ceedling 1.0.0 also needs `:project` ↳ `:use_test_preprocessor` ⇒ `:none`, the default, since its test-file preprocessing removes the `TEST_CASE`, `TEST_RANGE`, and `TEST_MATRIX` markers. Ceedling 1.1.0 and later read them with or without preprocessing.
- **The crash test** relies on `:project` ↳ `:use_backtrace` ⇒ `:simple`. It sits in its own file, apart from `test_calculator.c`’s ignored test. A Ceedling bug, fixed in 1.1.7 and 1.2.0, could report an ignored test as crashed when it shared a file with a real crash.
- **Coverage** needs Ceedling’s gcov plugin, `gcov`, and gcovr or ReportGenerator. A mixin in `mixins/` enables the plugin and its report. Without one, the Testing view offers no _Run with Coverage_, which the checklist relies on.
- **Test reporting** needs nothing. `project.yml` deliberately leaves `report_tests_log_factory` disabled, to show that the extension’s bundled mixin enables it.
