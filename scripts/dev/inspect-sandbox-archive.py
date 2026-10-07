"""Inspect an attested rootfs without extracting or executing its contents."""
import hashlib
import json
import posixpath
import sys
import tarfile


def inspect(path):
    entries = []
    tool_hashes = {}
    measured_paths = {"usr/local/bin/python3.12", "usr/local/bin/uv", "usr/bin/git", "usr/bin/rg",
                      "opt/scikeel/tools/bin/osd", "opt/scikeel/tools/bin/opencode",
                      "opt/scikeel/tools/bin/node", "opt/scikeel/tools/bin/codex", "opt/scikeel/tools/bin/claude",
                      "opt/scikeel/tools/runner.mjs", "opt/scikeel/tools/file-rpc.mjs", "opt/scikeel/tools/cli-jobs.mjs", "opt/scikeel/tools/project-environment.py", "opt/scikeel/tools/science-environment.mjs", "opt/scikeel/tools/collaboration.mjs"}
    known = set()
    total = 0
    with tarfile.open(path, mode="r|gz") as archive:
        for member in archive:
            name = member.name
            while name.startswith("./"):
                name = name[2:]
            name = name.rstrip("/") if member.isdir() else name
            if name in ("", ".") and member.isdir():
                continue
            if (len(name.encode("utf-8")) > 4096 or not name or name.startswith("/") or "\\" in name or "\x00" in name
                    or any(part in ("", ".", "..") for part in name.split("/")) or name in known):
                raise ValueError("unsafe archive path")
            kind = ("directory" if member.isdir() else "file" if member.isfile()
                    else "symlink" if member.issym() else "hardlink" if member.islnk() else None)
            if kind is None or member.size < 0:
                raise ValueError("unsafe archive type")
            entry = {"path": name, "type": kind, "size": member.size}
            if kind in ("symlink", "hardlink"):
                link = member.linkname
                if not link or "\x00" in link or "\\" in link:
                    raise ValueError("unsafe archive link")
                target = (link[1:] if link.startswith("/") else link if kind == "hardlink"
                          else posixpath.join(posixpath.dirname(name), link))
                target = posixpath.normpath(target)
                if target == ".." or target.startswith("../") or target.startswith("/"):
                    raise ValueError("unsafe archive link")
                entry["link"] = link
            if kind == "file" and name in measured_paths:
                digest = hashlib.sha256()
                with archive.extractfile(member) as file:
                    for block in iter(lambda: file.read(1024 * 1024), b""):
                        digest.update(block)
                tool_hashes[name] = digest.hexdigest()
            known.add(name)
            entries.append(entry)
            total += member.size
            if len(entries) > 100000 or total > 2 * 1024 ** 3:
                raise ValueError("archive exceeds limit")
    # A file may not be placed beneath a symlink/hardlink, even an in-image link.
    links = {entry["path"] for entry in entries if entry["type"] in ("symlink", "hardlink")}
    for entry in entries:
        parent = posixpath.dirname(entry["path"])
        while parent:
            if parent in links:
                raise ValueError("archive entry beneath a link")
            parent = posixpath.dirname(parent)
    return {"entries": entries, "fileCount": len(entries), "uncompressedBytes": total, "toolHashes": tool_hashes}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("archive path required")
        print(json.dumps(inspect(sys.argv[1])))
    except (ValueError, OSError, tarfile.TarError):
        print("image archive verification failed", file=sys.stderr)
        sys.exit(1)
