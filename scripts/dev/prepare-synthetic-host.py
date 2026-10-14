"""Install the fixed, checksum-verified launcher fixture without changing platform routing."""
import hashlib,json,os,pathlib,shutil,stat,subprocess,tempfile
def hash_file(file, algorithm):
    hash=hashlib.new(algorithm)
    for block in iter(lambda:file.read(1024*1024),b''):
        hash.update(block)
    return hash.hexdigest()
ROOT=pathlib.Path('/usr/local/lib/scikeel')
EXPECTED='4ce35ca83aef7f96b06cde668e0b23aa98b05aa1829508e974196c2a1e02786c95f5bf79315fd7ddcfd88fe7a00f083ed8053e25eff7673d28d5256440caae8b'
SOURCE=pathlib.Path('/opt/open-science-desktop/.deploy/tenant-isolation-design-probe/gvisor.tar.zstd')
if os.geteuid()!=0:
    raise SystemExit('root required')
with tempfile.TemporaryDirectory(prefix='.runsc-stage-',dir=ROOT) as temporary:
    temporary=pathlib.Path(temporary);archive=temporary/'gvisor.tar.zstd'
    with os.fdopen(os.open(SOURCE,os.O_RDONLY|os.O_NOFOLLOW),'rb') as source,open(archive,'xb') as out:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise SystemExit('invalid source archive')
        shutil.copyfileobj(source,out,1024*1024)
    with open(archive,'rb') as file:
        if hash_file(file,'sha512')!=EXPECTED:
            raise SystemExit('pinned runsc archive checksum mismatch')
    for member in ['runsc','gvisor-bin/checkpointgofer','gvisor-bin/gvisor-sentry-prewarmer',
        'gvisor-bin/gvisor_sentry','gvisor-bin/runsc-fd-parking','gvisor-bin/runsc-metric-server']:
        target=temporary/member;target.parent.mkdir(exist_ok=True)
        with open(target,'xb') as out:
            subprocess.run(['/usr/bin/tar','--zstd','-xOf',str(archive),member],stdout=out,check=True,timeout=30)
        os.chmod(target,0o755)
    os.replace(temporary/'runsc',ROOT/'runsc')
    (ROOT/'gvisor-bin').mkdir(mode=0o755,exist_ok=True)
    for member in (temporary/'gvisor-bin').iterdir():
        os.replace(member,ROOT/'gvisor-bin'/member.name)
with open(ROOT/'runsc','rb') as file:
    digest=hash_file(file,'sha256')
quota=json.loads(pathlib.Path('/var/lib/scikeel/fixture-quota.json').read_text())
configuration={'schema':1,'platformUid':1000,'platformGid':1000,'socketPath':'/run/scikeel/host.sock',
 'stateDir':'/var/lib/scikeel/launcher','roots':{'instances':quota['instances'],'native':quota['native'],'images':'/var/lib/scikeel/images'},
 'runsc':str(ROOT/'runsc'),'runscSha256':digest,'quotaDevice':quota['device'],
 'quotaBackingFile':'/var/lib/scikeel/fixture-data.img','quotaCapacity':quota['capacity'],
 'quotaBytes':quota['byteLimit'],'quotaInodes':quota['inodeLimit'],'synthetic':True}
path=pathlib.Path('/etc/scikeel/sandbox-host.json')
if path.exists():
    raise SystemExit('existing launcher configuration must not be overwritten')
path.write_text(json.dumps(configuration,indent=2)+'\n');os.chmod(path,0o600)
print(json.dumps({'synthetic':True,'runscVersion':'release-20260928.0','runscSha256':digest,'configurationCreated':True}))
