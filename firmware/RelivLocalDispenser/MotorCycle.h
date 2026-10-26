#pragma once
#include <stdint.h>

// No networking/storage in the energized phase. Caller applies on to the relay.
struct MotorCycle {
  bool active = false, on = false;
  unsigned remaining = 0;
  uint32_t since = 0;
  void start(unsigned quantity, uint32_t now) {
    active = on = true; remaining = quantity; since = now;
  }
  void tick(uint32_t now) {
    if (!active) return;
    if (on && uint32_t(now - since) >= 2300) { on = false; since = now; }
    else if (!on && uint32_t(now - since) >= 2000) {
      if (--remaining == 0) active = false;
      else { on = true; since = now; }
    }
  }
};
