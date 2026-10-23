// Parametrized tests need :unity: :use_param_tests: true in project.yml (already set). Ceedling
// 1.0.0 also needs :project: :use_test_preprocessor: :none (already the default). Its test-file
// preprocessing removes TEST_CASE/TEST_RANGE/TEST_MATRIX markers before they can be read.
// Ceedling 1.1.0 and later read them with or without preprocessing. See tests/manual/README.md.
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

TEST_MATRIX([0, 1], [-1, 2])
void test_add_MatrixCases(int a, int b) {
    TEST_ASSERT_EQUAL(a + b, add(a, b));
}

// Commented out, so Ceedling never runs it and the Testing view must not list it.
/*
void test_add_CommentedOut(void) {
    TEST_FAIL();
}
*/
