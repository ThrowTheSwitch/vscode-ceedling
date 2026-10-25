#include "unity.h"
#include "Calculator.h"

void test_add(void)
{
    TEST_ASSERT_EQUAL(3, add(1, 2));
}

void test_add_more(void)
{
    TEST_ASSERT_EQUAL(5, add(2, 3));
}
