#pragma once
#include <stdint.h>
// Drop old unstarted work rather than start a motor long after the customer left.
// A normal small cart starts within this window. Large/delayed carts need review.
inline bool queueExpired(uint32_t receivedAt, uint32_t now) {
  return uint32_t(now - receivedAt) >= 60000;
}
