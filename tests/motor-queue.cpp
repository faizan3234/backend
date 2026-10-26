#include "../firmware/RelivLocalDispenser/QueueSafety.h"
#include <cassert>
#include <iostream>
int main() {
 assert(!queueExpired(0,59999)); assert(queueExpired(0,60000));
 assert(!queueExpired(UINT32_MAX-999,58999));
 assert(queueExpired(UINT32_MAX-999,59000));
 std::cout << "Queue age and clock rollover checks passed\n";
}
