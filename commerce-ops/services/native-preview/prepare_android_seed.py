#!/usr/bin/env python3
"""Build a fresh OS-only userdata seed. Stop the preview service first.

No APKs, merchant data, preview capabilities or browser input enter this process.
Never use an existing session directory as a seed source.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from android_avd import GPU_MODE, create_avd, digest


def prepare(args):
    root = Path(args.state).resolve()
    lock = (root / 'worker.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if list(root.glob('session-*')):
        raise RuntimeError('worker sessions must be cleaned up first')
    output = Path(args.output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    directory = output / 'build'
    directory.mkdir(mode=0o700)
    sdk, image = Path(args.sdk).resolve(), Path(args.system_image).resolve()
    avd = create_avd(directory, image)
    runtime = directory / 'runtime'; runtime.mkdir(mode=0o700)
    env = dict(os.environ, XDG_RUNTIME_DIR=str(runtime), ANDROID_AVD_HOME=str(directory), ANDROID_ADB_SERVER_PORT='5038', ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk))
    log = (output / 'seed-boot.log').open('wb')
    emulator = subprocess.Popen([str(sdk / 'emulator/emulator'), '-avd', 'RocentoWorker',
        '-port', '5580', '-no-window', '-no-audio', '-no-snapshot', '-no-boot-anim',
        '-gpu', GPU_MODE, '-accel', 'on', '-grpc', '19500', '-grpc-use-token'], env=env,
        stdin=subprocess.DEVNULL, cwd=directory,
        stdout=log, stderr=subprocess.STDOUT)
    def adb(*args, timeout=15):
        return subprocess.check_output([str(sdk / 'platform-tools/adb'), '-P', '5038',
            '-s', 'emulator-5580', *args], timeout=timeout, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            if emulator.poll() is not None: raise RuntimeError('seed emulator stopped')
            try:
                if adb('shell', 'getprop', 'sys.boot_completed', timeout=3).strip() == b'1': break
            except subprocess.SubprocessError: pass
            time.sleep(1)
        else: raise RuntimeError('seed boot timeout')
        # Finish first-boot setup before sealing; there is no app installation step.
        print('OS booted; allowing system setup to finish', flush=True)
        time.sleep(60)
        events = adb('logcat', '-b', 'events', '-d', '-s', 'am_anr')
        if b'am_anr' in events:
            raise RuntimeError('OS seed had an application-not-responding event')
        packages = adb('shell', 'pm', 'list', 'packages', '-3').decode().splitlines()
        if packages: raise RuntimeError('seed must contain no third-party apps')
        adb('shell', 'sync')
        adb('emu', 'kill')
        emulator.wait(timeout=30)
        for source, target in [('userdata-qemu.img.qcow2', 'userdata.img'), ('encryptionkey.img.qcow2', 'encryptionkey.img')]:
            subprocess.run([str(sdk / 'emulator/qemu-img'), 'convert', '-f', 'qcow2', '-O', 'raw',
                str(avd / source), str(output / target)], check=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.chmod(output / target, 0o400)
        manifest = {'format': 1, 'geometry': [432, 960, 168, 2048],
            'systemSha256': digest(image / 'system.img'), 'seedSha256': digest(output / 'userdata.img'),
            'encryptionKeySha256': digest(output / 'encryptionkey.img'), 'thirdPartyPackages': packages}
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
        os.chmod(output / 'userdata.img', 0o400)
        print('Pristine OS seed ready', flush=True)
    finally:
        if emulator.poll() is None:
            emulator.terminate()
            try: emulator.wait(timeout=15)
            except subprocess.TimeoutExpired: emulator.kill(); emulator.wait(timeout=10)
        log.close()
        shutil.rmtree(directory)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('sdk', 'system-image', 'state', 'output'): parser.add_argument('--'+name, required=True)
    prepare(parser.parse_args())
