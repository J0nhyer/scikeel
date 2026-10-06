#!/usr/bin/env python3
"""Bounded, resumable ranged download of an immutable GitHub CI artifact."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

CHUNK = 512 * 1024
MAXIMUM = 2 * 1024 ** 3
ALLOWED = {'rootfs.tar.gz', 'image-manifest.json', 'tool-lock.json', 'uv.lock', 'attestation.jsonl', 'python-image.txt', 'uv-image.txt'}


def validate_range(value, start, end, size):
    if value != f'bytes {start}-{end}/{size}':
        raise ValueError('Artifact range identity mismatch')


def extract_artifact(archive, destination):
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if not entries or len(entries) > len(ALLOWED) or len({entry.filename for entry in entries}) != len(entries):
            raise ValueError('Invalid CI artifact inventory')
        for entry in entries:
            if entry.filename not in ALLOWED or entry.is_dir() or entry.file_size > MAXIMUM or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError('Unsafe CI artifact entry')
            target = destination / entry.filename
            with source.open(entry) as reader, target.open('wb') as writer:
                shutil.copyfileobj(reader, writer, 256 * 1024)
            target.chmod(0o600)
        if not {'rootfs.tar.gz', 'image-manifest.json', 'tool-lock.json', 'uv.lock', 'attestation.jsonl'} <= {entry.filename for entry in entries}:
            raise ValueError('Missing immutable CI artifact inputs')


def artifact_url(artifact_id):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args):
            return None
    request = urllib.request.Request(f'https://api.github.com/repos/J0nhyer/scikeel/actions/artifacts/{artifact_id}/zip', headers={
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'})
    try:
        urllib.request.build_opener(NoRedirect()).open(request, timeout=20)
    except urllib.error.HTTPError as error:
        if error.code != 302:
            raise ValueError('CI artifact redirect unavailable') from None
        url = error.headers.get('Location', '')
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.blob.core.windows.net'):
            raise ValueError('Unexpected CI artifact transport')
        return url
    raise ValueError('Missing CI artifact redirect')


def download(artifact_id, size, destination):
    if not 0 < size <= MAXIMUM:
        raise ValueError('Invalid CI artifact size')
    url = artifact_url(artifact_id)
    archive = destination.parent / 'artifact-download.zip'
    checkpoint = destination.parent / 'artifact-download.parts.json'
    completed = set()
    if archive.exists() and checkpoint.exists():
        state = json.loads(checkpoint.read_text())
        if state.get('artifactID') == artifact_id and state.get('size') == size and state.get('chunk') == CHUNK and archive.stat().st_size == size:
            completed = set(state['completed'])
    count = (size + CHUNK - 1) // CHUNK
    if any(not isinstance(index, int) or not 0 <= index < count for index in completed):
        raise ValueError('Invalid CI artifact checkpoint')
    descriptor = os.open(archive, os.O_RDWR | os.O_CREAT, 0o600)
    os.ftruncate(descriptor, size)
    lock = threading.Lock()
    deadline = time.monotonic() + 25 * 60
    destination.mkdir(parents=True, exist_ok=True)

    def save():
        temporary = checkpoint.with_suffix('.tmp')
        temporary.write_text(json.dumps({'artifactID': artifact_id, 'size': size, 'chunk': CHUNK, 'completed': sorted(completed)}))
        os.replace(temporary, checkpoint)

    def part(index):
        start = index * CHUNK
        end = min(size, start + CHUNK) - 1
        for attempt in range(3):
            if time.monotonic() >= deadline:
                raise TimeoutError('CI artifact deadline exceeded')
            try:
                request = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}', 'Accept-Encoding': 'identity'})
                with urllib.request.urlopen(request, timeout=30) as response:
                    if response.status != 206:
                        raise ValueError('Artifact range transport unavailable')
                    validate_range(response.headers.get('Content-Range'), start, end, size)
                    offset = start
                    while offset <= end:
                        chunk = response.read(min(64 * 1024, end - offset + 1))
                        if not chunk:
                            raise ValueError('Truncated CI artifact range')
                        if os.pwrite(descriptor, chunk, offset) != len(chunk):
                            raise ValueError('Incomplete CI artifact disk write')
                        offset += len(chunk)
                    if response.read(1):
                        raise ValueError('Oversized CI artifact range')
                with lock:
                    completed.add(index)
                    save()
                    if len(completed) % 32 == 0 or len(completed) == count:
                        print(f'CI artifact download: {len(completed)}/{count} verified ranges', flush=True)
                return
            except Exception:
                if attempt == 2:
                    raise ValueError('CI artifact range download failed') from None
                time.sleep(attempt + 1)

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=32) as executor:
            for _ in executor.map(part, [index for index in range(count) if index not in completed]):
                pass
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    extract_artifact(archive, destination)
    archive.unlink()
    checkpoint.unlink(missing_ok=True)
    print('Immutable CI artifact download completed.', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact-id', required=True, type=int)
    parser.add_argument('--size', required=True, type=int)
    parser.add_argument('--destination', required=True, type=Path)
    args = parser.parse_args()
    if args.artifact_id <= 0:
        raise ValueError('Invalid CI artifact identity')
    download(args.artifact_id, args.size, args.destination.resolve())


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('CI artifact download failed; publication remains gated.', file=sys.stderr)
        sys.exit(1)
