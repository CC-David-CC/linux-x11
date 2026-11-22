"""Build the graphical initramfs from the CLI base and pinned Debian i386 inputs."""
import argparse
import contextlib
import gzip
import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BINARIES = {'xwininfo', 'xclock', 'xterm', 'twm', 'xauth', 'xkbcomp', 'mkfontdir', 'mkfontscale'}
DATA = ('usr/share/X11/', 'usr/share/fonts/X11/', 'usr/share/fonts/truetype/dejavu/',
        'usr/share/common-licenses/', 'etc/X11/', 'etc/fonts/', 'usr/lib/xorg/')


@contextlib.contextmanager
def archive(path):
    with subprocess.Popen(['dpkg-deb', '--fsys-tarfile', path], stdout=subprocess.PIPE) as process:
        with tarfile.open(fileobj=process.stdout, mode='r|') as tar:
            yield tar
        if process.wait():
            raise RuntimeError(f'Cannot read {path.name}')


def digest(path):
    with path.open('rb') as data:
        return hashlib.file_digest(data, 'sha256').hexdigest()


def kernel_overlay(tar, output, expected_kernel, chromium=False):
    modules = {}
    matched = False
    with tempfile.TemporaryDirectory() as tmp:
        for item in tar:
            name = PurePosixPath(item.name).name
            if item.isfile() and name.endswith('.ko'):
                path = Path(tmp, name)
                path.write_bytes(tar.extractfile(item).read())
                modules[path.stem.replace('-', '_')] = path
            elif item.isfile() and item.name.startswith('./boot/vmlinuz-'):
                matched = hashlib.sha256(tar.extractfile(item).read()).hexdigest() == expected_kernel
        if not matched:
            raise ValueError('Module package does not match the kernel used by the emulator')
        order = []
        def include(name):
            if name in order:
                return
            path = modules[name]
            deps = subprocess.check_output(['modinfo', '-F', 'depends', path], text=True).strip()
            for dep in filter(None, deps.split(',')):
                include(dep.replace('-', '_'))
            output['x11/modules/' + path.name] = (0o100644, path.read_bytes())
            order.append(name)
        drivers = ('bochs', 'evdev', 'psmouse')
        if chromium:
            drivers += ('ata_piix', 'sd_mod', 'squashfs')
        for name in drivers:
            include(name)
        output['x11/modules/load-order'] = (0o100644, ''.join(modules[n].name+'\n' for n in order).encode())


def select(name):
    path = PurePosixPath(name)
    if name.startswith(DATA) or (path.parent == PurePosixPath('usr/bin') and path.name in BINARIES):
        return True
    return ((str(path.parent) in ('lib/i386-linux-gnu', 'usr/lib/i386-linux-gnu') and '.so' in path.name)
            or name == 'lib/ld-linux.so.2' or (name.startswith('usr/share/doc/') and path.name == 'copyright'))


def add_entry(stream, inode, name, mode, data):
    encoded = name.encode()+b'\0'
    fields = (inode, mode, 0, 0, 1, 0, len(data), 0, 0, 0, 0, len(encoded), 0)
    stream.write(b'070701'+''.join(f'{v:08x}' for v in fields).encode()+encoded)
    stream.write(b'\0' * (-(110+len(encoded)) % 4))
    stream.write(data)
    stream.write(b'\0' * (-len(data) % 4))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archives', type=Path)
    parser.add_argument('base_initrd', type=Path)
    parser.add_argument('kernel', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--chromium', action='store_true')
    args = parser.parse_args()
    base_hash, kernel_hash = (ROOT/'base.sha256').read_text().split()
    if digest(args.base_initrd) != base_hash or digest(args.kernel) != kernel_hash:
        raise ValueError('Unexpected base guest or kernel')
    output = {}
    for line in (ROOT/'packages.sha256').read_text().splitlines():
        checksum, filename = line.split()
        path = args.archives / filename
        if digest(path) != checksum:
            raise ValueError(f'Package hash mismatch for {filename}')
        with archive(path) as tar:
            if filename.startswith('linux-image-'):
                kernel_overlay(tar, output, kernel_hash, args.chromium)
                continue
            for item in tar:
                name = item.name.removeprefix('./')
                if not select(name):
                    continue
                if item.issym():
                    output[name] = (stat.S_IFLNK | 0o777, item.linkname.encode())
                elif item.isfile():
                    output[name] = (stat.S_IFREG | (item.mode & 0o777), tar.extractfile(item).read())
    for name in ('init', 'session.sh', 'drop-privileges.py', 'xorg.conf', 'twmrc'):
        path = ROOT / 'guest' / name
        output['x11/'+name] = (0o100755 if name == 'init' else 0o100644, path.read_bytes())
    if args.chromium:
        output['usr/bin/chromium'] = (0o100755, (ROOT/'guest/chromium').read_bytes())
    # Debian installs these aliases into the generated X font directory.
    output['usr/share/fonts/X11/misc/fonts.alias'] = output['etc/X11/fonts/misc/xfonts-base.alias']
    for name in list(output):
        for parent in PurePosixPath(name).parents:
            if str(parent) != '.':
                output.setdefault(str(parent), (0o40755, b''))
    # Multiple aligned newc archives in one compressed initramfs are supported by Linux.
    with tempfile.NamedTemporaryFile(dir=args.output.parent, delete=False) as tmp:
        try:
            with gzip.GzipFile(fileobj=tmp, mode='wb', filename='', compresslevel=3, mtime=0) as gz:
                with gzip.open(args.base_initrd, 'rb') as base:
                    shutil.copyfileobj(base, gz)
                gz.write(b'\0' * (-gz.tell() % 4))
                for i,(name,(mode,data)) in enumerate(sorted(output.items()), start=1):
                    add_entry(gz,i,name,mode,data)
                add_entry(gz,0,'TRAILER!!!',0,b'')
            tmp.flush()
            os.replace(tmp.name,args.output)
        finally:
            Path(tmp.name).unlink(missing_ok=True)

if __name__ == '__main__':
    main()
