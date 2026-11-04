#include "Calculator.h"

int add(int a, int b)
{
    return a + b;
}

int subtract(int a, int b)
{
    return a - b;
}

int both(int a, int b)
{
    if (a && b)
        return 1;
    return 0;
}
