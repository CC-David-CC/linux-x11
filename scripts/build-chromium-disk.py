#!/usr/bin/env python3
"""Build the pinned 32-bit Chromium disk and collect its Debian copyright notices."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PREFIXES = ('usr/lib/chromium/', 'lib/i386-linux-gnu/', 'usr/lib/i386-linux-gnu/',
            'usr/share/glib-2.0/schemas/', 'usr/share/fonts/truetype/')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def unpack(archives, lock, scratch):
    entries = {}
    notices = {}
    for package in sorted(lock, key=lambda row: row['name']):
        archive = archives / package['name']
        if archive.stat().st_size != package['size'] or digest(archive) != package['sha256']:
            raise ValueError(f'Wrong Debian input: {archive.name}')
        with subprocess.Popen(['dpkg-deb', '--fsys-tarfile', archive], stdout=subprocess.PIPE) as proc:
            with tarfile.open(fileobj=proc.stdout, mode='r|') as tar:
                for item in tar:
                    name = item.name.removeprefix('./')
                    path = PurePosixPath(name)
                    if path.is_absolute() or '..' in path.parts:
                        raise ValueError(f'Unexpected package path: {name}')
                    if name.startswith('usr/share/doc/') and path.name == 'copyright' and item.isfile():
                        notices[name] = tar.extractfile(item).read()
                    if not name.startswith(PREFIXES) or not (item.isfile() or item.issym()):
                        continue
                    if name.startswith('usr/lib/i386-linux-gnu/'):
                        path = path.relative_to('usr')
                    if path in entries:
                        continue
                    for parent in reversed(path.parents):
                        if parent.parts and parent not in entries:
                            directory = tarfile.TarInfo(str(parent))
                            directory.type, directory.mode = tarfile.DIRTYPE, 0o755
                            entries[parent] = (directory, None)
                    meta = tarfile.TarInfo(str(path))
                    data = None
                    if item.issym():
                        meta.type, meta.mode, meta.linkname = tarfile.SYMTYPE, 0o777, item.linkname
                    else:
                        meta.size, meta.mode = item.size, item.mode & 0o7777
                        data = scratch / str(len(entries))
                        with data.open('xb') as output:
                            shutil.copyfileobj(tar.extractfile(item), output)
                    entries[path] = (meta, data)
            while proc.stdout.read(65536):
                pass
            if proc.wait():
                raise RuntimeError(f'Could not read {archive.name}')
    return entries, notices


def build(archives, output):
    lock_path = ROOT / 'chromium-packages.json'
    receipt = json.loads((ROOT / 'chromium-runtime.json').read_bytes())
    if digest(lock_path) != receipt['packageLockSHA256']:
        raise ValueError('Chromium package lock differs from its receipt')
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output) as tmp:
        scratch = Path(tmp)
        files, notices = unpack(archives, json.loads(lock_path.read_bytes()), scratch)
        disk = scratch / 'browser.sqfs'
        command = ['mksquashfs', '-', disk, '-tar', '-noappend', '-always-use-fragments',
                   '-all-root', '-root-mode', '777', '-mkfs-time', '0', '-all-time', '0', '-processors', '3', '-no-progress']
        with subprocess.Popen(command, stdin=subprocess.PIPE) as proc:
            with tarfile.open(fileobj=proc.stdin, mode='w|') as tar:
                for path in sorted(files, key=lambda key: key.parts):
                    item, data = files[path]
                    if data is None:
                        tar.addfile(item)
                    else:
                        with data.open('rb') as stream:
                            tar.addfile(item, stream)
            proc.stdin.close()
            if proc.wait():
                raise RuntimeError('Could not build Chromium SquashFS')
        with disk.open('ab') as stream:
            stream.write(bytes(-stream.tell() % (256 * 1024)))
        expected = receipt['files'][disk.name]
        if disk.stat().st_size != expected['bytes'] or digest(disk) != expected['sha256']:
            raise ValueError(f'Chromium disk differs from release receipt: {digest(disk)}')
        notice = scratch / 'chromium-copyright.txt'
        with notice.open('wb') as out:
            for name, content in sorted(notices.items()):
                out.write(name.encode() + b'\n\n' + content + b'\n\n')
        expected = receipt['files'][notice.name]
        if notice.stat().st_size != expected['bytes'] or digest(notice) != expected['sha256']:
            raise ValueError('Extracted package notices differ from the release receipt')
        notice.replace(output / notice.name)
        disk.replace(output / disk.name)


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('archives', type=Path)
    cli.add_argument('output', type=Path)
    args = cli.parse_args()
    build(args.archives, args.output)
