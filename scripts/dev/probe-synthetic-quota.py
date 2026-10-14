"""Exercise real kernel quotas on the fixed synthetic volume, never user roots."""
import ctypes
import errno
import json
import os
import pathlib
import shutil
import stat
import sys

ROOT=pathlib.Path('/var/lib/scikeel/fixture-data')

def exercise():
    a=ROOT/'instances/sandbox-test-a/workspace'
    b=ROOT/'instances/sandbox-test-b/workspace'
    owned=a/'.quota-enforcement-test'
    if owned.exists():
        raise ValueError('stale quota fixture requires explicit cleanup')
    owned.mkdir(mode=0o700)
    evidence={'scope':'synthetic-volume-kernel','byteLimitRejected':False,'inodeLimitRejected':False,'peerUnaffected':False}
    try:
        with open(owned/'bytes','xb',buffering=0) as output:
            block=b'x'*(512*1024)
            try:
                for _ in range(132):
                    output.write(block)
                raise ValueError('kernel did not enforce the 64 MiB quota')
            except OSError as error:
                if error.errno!=errno.EDQUOT:
                    raise ValueError('byte limit was not enforced by project quota') from None
                evidence['byteLimitRejected']=True
        (owned/'bytes').unlink()
        try:
            for index in range(1100):
                with open(owned/str(index),'xb'):
                    pass
            raise ValueError('kernel did not enforce the 1024 inode quota')
        except OSError as error:
            if error.errno!=errno.EDQUOT:
                raise ValueError('inode limit was not enforced by project quota') from None
            evidence['inodeLimitRejected']=True
        peer=b/'.quota-peer-canary'
        with open(peer,'xb') as output:
            output.write(b'synthetic-peer-unaffected')
        evidence['peerUnaffected']=peer.read_bytes()==b'synthetic-peer-unaffected'
        peer.unlink()
    finally:
        shutil.rmtree(owned)
    print(json.dumps(evidence),flush=True)

def run():
    if os.geteuid()!=0 or len(sys.argv)!=1:
        raise ValueError('root and fixed synthetic configuration required')
    marker=pathlib.Path('/var/lib/scikeel/fixture-quota.json')
    info=marker.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
        raise ValueError('untrusted fixture receipt')
    value=json.loads(marker.read_text())
    if value.get('synthetic') is not True or value.get('capacity')!=256*1024**2:
        raise ValueError('synthetic fixture only')
    # Test as the unprivileged account identity, not root with quota override privileges.
    os.setgroups([]);os.setgid(1000);os.setuid(1000)
    exercise()

if __name__=='__main__':
    try:
        run()
    except Exception as error:
        print('kernel quota probe failed: '+(str(error) if isinstance(error,ValueError) else type(error).__name__),file=sys.stderr)
        sys.exit(1)
