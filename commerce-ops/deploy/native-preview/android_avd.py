"""Common disposable emulator geometry and OS-only seed validation."""
import hashlib
import json
import re
from pathlib import Path

GPU_MODE = 'swiftshader'


def system_ui_ready(status):
    """Boot completion can precede completion of SystemUIService startup."""
    for record in re.split(r'\n\s*\* ServiceRecord', status):
        if re.search(r'com\.android\.systemui/\.SystemUIService(?:\s|})', record.split('\n', 1)[0]):
            return ('app=ProcessRecord{' in record
                    and re.search(r'\bstartCommandResult=1\b', record) is not None
                    and re.search(r'\bexecuteNesting=[1-9]', record) is None)
    return False


def create_avd(directory, image):
    avd = directory / 'device.avd'
    avd.mkdir()
    (directory / 'RocentoWorker.ini').write_text(f'path={avd}\n')
    abi = image.name
    arch = {'arm64-v8a': 'arm64', 'x86_64': 'x86_64'}.get(abi)
    if not arch: raise ValueError('unsupported emulator architecture')
    (avd / 'config.ini').write_text(f"""AvdId=RocentoWorker
image.sysdir.1={image}/
abi.type={abi}
hw.cpu.arch={arch}
hw.cpu.ncore=2
hw.ramSize=2048
hw.lcd.width=432
hw.lcd.height=960
hw.lcd.density=168
hw.keyboard=yes
hw.gpu.enabled=yes
hw.gpu.mode={GPU_MODE}
disk.dataPartition.size=2G
showDeviceFrame=no
""")
    return avd


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_seed(manifest, image):
    path = Path(manifest).resolve()
    data = json.loads(path.read_text())
    seed = path.parent / 'userdata.img'
    # These OS-only disk templates contain no saved RAM/GPU state. Both supported
    # display geometries have identical logical dp size and are interchangeable.
    if (data.get('format') != 1 or data.get('geometry') not in ([540, 1200, 210, 2048], [432, 960, 168, 2048])
            or data.get('systemSha256') != digest(image / 'system.img')
            or data.get('seedSha256') != digest(seed)
            or data.get('encryptionKeySha256') != digest(path.parent / 'encryptionkey.img')
            or data.get('thirdPartyPackages') != []):
        raise ValueError('incompatible or modified emulator seed')
    return seed
