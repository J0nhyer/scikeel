"""Fixed sandbox-only, descriptor-scoped private Python environment transactions."""
import ctypes
import hashlib
import importlib.metadata
import json
import os
import pathlib
import platform
import re
import secrets
import shutil
import stat
import subprocess
import sys

BASE = '/opt/scikeel/science/bin/python'
UV = '/opt/scikeel/tools/bin/uv'
PACKAGE_ORIGIN = '172.31.240.1:4793'
LIBC = ctypes.CDLL(None, use_errno=True)
class How(ctypes.Structure):
    _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64), ('resolve', ctypes.c_uint64)]

def secure(parent, name, directory=False):
    if not name or name.startswith('/') or any(part in ['', '..'] for part in name.split('/')):
        raise ValueError('invalid relative environment path')
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK | (os.O_DIRECTORY if directory else 0)
    how = How(flags=flags, resolve=0x08 | 0x02 | 0x04)
    descriptor = LIBC.syscall(437, parent, name.encode(), ctypes.byref(how), ctypes.sizeof(how))
    if descriptor < 0:
        raise OSError(ctypes.get_errno(), 'secure environment path unavailable')
    info = os.fstat(descriptor)
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        os.close(descriptor)
        raise ValueError('invalid environment input type')
    return descriptor

def read(parent, name, maximum=1024**2):
    descriptor = secure(parent, name)
    with os.fdopen(descriptor, 'rb') as file:
        if os.fstat(file.fileno()).st_size > maximum:
            raise ValueError('environment input exceeds budget')
        value = file.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError('environment input exceeds budget')
    return value

def requirements(value):
    text = value.decode('utf8').replace('\\\n', '')
    packages = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z0-9][A-Za-z0-9_.-]{0,127})==([A-Za-z0-9_.+!-]{1,128})((?:\s+--hash=sha256:[a-f0-9]{64})+)', line)
        if not match:
            raise ValueError('a fully pinned, hash-locked public wheel requirements.lock is required')
        packages.append(match.group(1).lower().replace('_', '-').replace('.', '-'))
    if not packages or len(packages) > 200 or len(set(packages)) != len(packages):
        raise ValueError('invalid public dependency set')
    return packages

def run(argv, project, env, timeout=240):
    result = subprocess.run(argv, cwd=f'/proc/self/fd/{project}', pass_fds=(project,), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
    if result.returncode or len(result.stdout) > 2*1024**2:
        raise ValueError('private environment operation failed')
    return result.stdout

def inventory(python, project, env):
    code = 'import importlib.metadata,json,sys;print(json.dumps({"prefix":sys.prefix,"packages":[{"name":d.metadata["Name"],"version":d.version} for d in importlib.metadata.distributions()]}))'
    return json.loads(run([python, '-I', '-c', code], project, env, timeout=10))

def inspect(project, project_path, image_digest):
    try:
        source = read(project, 'requirements.lock')
    except FileNotFoundError:
        source = None
    packages = requirements(source) if source is not None else []
    state = 'absent'
    try:
        environment = secure(project, '.venv', True)
    except FileNotFoundError:
        environment = None
    except OSError:
        state = 'broken'; environment = None
    if environment is not None:
        try:
            config = read(environment, 'pyvenv.cfg', 65536).decode('utf8')
            binary = secure(environment, 'bin', True)
            try:
                candidate = pathlib.Path(f'/proc/self/fd/{binary}/python').resolve(strict=True)
                expected = pathlib.Path(BASE).resolve(strict=True)
                if candidate != expected or not re.search(r'^include-system-site-packages\s*=\s*false\s*$', config, re.M | re.I):
                    raise ValueError('private interpreter is not standalone')
                site = secure(environment, f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages', True); os.close(site)
            finally:
                os.close(binary)
            record = json.loads(read(environment, 'scikeel-environment.json', 2*1024**2))
            identity = record.get('runtimeIdentity', {})
            if record.get('schema') != 1 or record.get('imageDigest') != image_digest or source is None or record.get('lockHash') != hashlib.sha256(source).hexdigest() or identity.get('python') != sys.version.split()[0] or identity.get('os') != 'linux' or identity.get('architecture') != platform.machine():
                raise ValueError('private environment identity needs repair')
            state = 'valid'
        except (OSError, ValueError, TypeError, AttributeError):
            state = 'broken'
        finally:
            os.close(environment)
    return {'owned': True, 'projectDir': project_path, 'imageDigest': image_digest, 'basePython': BASE,
            'inputHash': hashlib.sha256(source).hexdigest() if source is not None else None, 'packages': packages, 'venvState': state,
            **({'venvPython': project_path+'/.venv/bin/python'} if state == 'valid' else {})}

def transaction(request, manifest):
    if not isinstance(request, dict) or set(request) - {'operation', 'project', 'inputHash', 'imageDigest', 'packageToken', 'stageId'}:
        raise ValueError('invalid environment request')
    operation = request.get('operation')
    if operation not in ['inspect', 'stage', 'publish', 'discard'] or not re.fullmatch(r'sha256:[a-f0-9]{64}', request.get('imageDigest', '')):
        raise ValueError('invalid environment operation')
    relative = request.get('project')
    if not isinstance(relative, str) or relative.startswith('/') or '\\' in relative or any(part in ['', '.', '..'] for part in relative.split('/')):
        raise ValueError('owned relative project required')
    workspace = os.open(manifest['workspaceDir'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    project = secure(workspace, relative, True)
    project_path = manifest['workspaceDir']+'/'+relative
    env = {'PATH': '/opt/scikeel/tools/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': manifest['home'], 'LANG': 'C.UTF-8',
           'UV_PYTHON_DOWNLOADS': 'never', 'UV_LINK_MODE': 'copy', 'UV_CACHE_DIR': manifest['home']+'/.cache/uv',
           'PYTHONNOUSERSITE': '1', 'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1'}
    try:
        current = inspect(project, project_path, request['imageDigest'])
        if operation == 'inspect':
            return current
        if operation != 'discard' and request.get('inputHash') != current['inputHash']:
            raise ValueError('approved environment input changed')
        if operation == 'stage':
            token = request.get('packageToken', '')
            if not re.fullmatch(r'[a-f0-9]{64}', token):
                raise ValueError('approved public package capability required')
            stage_id = secrets.token_hex(32)
            name = '.scikeel-env-'+stage_id
            os.mkdir(name, mode=0o700, dir_fd=project)
            stage = secure(project, name, True)
            try:
                lock = read(project, 'requirements.lock')
                with os.fdopen(os.open('requirements.lock', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=stage), 'wb') as file:
                    file.write(lock); file.flush(); os.fsync(file.fileno())
                venv = project_path+'/'+name+'/.venv'
                run([UV, '--no-config', 'venv', '--no-project', '--relocatable', '--python', BASE, venv], project, env)
                run([UV, '--no-config', 'pip', 'install', '--require-hashes', '--no-deps', '--only-binary', ':all:',
                     '--python', venv+'/bin/python', '--index-url', f'http://scikeel:{token}@{PACKAGE_ORIGIN}/root/pypi/+simple/',
                     '--allow-insecure-host', PACKAGE_ORIGIN.split(':')[0], '-r', project_path+'/'+name+'/requirements.lock'], project, env)
                actual = inventory(venv+'/bin/python', project, env)
                if actual['prefix'] != venv:
                    raise ValueError('private environment prefix mismatch')
                # Activation scripts may embed the staging directory even in relocatable venvs.
                for file in pathlib.Path(venv+'/bin').iterdir():
                    if file.is_symlink() or not file.is_file() or file.stat().st_size > 1024**2:
                        continue
                    content = file.read_bytes()
                    if venv.encode() in content:
                        file.write_bytes(content.replace(venv.encode(), (project_path+'/.venv').encode()))
                record = {'stageId': stage_id, 'inputHash': current['inputHash'], 'imageDigest': request['imageDigest'],
                          'lockHash': hashlib.sha256(lock).hexdigest(), 'standalone': True, 'stableInterpreter': True,
                          'validated': True, 'inventory': actual['packages'], 'projectInode': os.fstat(project).st_ino,
                          'runtimeIdentity': {'os': 'linux', 'architecture': platform.machine(), 'python': sys.version.split()[0],
                                              'uv': run([UV, '--version'], project, env, timeout=10).decode().strip().split()[1]}}
                installed = {'schema': 1, 'kind': 'private', **{key: record[key] for key in ['imageDigest', 'lockHash', 'inputHash', 'inventory', 'runtimeIdentity']}}
                descriptor = secure(stage, '.venv', True)
                try:
                    with os.fdopen(os.open('scikeel-environment.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=descriptor), 'w') as file:
                        json.dump(installed, file); file.flush(); os.fsync(file.fileno())
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
                with os.fdopen(os.open('stage.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=stage), 'w') as file:
                    json.dump(record, file); file.flush(); os.fsync(file.fileno())
                return {key: value for key, value in record.items() if key != 'projectInode'}
            except Exception:
                shutil.rmtree(f'/proc/self/fd/{project}/{name}')
                raise
            finally:
                os.close(stage)
        stage_id = request.get('stageId', '')
        if not re.fullmatch(r'[a-f0-9]{64}', stage_id):
            raise ValueError('invalid environment staging identity')
        name = '.scikeel-env-'+stage_id
        stage = secure(project, name, True)
        try:
            record = json.loads(read(stage, 'stage.json', 2*1024**2))
            if record['stageId'] != stage_id or record['inputHash'] != request.get('inputHash') or record['imageDigest'] != request['imageDigest'] or record['projectInode'] != os.fstat(project).st_ino:
                raise ValueError('environment staging identity changed')
            if operation == 'discard':
                shutil.rmtree(f'/proc/self/fd/{project}/{name}')
                return {'discarded': True}
            backup = '.scikeel-old-env-'+stage_id
            previous = current['venvState'] != 'absent'
            if previous:
                os.rename('.venv', backup, src_dir_fd=project, dst_dir_fd=project)
            published = False
            try:
                os.rename('.venv', '.venv', src_dir_fd=stage, dst_dir_fd=project)
                published = True
                actual = inventory(project_path+'/.venv/bin/python', project, env)
                if actual['prefix'] != project_path+'/.venv' or sorted(actual['packages'], key=lambda p:p['name']) != sorted(record['inventory'], key=lambda p:p['name']):
                    raise ValueError('published environment validation failed')
                os.fsync(project)
            except Exception:
                if published:
                    os.rename('.venv', '.venv', src_dir_fd=project, dst_dir_fd=stage)
                if previous:
                    os.rename(backup, '.venv', src_dir_fd=project, dst_dir_fd=project)
                raise
            if previous:
                shutil.rmtree(f'/proc/self/fd/{project}/{backup}')
            shutil.rmtree(f'/proc/self/fd/{project}/{name}')
            return inspect(project, project_path, request['imageDigest'])
        finally:
            os.close(stage)
    finally:
        os.close(project); os.close(workspace)

def main():
    metadata = os.lstat('/opt/scikeel/tenant.json')
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022 or metadata.st_size > 65536:
        raise ValueError('untrusted tenant manifest')
    manifest = json.loads(pathlib.Path('/opt/scikeel/tenant.json').read_bytes())
    content = sys.stdin.buffer.read(65537)
    if len(content) > 65536:
        raise ValueError('environment request exceeds budget')
    request = json.loads(content)
    print(json.dumps(transaction(request, manifest)))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Private environment operation denied', file=sys.stderr)
        sys.exit(1)
