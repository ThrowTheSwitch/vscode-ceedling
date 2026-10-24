#include "unity.h"
#include "Clamp.h"

void test_clamp(void)
{
    TEST_ASSERT_EQUAL(5, clamp(5, 0, 10));
}

void test_clamp_more(void)
{
    TEST_ASSERT_EQUAL(0, clamp(-5, 0, 10));
}
