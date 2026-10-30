// A test that crashes and one that passes, for :use_backtrace: :gdb's crash report and log path.
// Its reports: ceedling-1.2.2/cppunit-report-crash.xml and gdb-crash-stdout.txt.
#include "unity.h"

void setUp(void) {}
void tearDown(void) {}

void test_should_crash(void)
{
    volatile int *p = 0;
    *p = 42;
}

void test_passes(void)
{
}
