import io
import struct
import time
import threading
import unittest
from unittest.mock import Mock, patch
try:
    from PIL import Image
    from android_worker import AndroidInput
except ModuleNotFoundError:
    AndroidInput = None


@unittest.skipIf(AndroidInput is None, 'Install requirements-android.txt for Android capture tests')
class AndroidInputTests(unittest.TestCase):
    def test_timer_oversleep_does_not_accumulate_in_capture_cadence(self):
        stop = Mock()
        stop.is_set.side_effect = [False, False, True]
        capture = Mock(side_effect=lambda: Image.new('RGB', (432, 960), 'red'))
        adapter = AndroidInput(stop, Mock(), capture, fps=60)
        with patch('android_worker.time.monotonic', side_effect=[0, .005, .025]):
            adapter.run()
        self.assertAlmostEqual(stop.wait.call_args_list[0].args[0], 1 / 60 - .005)
        self.assertAlmostEqual(stop.wait.call_args_list[1].args[0], 2 / 60 - .025)

    def test_capture_paces_to_selected_target_without_negative_waits(self):
        for fps, elapsed in ((24, .005), (60, .005), (60, .025)):
            with self.subTest(fps=fps, elapsed=elapsed):
                stop = Mock()
                stop.is_set.side_effect = [False, True]
                capture = Mock(side_effect=lambda: Image.new('RGB', (432, 960), 'red'))
                adapter = AndroidInput(stop, Mock(), capture, fps=fps)
                with patch('android_worker.time.monotonic', side_effect=[0, elapsed]):
                    adapter.run()
                stop.wait.assert_called_once_with(max(0, 1 / fps - elapsed))

    def test_invalid_capture_target_rejected(self):
        for fps in (0, 61, -1, True, 24.5):
            with self.subTest(fps=fps), self.assertRaises(ValueError):
                AndroidInput(threading.Event(), Mock(), Mock(), fps=fps)

    def adapter(self):
        adapter = AndroidInput(threading.Event(), Mock(), Mock())
        adapter.width, adapter.height = 1080, 2400
        return adapter

    def test_coordinates_and_sequences(self):
        adapter = self.adapter()
        value = dict(sequence=1, kind='tap', x=1, y=1)
        self.assertEqual(adapter.input(value), 204)
        adapter.capture.input.assert_called_once_with(value, 1080, 2400, adapter.stop)
        self.assertEqual(adapter.input(value), 409)
        with self.assertRaises(ValueError): adapter.input(dict(value, sequence=2, x=1.1))
        adapter.capture.input.side_effect = RuntimeError()
        with self.assertRaises(RuntimeError): adapter.input(dict(value, sequence=2))
        self.assertEqual(adapter.input(dict(value, sequence=2)), 409)

    def test_text_is_passed_literally_without_a_shell(self):
        adapter = self.adapter()
        text = "x';$(touch /tmp/pwn)`%s"
        data = dict(sequence=1, kind='text', text=text)
        adapter.input(data)
        adapter.capture.input.assert_called_once_with(data, 1080, 2400, adapter.stop)

    def test_capture_is_real_bounded_jpeg(self):
        adapter = self.adapter()
        png = io.BytesIO()
        Image.new('RGB', (1080, 2400), 'red').save(png, 'PNG')
        adapter.capture.side_effect = lambda: Image.open(io.BytesIO(png.getvalue()))
        def published(payload):
            self.assertEqual(payload[2:10], b'\xff\xfe\x00\x0eROCT')
            self.assertLess(abs(struct.unpack('>d', payload[10:18])[0] - time.time()*1000), 1000)
            with Image.open(io.BytesIO(payload)) as image:
                self.assertEqual(image.format, 'JPEG')
                self.assertEqual(image.size, (540, 1200))
            adapter.stop.set()
        adapter.publish.side_effect = published
        adapter.run()
        self.assertEqual(adapter.publish.call_count, 1)

    def test_transient_unreadable_frame_recovers_without_publishing_it(self):
        adapter = self.adapter()
        png = io.BytesIO()
        Image.new('RGB', (1080, 2400), 'red').save(png, 'PNG')
        adapter.capture.side_effect = [OSError('transient'), Image.open(io.BytesIO(png.getvalue()))]
        adapter.publish.side_effect = lambda _: adapter.stop.set()
        adapter.run()
        self.assertEqual(adapter.capture.call_count, 2)
        self.assertEqual(adapter.publish.call_count, 1)

    def test_persistent_unreadable_frames_fail_closed(self):
        adapter = self.adapter()
        adapter.capture.side_effect = OSError('unavailable')
        with self.assertRaises(OSError): adapter.run()
        self.assertEqual(adapter.capture.call_count, 3)
        adapter.publish.assert_not_called()
