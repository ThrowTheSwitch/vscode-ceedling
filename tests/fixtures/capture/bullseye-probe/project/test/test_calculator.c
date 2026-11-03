#include "unity.h"
#include "Calculator.h"

// Calls add three times, so a report shows whether Bullseye counts hits or only marks them.
void test_add(void)
{
    TEST_ASSERT_EQUAL(3, add(1, 2));
    TEST_ASSERT_EQUAL(5, add(2, 3));
    TEST_ASSERT_EQUAL(7, add(3, 4));
}

// Its name begins with test_add, so --test-case=test_add runs it too.
void test_add_more(void)
{
    TEST_ASSERT_EQUAL(9, add(4, 5));
}

// Takes one outcome of each condition in `a && b`.
void test_both(void)
{
    TEST_ASSERT_EQUAL(1, both(1, 1));
    TEST_ASSERT_EQUAL(0, both(0, 1));
}
