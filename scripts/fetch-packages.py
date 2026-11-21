"""Fetch the pinned graphical guest inputs using a Debian Bookworm APT configuration."""
import argparse
import hashlib
from pathlib import Path
import subprocess
from urllib.parse import unquote

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
args = parser.parse_args()
args.directory.mkdir(parents=True, exist_ok=True)
for line in (Path(__file__).resolve().parents[1] / 'packages.sha256').read_text().splitlines():
    sha, filename = line.split()
    path = args.directory / filename
    if not path.exists():
        name, version, arch = unquote(filename[:-4]).split('_')
        subprocess.run(['apt-get', 'download', f'{name}:{arch}={version}'],
                       cwd=args.directory, check=True)
    with path.open('rb') as data:
        if hashlib.file_digest(data, 'sha256').hexdigest() != sha:
            raise ValueError(f'Digest mismatch for {filename}')
