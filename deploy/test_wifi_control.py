import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('helper',Path(__file__).with_name('reliv-wifi-helper.py'))
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
class WifiTests(unittest.TestCase):
 def setUp(self):
  self.data=dict(ssid='Phone: one',password='my pass\\word',security='personal',minutes=5,acknowledged=True)
  self.config=dict(apUuid='original',apInterface='wlan0',clientInterface='wlan0',singleAdapter=True)
 def test_validation_and_secret_encoding(self):
  h.validate(self.data)
  text=h.keyfile(self.data,'job','wlan0')
  self.assertIn('psk=my\\spass\\\\word',text)
  self.assertIn('ssid=80;104;111;110;101;58;32;111;110;101;',text)
  for patchdata in [dict(ssid='x\ninject'),dict(password='short'),dict(minutes=0),dict(acknowledged=False)]:
   with self.assertRaises(ValueError):h.validate({**self.data,**patchdata})
 def test_escaped_nmcli(self):
  self.assertEqual(h.split_line(r'Phone\: one:82:WPA2'),['Phone: one','82','WPA2'])
 def test_return_timer_precedes_profile_activation(self):
  calls=[]
  with tempfile.TemporaryDirectory() as folder, patch.object(h,'STATE',Path(folder)/'state.json'),patch.object(h,'PROFILES',Path(folder)/'profiles'),patch.object(h,'nm',side_effect=lambda *args,**kw:calls.append(args) or ('ap' if '802-11-wireless.mode' in args else 'original')),patch.object(h,'timer',side_effect=lambda *args:calls.append(args)):
   state=h.schedule(self.config,self.data)
   ret=next(i for i,x in enumerate(calls) if 'return' in x)
   load=next(i for i,x in enumerate(calls) if 'load' in x)
   self.assertLess(ret,load);self.assertEqual(state['phase'],'scheduled')
   self.assertNotIn(self.data['password'],str(calls));self.assertNotIn('password',h.STATE.read_text())
   with self.assertRaises(ValueError):h.schedule(self.config,self.data)
 def test_old_timer_cannot_restore_new_job(self):
  with patch.object(h,'read_state',return_value={'phase':'connected','job':'new'}),patch.object(h,'run') as run:
   h.restore(self.config,'old');run.assert_not_called()
 def test_restore_survives_collected_units_and_restarts_original_ap(self):
  state={'phase':'connected','job':'abc','previousUuid':'original'};calls=[]
  def system(*args,**kw):
   if 'stop' in args:raise RuntimeError('unit absent after reboot')
   return ''
  with tempfile.TemporaryDirectory() as folder,patch.object(h,'STATE',Path(folder)/'state.json'),patch.object(h,'PROFILES',Path(folder)),patch.object(h,'run',side_effect=system),patch.object(h,'nm',side_effect=lambda *args,**kw:calls.append(args) or '--'):
   h.save(state);result=h.restore(self.config,'abc')
   self.assertEqual(result['phase'],'restored');self.assertTrue(any('up' in x and 'original' in x for x in calls))
 def test_restored_job_cannot_apply_again(self):
  with patch.object(h,'read_state',return_value={'phase':'restored','job':'abc'}),patch.object(h,'nm') as nm:
   h.apply(self.config,'abc');nm.assert_not_called()
if __name__=='__main__':unittest.main()
