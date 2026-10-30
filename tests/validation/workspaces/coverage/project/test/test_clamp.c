#include "unity.h"
#include "Clamp.h"

void test_clamp_low(void)
{
    TEST_ASSERT_EQUAL(0, clamp(-5, 0, 10));
}
