#include "unity.h"
#include "Calculator.h"

void setUp(void) {}
void tearDown(void) {}

TEST_CASE(2, 3, 5)
TEST_CASE(10, -4, 6)
void test_add_ParameterizedCases(int a, int b, int expected) {
    TEST_ASSERT_EQUAL(expected, add(a, b));
}
