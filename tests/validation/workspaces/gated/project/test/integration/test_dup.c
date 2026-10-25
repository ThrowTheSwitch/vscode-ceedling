#include "unity.h"
#include "Clamp.h"

void test_integration_clamp_low(void)
{
    TEST_ASSERT_EQUAL(0, clamp(-5, 0, 10));
}

void test_integration_clamp_high(void)
{
    TEST_ASSERT_EQUAL(10, clamp(50, 0, 10));
}
