"""Actual uv/venv transaction probe with a tiny, public-only local wheel index."""
import hashlib
import http.server
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import threading
import zipfile

source = pathlib.Path(__file__).parents[3] / 'runtime/sandbox/project-environment.py'
spec = importlib.util.spec_from_file_location('environment_helper', source)
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
helper.BASE = sys.executable
helper.UV = '/opt/open-science-desktop/.deploy/osd/releases/0.5.2/uv'
def fixture_run(argv, project, env, timeout=45):
    result = helper.subprocess.run(argv, cwd=f'/proc/self/fd/{project}', pass_fds=(project,), env=env, capture_output=True, timeout=timeout)
    if result.returncode:
        raise ValueError(result.stderr.decode().replace('a'*64, '[synthetic capability]'))
    return result.stdout
helper.run = fixture_run
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w') as wheel:
    wheel.writestr('scikeel_fixture.py', 'VALUE = "private-environment-fixture"\n')
    wheel.writestr('scikeel_fixture-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\nName: scikeel-fixture\nVersion: 1.0\n')
    wheel.writestr('scikeel_fixture-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\nGenerator: SciKeel\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
    wheel.writestr('scikeel_fixture-1.0.dist-info/RECORD', '')
archive = buffer.getvalue(); digest = hashlib.sha256(archive).hexdigest()
downloads = 0
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        global downloads
        if self.path == '/root/pypi/+simple/scikeel-fixture/':
            data = f'<a href="/root/pypi/+f/abc/def1234567890a/scikeel_fixture-1.0-py3-none-any.whl#sha256={digest}">fixture</a>'.encode()
        elif self.path.startswith('/root/pypi/+f/'):
            downloads += 1; data = archive
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header('Content-Length', len(data)); self.send_header('Content-Type', 'text/html' if self.path.endswith('/') else 'application/octet-stream'); self.end_headers(); self.wfile.write(data)
    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
helper.PACKAGE_ORIGIN = f'127.0.0.1:{server.server_address[1]}'
try:
    with tempfile.TemporaryDirectory(prefix='scikeel-private-env-') as temporary:
        root = pathlib.Path(temporary); (root/'workspace/project').mkdir(parents=True); (root/'home').mkdir()
        project = root/'workspace/project'; lock = f'scikeel-fixture==1.0 --hash=sha256:{digest}\n'.encode()
        (project/'requirements.lock').write_bytes(lock)
        manifest = {'workspaceDir': str(root/'workspace'), 'home': str(root/'home')}
        request = {'operation': 'inspect', 'project': 'project', 'imageDigest': 'sha256:'+'a'*64}
        inspected = helper.transaction(request, manifest); assert inspected['venvState'] == 'absent'
        assert inspected['packages'] == ['scikeel-fixture']
        for rejected in ['../peer', '/etc', 'project/../project']:
            try:
                helper.transaction({**request, 'project': rejected}, manifest)
                raise AssertionError('unsafe project accepted')
            except ValueError:
                pass
        install = {**request, 'operation': 'stage', 'inputHash': inspected['inputHash'], 'packageToken': 'a'*64}
        staged = helper.transaction(install, manifest); assert staged['standalone'] and staged['stableInterpreter']
        published = helper.transaction({**install, 'operation': 'publish', 'stageId': staged['stageId']}, manifest)
        assert published['venvState'] == 'valid'
        recorded = json.loads((project/'.venv/scikeel-environment.json').read_text())
        assert recorded['imageDigest'] == request['imageDigest'] and recorded['lockHash'] == staged['lockHash']
        assert recorded['runtimeIdentity']['python'] == sys.version.split()[0]
        assert recorded['runtimeIdentity']['os'] == 'linux' and recorded['runtimeIdentity']['architecture'] == 'x86_64'
        assert recorded['runtimeIdentity']['uv'] and recorded['inventory'] == staged['inventory']
        code = 'import scikeel_fixture,sys;assert scikeel_fixture.VALUE=="private-environment-fixture";print(sys.prefix)'
        result = helper.subprocess.run([str(project/'.venv/bin/python'), '-I', '-c', code], capture_output=True, timeout=10)
        assert result.returncode == 0 and result.stdout.decode().strip() == str(project/'.venv')
        # Changed hashes cannot authorize a new stage, and a failed wheel fetch leaves the old interpreter intact.
        (project/'requirements.lock').write_bytes(lock.replace(digest.encode(), b'b'*64))
        try:
            helper.transaction(install, manifest)
            raise AssertionError('changed input accepted')
        except ValueError:
            pass
        changed = helper.transaction(request, manifest)
        try:
            helper.transaction({**install, 'inputHash': changed['inputHash']}, manifest)
            raise AssertionError('incorrect wheel hash accepted')
        except ValueError:
            pass
        assert (project/'.venv/bin/python').exists()
        assert not list(project.glob('.scikeel-env-*'))
        print(json.dumps({'realUv': True, 'standalone': True, 'stableInterpreter': True, 'wheelHashes': True, 'changedInputDenied': True, 'failedInstallPreservedPrevious': True, 'persistedIdentity': True}))
finally:
    server.shutdown(); server.server_close(); thread.join(timeout=2)
