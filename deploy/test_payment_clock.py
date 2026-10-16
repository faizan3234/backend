import importlib.util
import unittest
from unittest.mock import patch
from pathlib import Path
spec = importlib.util.spec_from_file_location('repair_clock', Path(__file__).with_name('repair-payment-clock.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ClockTests(unittest.TestCase):
    def test_invalid_date_rejected(self):
        with self.assertRaises(Exception): m.utc_value('yesterday')
    def test_manual_utc_saved_without_shell(self):
        with patch.object(m.os,'geteuid',return_value=0), patch.object(m,'run',return_value='ok') as run, patch('sys.argv',['repair','--set-utc','2026-10-17 00:00:00','--idle-confirmed']):
            m.main()
        self.assertIn(('timedatectl','set-time','2026-10-17 00:00:00 UTC'),[c.args for c in run.call_args_list])
        self.assertIn(('hwclock','--systohc','--utc'),[c.args for c in run.call_args_list])
    def test_no_write_when_ntp_fails(self):
        with patch.object(m.os,'geteuid',return_value=0), patch.object(m,'run',return_value='no') as run, patch.object(m.time,'monotonic',side_effect=[0,61]), patch('sys.argv',['repair','--sync','--idle-confirmed']):
            with self.assertRaisesRegex(RuntimeError,'NOT overwritten'): m.main()
        self.assertFalse(any(c.args[0]=='hwclock' for c in run.call_args_list))
    def test_requires_idle_confirmation(self):
        with patch.object(m.os,'geteuid',return_value=0), patch.object(m,'run') as run, patch('sys.argv',['repair','--sync']):
            with self.assertRaises(SystemExit): m.main()
        run.assert_not_called()

if __name__ == '__main__': unittest.main()
