#include "unity.h"
#include "Calculator.h"

void test_filter_alpha(void)
{
    TEST_ASSERT_EQUAL(1, subtract(3, 2));
}

void test_filter_beta(void)
{
    TEST_ASSERT_EQUAL(99, subtract(3, 2));
}
