import unittest
import threading
from unittest.mock import Mock, patch
from android_capture import EmulatorCapture
from android_capture_pb2 import Image, ImageFormat


class EmulatorCaptureTests(unittest.TestCase):
    def adapter(self):
        with patch('android_capture.grpc.insecure_channel') as connect:
            capture = EmulatorCapture(19500, 'private-token')
        self.assertEqual(connect.call_args.args[0], '127.0.0.1:19500')
        return capture

    def frame(self, width=100, height=100, pixels=None):
        return Image(format=ImageFormat(format=ImageFormat.RGB888, width=width, height=height),
                     image=pixels if pixels is not None else b'\xff\x00\x00' * width * height)

    def test_capture_preserves_rgb_pixels_and_authenticates_with_deadline(self):
        capture = self.adapter()
        capture.screenshot.return_value = self.frame()
        with capture() as image:
            self.assertEqual(image.size, (100, 100))
            self.assertEqual(image.getpixel((0, 0)), (255, 0, 0))
        self.assertEqual(capture.screenshot.call_args.kwargs,
                         {'metadata': (('authorization', 'Bearer private-token'),), 'timeout': 2})
        capture.close()
        capture.channel.close.assert_called_once()

    def test_invalid_dimensions_payload_and_format_fail_closed(self):
        capture = self.adapter()
        for frame in [self.frame(width=541), self.frame(height=1201), self.frame(width=0),
                      self.frame(pixels=b'truncated'), Image(format=ImageFormat(format=0, width=100, height=100))]:
            with self.subTest(frame_size=len(frame.image)):
                capture.screenshot.return_value = frame
                with self.assertRaises(ValueError): capture()

    def test_missing_token_rejected_before_connect(self):
        with self.assertRaises(ValueError): EmulatorCapture(19500, '')

    def test_text_and_keys_are_literal_protobuf_data(self):
        capture = self.adapter()
        text = "x';$(touch /tmp/pwn)`%s"
        capture.input({'kind': 'text', 'text': text}, 540, 1200, threading.Event())
        self.assertEqual(''.join(call.args[0].key for call in capture.key.call_args_list), text)
        capture.input({'kind': 'key', 'key': 'Backspace'}, 540, 1200, threading.Event())
        self.assertEqual(capture.key.call_args.args[0].key, 'Backspace')
        self.assertEqual(capture.key.call_args.args[0].eventType, 2)

    def test_tap_scales_coordinates_and_releases(self):
        capture = self.adapter()
        capture.input({'kind': 'tap', 'x': 1, 'y': .5}, 540, 1200, threading.Event())
        points = [call.args[0].touches[0] for call in capture.touch.call_args_list]
        self.assertEqual([(p.x, p.y, p.pressure) for p in points], [(539, 600, 1), (539, 600, 0)])

    def test_cancelled_swipe_always_releases_touch(self):
        capture = self.adapter()
        stop = threading.Event()
        capture.touch.side_effect = lambda *args, **kwargs: stop.set()
        capture.input({'kind': 'swipe', 'x': .5, 'y': .8, 'endX': .5, 'endY': .2, 'duration': 1}, 540, 1200, stop)
        self.assertEqual(capture.touch.call_args.args[0].touches[0].pressure, 0)
        self.assertEqual(capture.touch.call_count, 2)
