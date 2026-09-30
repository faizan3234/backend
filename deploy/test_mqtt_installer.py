"""Read-only installer tests; never restarts the host broker."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-mqtt-websocket.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.source = Path('/etc/mosquitto/mosquitto.conf')
        self.rows = [(self.source, ['listener', '1883', '192.168.50.1']),
                     (self.source, ['allow_anonymous', 'true'])]

    def test_observed_configuration_and_managed_repeat(self):
        installer.validate(self.rows)
        installer.validate(self.rows + [(installer.TARGET, ['listener', '9001', '192.168.50.1'])])

    def test_custom_security_is_never_replaced(self):
        for directive in [['allow_anonymous', 'false'], ['per_listener_settings', 'true'],
                          ['password_file', '/secret'], ['acl_file', '/acl'], ['certfile', '/cert']]:
            with self.subTest(directive=directive), self.assertRaises(ValueError):
                installer.validate(self.rows + [(self.source, directive)])

    def test_duplicate_or_exposed_listener_is_refused(self):
        for directive in [['listener', '9001'], ['listener', '1883', '192.168.50.1'],
                          ['listener', '9001', '0.0.0.0']]:
            with self.subTest(directive=directive), self.assertRaises(ValueError):
                installer.validate(self.rows + [(self.source, directive)])

    def test_includes_are_read_and_cycles_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'mosquitto.conf'
            includes = root / 'conf.d'
            includes.mkdir()
            config.write_text('include_dir ' + str(includes) + '\n')
            fragment = includes / 'local.conf'
            fragment.write_text('listener 1883 192.168.50.1\nallow_anonymous true\n')
            installer.validate(installer.directives(config))
            fragment.write_text('include_dir ' + str(includes) + '\n')
            with self.assertRaises(ValueError):
                installer.directives(config)

if __name__ == '__main__':
    unittest.main()
