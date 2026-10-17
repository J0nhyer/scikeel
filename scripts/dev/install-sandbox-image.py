"""Root-owned attested image installer: fixed destination, no archive hooks."""
import hashlib
import importlib.util
import json
import os
import pathlib
import posixpath
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import re

# Installed beside this script, owned by root and inaccessible to tenants.
spec = importlib.util.spec_from_file_location("archive_inspector", pathlib.Path(__file__).with_name("inspect-sandbox-archive.py"))
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


def extract_checked(archive_path, destination):
    listing = inspector.inspect(archive_path)
    destination = pathlib.Path(destination)
    if destination.is_symlink() or not destination.is_dir() or any(destination.iterdir()):
        raise ValueError("new empty image destination required")
    entries = {entry["path"]: entry for entry in listing["entries"]}
    links = []
    directories = set()
    with tarfile.open(archive_path, mode="r|gz") as archive:
        for member in archive:
            name = member.name
            while name.startswith("./"):
                name = name[2:]
            name = name.rstrip("/") if member.isdir() else name
            if name in ("", ".") and member.isdir():
                continue
            if name not in entries:
                raise ValueError("archive changed after inspection")
            target = destination / name
            # Links are constructed last, so parent traversal cannot follow archive links.
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            if member.isdir():
                target.mkdir(exist_ok=True, mode=0o755)
                directories.add(target)
            elif member.isfile():
                mode = member.mode & 0o755  # Strip setuid/setgid and group/world writes.
                with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode), "wb") as output:
                    with archive.extractfile(member) as source:
                        shutil.copyfileobj(source, output, 1024 * 1024)
                os.chmod(target, mode)
            else:
                links.append((target, entries[name]))
    for target, entry in links:
        link = entry["link"]
        normalized = posixpath.normpath(link.lstrip("/") if link.startswith("/") else link if entry["type"] == "hardlink"
                                      else posixpath.join(posixpath.dirname(entry["path"]), link))
        if entry["type"] == "symlink":
            os.symlink(posixpath.relpath(normalized, posixpath.dirname(entry["path"]) or "."), target)
        else:
            source = destination / normalized
            if not source.is_file() or source.is_symlink():
                raise ValueError("hardlink target must be an installed regular file")
            os.link(source, target, follow_symlinks=False)
    for directory in directories:
        os.chmod(directory, 0o755)
    os.chmod(destination, 0o755)
    return listing


def trusted_path(path, directory):
    path = pathlib.Path(path)
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("untrusted installation path")
    if directory and not path.is_dir():
        raise ValueError("invalid installation directory")


def copy_regular(source, target, maximum):
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ValueError("invalid artifact file")
        with open(target, "xb") as output:
            size = 0
            while block := file.read(1024 * 1024):
                size += len(block)
                if size > maximum:
                    raise ValueError("artifact exceeds budget")
                output.write(block)
        os.chmod(target, 0o600)


def digest(path):
    with open(path, "rb") as file:
        hash = hashlib.sha256()
        for block in iter(lambda: file.read(1024 * 1024), b""):
            hash.update(block)
        return hash.hexdigest()


def validate_native(manifest, listing, tool_lock):
    if "codex" not in manifest.get("enabledRuntimes", []):
        if manifest.get("codexRuntime"):
            raise ValueError("unexpected native integration")
        return
    native = manifest.get("codexRuntime", {})
    integration = native.get("integration", {})
    resources = native.get("resources", {})
    managed_sources = {
        "opt/scikeel/tools/native-tools.mjs": "runtime/sandbox/native-tools.mjs",
        "opt/scikeel/runtime/required-effect-guard.mjs": "runtime/sandbox/required-effect-guard.mjs",
        "opt/scikeel/tools/codex-requirements.toml": "runtime/sandbox/codex-requirements.toml",
        "etc/codex/requirements.toml": "runtime/sandbox/codex-requirements.toml",
        "opt/scikeel/tools/native-network.mjs": "runtime/sandbox/native-network.mjs",
        "opt/scikeel/tools/native-network.py": "runtime/sandbox/native-network.py",
    }
    expected = {"opt/scikeel/tools/bin/codex-resources/bwrap", "opt/scikeel/tools/bin/native-integration.json"} | set(managed_sources)
    tool = manifest.get("tools", {}).get("codex", {})
    fixed = {"schema": 1, "policy": "required-effect-guard-v1", "upstreamVersion": "0.157.1",
             "upstreamCommit": "36650394c5b38c2990ccf2a3457165ca3e9d9726", "rustVersion": "1.95.0",
             "target": "x86_64-unknown-linux-gnu", "lockFormat": "smol-toml@1.9.0", "version": "codex-cli 0.157.1"}
    hashes = {"patchSha256", "testPatchSha256", "upstreamLockSha256", "workspaceLockSha256", "bwrapSha256", "binarySha256"}
    if (set(native) != {"integration", "resources"} or set(integration) != set(fixed) | hashes | {"source"}
            or any(integration.get(key) != value for key, value in fixed.items())
            or any(not re.fullmatch(r"[a-f0-9]{64}", str(integration.get(key, ""))) for key in hashes)
            or integration.get("source") != manifest.get("provenance", {}).get("commit")
            or tool.get("path") != "opt/scikeel/tools/bin/codex" or tool.get("version") != "0.157.1"
            or tool.get("sha256") != integration.get("binarySha256") or set(resources) != expected
            or resources.get("opt/scikeel/tools/bin/codex-resources/bwrap") != integration.get("bwrapSha256")
            or listing.get("nativeIntegration") != integration
            or listing.get("toolHashes", {}).get(tool.get("path")) != tool.get("sha256")
            or any(entry["path"].startswith("opt/scikeel/tools/bin/codex-resources/") and entry["path"] not in expected
                   for entry in listing.get("entries", []))
            or any(listing.get("toolHashes", {}).get(path) != sha for path, sha in resources.items())):
        raise ValueError("immutable native integration resource mismatch")
    sources = manifest.get("sourceInputs", [])
    if not isinstance(sources, list) or len(sources) > 10000:
        raise ValueError("invalid native source inputs")
    source_map = {}
    for source in sources:
        if (not isinstance(source, dict) or set(source) != {"path", "sha256"}
                or not isinstance(source.get("path"), str) or source["path"] in source_map
                or not re.fullmatch(r"[a-f0-9]{64}", str(source.get("sha256", "")))):
            raise ValueError("invalid native source inputs")
        source_map[source["path"]] = source["sha256"]
    if (source_map.get("runtime/codex-patches/required-effect-guard.patch") != integration["patchSha256"]
            or source_map.get("runtime/codex-patches/required-effect-guard-tests.patch") != integration["testPatchSha256"]
            or "runtime/codex-patches/required-effect-guard.lock.json" not in source_map
            or "scripts/dev/build-codex-guard-runtime.mjs" not in source_map
            or "scripts/dev/probe-production-runner.mjs" not in source_map
            or "services/platform/fixtures/native-protocol.mjs" not in source_map
            or any(resources[path] != source_map.get(source) for path, source in managed_sources.items())
            or tool_lock.get("schema") != 1 or tool_lock.get("codexRuntime") != native
            or tool_lock.get("sourceInputs") != sources or tool_lock.get("tools", {}).get("codex") != tool
            or tool_lock.get("baselineLockSha256") != manifest.get("baselineLockSha256")):
        raise ValueError("immutable native tool lock source mismatch")


def install(artifact_root):
    if os.geteuid() != 0:
        raise ValueError("root installation required")
    destination = pathlib.Path("/var/lib/scikeel/images")
    trusted_path(destination, True)
    trusted_path("/usr/local/lib/scikeel/gh", False)
    trusted_path(__file__, False)
    trusted_path(pathlib.Path(__file__).with_name("inspect-sandbox-archive.py"), False)
    with tempfile.TemporaryDirectory(prefix=".image-stage-", dir=destination) as temporary:
        temporary = pathlib.Path(temporary)
        artifacts = temporary / "artifacts"
        artifacts.mkdir(mode=0o700)
        for name, maximum in [("image-manifest.json", 1024**2), ("rootfs.tar.gz", 2 * 1024**3),
                              ("uv.lock", 32 * 1024**2), ("tool-lock.json", 32 * 1024**2), ("attestation.jsonl", 32 * 1024**2)]:
            copy_regular(pathlib.Path(artifact_root) / name, artifacts / name, maximum)
        environment = {"PATH": "/usr/bin:/bin", "HOME": "/var/lib/scikeel/launcher", "GH_HOST": "github.com"}
        # Verify the copied, root-controlled bytes again, independently of the caller's report.
        for name in ["rootfs.tar.gz", "image-manifest.json"]:
            subprocess.run(["/usr/local/lib/scikeel/gh", "attestation", "verify", str(artifacts / name),
                            "--repo", "J0nhyer/scikeel", "--bundle", str(artifacts / "attestation.jsonl"),
                            "--signer-workflow", "J0nhyer/scikeel/.github/workflows/sandbox-image.yml",
                            "--deny-self-hosted-runners"], env=environment, check=True, timeout=60,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        manifest = json.loads((artifacts / "image-manifest.json").read_bytes())
        root_digest = digest(artifacts / "rootfs.tar.gz")
        if (manifest.get("schema") != 1 or manifest.get("name") != "science-v1" or manifest.get("architecture") != "linux/amd64"
                or manifest.get("variant") not in ["probe", "production"] or manifest.get("rootfsSha256") != root_digest
                or manifest.get("imageDigest") != "sha256:" + root_digest
                or manifest.get("baselineLockSha256") != digest(artifacts / "uv.lock")
                or manifest.get("toolLockSha256") != digest(artifacts / "tool-lock.json")):
            raise ValueError("immutable artifact mismatch")
        final = destination / root_digest
        if final.exists():
            trusted_path(final, True)
            if json.loads((final / "ready.json").read_bytes()).get("imageDigest") != manifest["imageDigest"]:
                raise ValueError("existing image is incomplete")
            return {"installed": True, "existing": True, "imageDigest": manifest["imageDigest"]}
        if shutil.disk_usage(destination).free < manifest["uncompressedBytes"] + 600 * 1024**2:
            raise ValueError("insufficient image staging storage")
        root = temporary / "rootfs"
        root.mkdir(mode=0o755)
        listing = extract_checked(artifacts / "rootfs.tar.gz", root)
        if listing["fileCount"] != manifest["fileCount"] or listing["uncompressedBytes"] != manifest["uncompressedBytes"]:
            raise ValueError("immutable archive inventory mismatch")
        for tool in manifest["tools"].values():
            if listing["toolHashes"].get(tool["path"]) != tool["sha256"]:
                raise ValueError("immutable installed tool mismatch")
        for name, expected in manifest.get('runnerFiles', {}).items():
            if listing['toolHashes'].get(name) != expected:
                raise ValueError('immutable installed runner mismatch')
        validate_native(manifest, listing, json.loads((artifacts / "tool-lock.json").read_bytes()))
        if manifest["variant"] == "production" and any(e["path"] == "opt/scikeel/tools/probe-entry.mjs" for e in listing["entries"]):
            raise ValueError("test entrypoint in production image")
        for name in ["image-manifest.json", "uv.lock", "tool-lock.json", "attestation.jsonl"]:
            os.rename(artifacts / name, temporary / name)
            os.chmod(temporary / name, 0o644)
        shutil.rmtree(artifacts)
        (temporary / "ready.json").write_text(json.dumps({"schema": 1, "imageDigest": manifest["imageDigest"]}) + "\n")
        os.chmod(temporary / "ready.json", 0o644)
        os.chmod(temporary, 0o755)
        # Atomic visibility: no service sees partially extracted image contents.
        os.rename(temporary, final)
        descriptor = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return {"installed": True, "existing": False, "imageDigest": manifest["imageDigest"]}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("artifact directory required")
        print(json.dumps(install(sys.argv[1])))
    except Exception as error:
        print("attested image installation failed: " + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
