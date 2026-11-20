import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from controller import Control
from unittest import TestCase, main
from unittest.mock import Mock, patch

class ControlTests(TestCase):
    def controller(self, state='running', active=0):
        ec2=Mock()
        ec2.describe_instances.return_value={'Reservations':[{'Instances':[{'State':{'Name':state}}]}]}
        c=Control(ec2,'i-0af639278db7286a9','x'*64)
        c.worker=Mock(return_value={'ready':True,'activeSessions':active})
        return c
    def test_active_sessions_block_stop(self):
        c=self.controller(active=1)
        self.assertEqual(c.action('stop')[0],409)
        c.ec2.stop_instances.assert_not_called()
    def test_unreachable_worker_cannot_be_stopped(self):
        c=self.controller();c.worker.side_effect=OSError()
        with self.assertRaises(OSError):c.action('stop')
        c.ec2.stop_instances.assert_not_called()
    def test_stop_only_fixed_instance_and_blocks_new_sessions(self):
        c=self.controller()
        self.assertEqual(c.action('stop')[1]['state'],'stopping')
        c.ec2.stop_instances.assert_called_once_with(InstanceIds=['i-0af639278db7286a9'])
        self.assertTrue(c.stopping)
    def test_start_only_stopped_instance(self):
        c=self.controller('stopped')
        self.assertEqual(c.action('start')[1]['state'],'pending')
        c.ec2.start_instances.assert_called_once_with(InstanceIds=['i-0af639278db7286a9'])
        c=self.controller('running');c.action('start');c.ec2.start_instances.assert_not_called()
    def test_no_arbitrary_action(self):
        c=self.controller();self.assertEqual(c.action('terminate')[0],404)
        c.ec2.terminate_instances.assert_not_called()
class IdleTests(ControlTests):
    def test_full_five_minutes_required(self):
        c=self.controller()
        with patch('controller.time.monotonic', side_effect=[0,299,300]):
            c.check_idle(); c.check_idle(); c.ec2.stop_instances.assert_not_called()
            c.check_idle()
        c.ec2.stop_instances.assert_called_once_with(InstanceIds=[c.instance])

    def test_active_preview_resets_timer(self):
        c=self.controller()
        with patch('controller.time.monotonic', side_effect=[0,400,699,700]):
            c.check_idle()
            c.worker.return_value['activeSessions']=1; c.check_idle()
            c.worker.return_value['activeSessions']=0; c.check_idle(); c.check_idle()
            c.ec2.stop_instances.assert_not_called(); c.check_idle()
        c.ec2.stop_instances.assert_called_once()

    def test_unavailable_health_resets_timer(self):
        c=self.controller()
        with patch('controller.time.monotonic', side_effect=[0,400,699]):
            c.check_idle(); c.worker.side_effect=OSError()
            with self.assertRaises(OSError): c.check_idle()
            c.worker.side_effect=None; c.check_idle(); c.check_idle()
        c.ec2.stop_instances.assert_not_called()

    def test_rechecks_activity_before_stop(self):
        c=self.controller()
        c.worker.side_effect=[{'activeSessions':0},{'activeSessions':0},{'activeSessions':1}]
        with patch('controller.time.monotonic', side_effect=[0,300]):
            c.check_idle(); c.check_idle()
        c.ec2.stop_instances.assert_not_called()

    def test_stopped_instance_never_stopped_again(self):
        c=self.controller('stopped');c.check_idle()
        c.worker.assert_not_called();c.ec2.stop_instances.assert_not_called()

if __name__=='__main__':main()

