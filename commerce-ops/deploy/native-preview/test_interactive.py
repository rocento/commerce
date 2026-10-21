import io
import math
import os
import struct
import threading
import unittest
from unittest.mock import Mock, patch
from interactive import Interactive, frames, validate_input


class InputTests(unittest.TestCase):
    def test_capture_passes_selected_fps_to_idb(self):
        with patch.object(Interactive, 'spawn', return_value=Mock()) as spawn, \
             patch.object(Interactive, 'command', return_value=b'{"screen_dimensions":{"width_points":402,"height_points":874}}'), \
             patch('interactive.Path.exists', return_value=True):
            adapter = Interactive('test', '/tmp/devices', '/tmp', threading.Event(), Mock(), fps=60)
        args = spawn.call_args.args[0]
        self.assertEqual(args[args.index('--fps') + 1], '60')
        self.assertTrue(adapter.ready)

    def test_invalid_fps_rejected_before_starting_native_processes(self):
        for fps in (0, 61, -1, True, 30.5):
            with self.subTest(fps=fps), self.assertRaises(ValueError):
                Interactive('unused', 'unused', 'unused', threading.Event(), Mock(), fps=fps)

    def test_allowlist_and_bounded_input(self):
        for payload in [dict(kind='tap', sequence=1, x=.5, y=.2), dict(kind='swipe', sequence=2, x=0, y=1, endX=1, endY=0, duration=.3), dict(kind='text', sequence=3, text='milk'), dict(kind='key', sequence=4, key='Backspace')]:
            self.assertEqual(validate_input(payload), payload)
        invalid = [dict(kind='tap', sequence=1, x=math.nan, y=0), dict(kind='tap', sequence=1, x=True, y=0), dict(kind='tap', sequence=1, x=1.1, y=0), dict(kind='text', sequence=2, text='a'*129), dict(kind='text', sequence=2, text='\n'), dict(kind='key', sequence=2, key='SHELL'), dict(kind='tap', sequence=0, x=0, y=0), dict(kind='tap', sequence=1, x=0, y=0, device='other')]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError): validate_input(payload)

    def test_sequence_and_mapping(self):
        adapter = Interactive.__new__(Interactive)
        adapter.input_lock = threading.Lock(); adapter.stop = threading.Event()
        adapter.ready = True; adapter.sequence = 0; adapter.width = 402; adapter.height = 874
        adapter.command = Mock()
        payload = dict(kind='tap', sequence=1, x=.5, y=.5)
        self.assertEqual(adapter.input(payload), 204)
        adapter.command.assert_called_once_with('ui', 'tap', '200', '436')
        self.assertEqual(adapter.input(payload), 409)
        adapter.stop.set()
        self.assertEqual(adapter.input(dict(payload, sequence=2)), 404)

    def test_failed_input_cannot_replay(self):
        adapter = Interactive.__new__(Interactive)
        adapter.input_lock = threading.Lock(); adapter.stop = threading.Event()
        adapter.ready = True; adapter.sequence = 0; adapter.width = 402; adapter.height = 874
        adapter.command = Mock(side_effect=RuntimeError('failed'))
        payload = dict(kind='key', sequence=3, key='Enter')
        with self.assertRaises(RuntimeError): adapter.input(payload)
        self.assertEqual(adapter.input(payload), 409)


class FramingTests(unittest.TestCase):
    def stream(self, payload):
        read, write = os.pipe()
        os.write(write, payload); os.close(write)
        return os.fdopen(read, 'rb', buffering=0)

    def test_minicap_header_and_bounded_jpeg(self):
        header = bytes([1, 24]) + bytes(22)
        jpeg = b'\xff\xd8data\xff\xd9'
        with self.stream(header + struct.pack('<I', len(jpeg)) + jpeg) as pipe:
            self.assertEqual(next(frames(pipe, threading.Event())), jpeg)
        for payload in [bytes([3, 24]) + bytes(22), header + struct.pack('<I', 3000000), header + struct.pack('<I', 4) + b'nope']:
            with self.stream(payload) as pipe, self.assertRaises(ValueError): next(frames(pipe, threading.Event()))
