#include "unity.h"
#include <unistd.h>

// Keeps each build running long enough for a rediscovery to start during it.
void test_slow(void)
{
    sleep(4);
    TEST_PASS();
}
