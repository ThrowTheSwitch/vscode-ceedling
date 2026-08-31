// TEST_CASE needs :unity: :use_param_tests: true in project.yml (already set). Ceedling 1.0.0
// also needs :project: :use_test_preprocessor: :none (already the default) - Ceedling 1.0.0
// cannot preserve TEST_CASE/TEST_RANGE macros through its own test-file preprocessing. Ceedling
// 1.1.0 supports parameterized tests with or without preprocessing. See tests/manual/README.md.
// Kept in its own file for clarity, not because it needs isolating from a build failure.
#include "unity.h"
#include "Calculator.h"

void setUp(void) {}
void tearDown(void) {}

TEST_CASE(2, 3, 5)
TEST_CASE(10, -4, 6)
void test_add_ParameterizedCases(int a, int b, int expected) {
    TEST_ASSERT_EQUAL(expected, add(a, b));
}
