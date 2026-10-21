"""Bounded, authenticated raw-pixel capture over a persistent local emulator channel."""
import grpc
import time
from google.protobuf.empty_pb2 import Empty
from PIL import Image
from android_capture_pb2 import Image as EmulatorImage, ImageFormat, Touch, TouchEvent, KeyboardEvent


class EmulatorCapture:
    def __init__(self, port, token):
        if not token or not 1024 <= port <= 65535:
            raise ValueError('private emulator endpoint required')
        self.channel = grpc.insecure_channel(f'127.0.0.1:{port}', options=[
            ('grpc.max_receive_message_length', 4 * 1024 * 1024),
            ('grpc.enable_retries', 0),
        ])
        self.metadata = (('authorization', 'Bearer ' + token),)
        self.request = ImageFormat(format=ImageFormat.RGB888, width=432, height=960)
        self.screenshot = self.channel.unary_unary(
            '/android.emulation.control.EmulatorController/getScreenshot',
            request_serializer=ImageFormat.SerializeToString,
            response_deserializer=EmulatorImage.FromString)

        self.touch = self.channel.unary_unary(
            '/android.emulation.control.EmulatorController/sendTouch',
            request_serializer=TouchEvent.SerializeToString, response_deserializer=Empty.FromString)
        self.key = self.channel.unary_unary(
            '/android.emulation.control.EmulatorController/sendKey',
            request_serializer=KeyboardEvent.SerializeToString, response_deserializer=Empty.FromString)

    def input(self, data, width, height, stop):
        # The adapter validates/replay-checks before reaching this transport.
        # Text is protobuf data, never interpreted by a device shell.
        if data['kind'] in ('key', 'text'):
            keys = [data['key']] if data['kind'] == 'key' else list(data['text'])
            for key in keys:
                if stop.is_set(): return
                self.key(KeyboardEvent(key=key, eventType=KeyboardEvent.keypress), metadata=self.metadata, timeout=2)
            return
        x, y = round(data['x'] * (width - 1)), round(data['y'] * (height - 1))
        def touch(pressure):
            self.touch(TouchEvent(touches=[Touch(x=x, y=y, identifier=0, pressure=pressure)]),
                       metadata=self.metadata, timeout=2)
        try:
            touch(1)
            if data['kind'] == 'tap':
                stop.wait(.02)
            else:
                x0, y0 = x, y
                end_x, end_y = round(data['endX'] * (width - 1)), round(data['endY'] * (height - 1))
                began = time.monotonic()
                while not stop.is_set():
                    fraction = min(1, (time.monotonic() - began) / data['duration'])
                    x, y = round(x0 + (end_x - x0) * fraction), round(y0 + (end_y - y0) * fraction)
                    touch(1)
                    if fraction == 1: break
                    stop.wait(1 / 60)
        finally:
            # Release even when a swipe is cancelled or fails halfway through.
            touch(0)

    def __call__(self):
        # One in-flight request, no historical frame queue. A static screen still
        # gets a fresh successful capture, preserving the worker's liveness checks.
        frame = self.screenshot(self.request, metadata=self.metadata, timeout=2)
        width, height = frame.format.width, frame.format.height
        if (frame.format.format != ImageFormat.RGB888 or not 100 <= width <= 432
                or not 100 <= height <= 960 or len(frame.image) != width * height * 3):
            raise ValueError('invalid emulator frame')
        return Image.frombytes('RGB', (width, height), frame.image)

    def close(self):
        self.channel.close()
