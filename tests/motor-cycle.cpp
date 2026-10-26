#include "../firmware/RelivLocalDispenser/MotorCycle.h"
#include <cassert>
#include <iostream>
int main() {
  MotorCycle m;
  m.start(2, 0); assert(m.on);
  m.tick(2299); assert(m.on);
  m.tick(2300); assert(!m.on && m.active);
  m.tick(4299); assert(!m.on);
  m.tick(4300); assert(m.on);
  m.tick(6600); assert(!m.on && m.active);
  m.tick(8600); assert(!m.active && !m.on);
  // millis() rollover is unsigned elapsed time, not absolute deadline.
  m.start(1, UINT32_MAX - 999);
  m.tick(1300); assert(!m.on);
  m.tick(3300); assert(!m.active);
  // A delayed tick must switch off before allowing another cycle.
  m.start(2, 0); m.tick(10000); assert(!m.on);
  m.tick(10001); assert(!m.on);
  std::cout << "Motor timing, quantity, delayed tick and rollover checks passed\n";
}
