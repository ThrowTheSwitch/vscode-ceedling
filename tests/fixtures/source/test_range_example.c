// NOTE: not a single verbatim capture. Assembled from two confirmed-real fragments captured
// during probing against throwtheswitch/madsciencelab-plugins:1.0.0/:1.1.0: the TEST_CASE syntax
// in test_param.c (this same directory), and the exact `TEST_RANGE([0, 4, 1])` line, which was
// compiled (and, on both Ceedling versions, produced a real compiler diagnostic) as part of a
// test file during that session.
#include "unity.h"
#include "Calculator.h"

void setUp(void) {}
void tearDown(void) {}

TEST_CASE(2, 3, 5)
TEST_CASE(10, -4, 6)
void test_add_ParameterizedCases(int a, int b, int expected) {
    TEST_ASSERT_EQUAL(expected, add(a, b));
}

TEST_RANGE([0, 4, 1])
void test_add_RangeCases(int x) {
    TEST_ASSERT_EQUAL(x, add(x, 0));
}
