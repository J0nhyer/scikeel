#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    const RESOLVE_BENEATH: u64 = 0x08;
    const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    const RESOLVE_NO_SYMLINKS: u64 = 0x04;
    const CONTROL_MAX: usize = 1024 * 1024;

    fn denied() -> io::Error {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "file is outside managed policy",
        )
    }
    fn relative(value: &str) -> io::Result<CString> {
        if value.is_empty()
            || value.starts_with('/')
            || value.contains('\\')
            || value
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(denied());
        }
        CString::new(value).map_err(|_| denied())
    }

    struct Root {
        descriptor: File,
        path: PathBuf,
    }

    pub struct ManagedFilePolicy {
        account: String,
        generation: u64,
        roots: HashMap<String, Root>,
    }

    #[derive(Clone)]
    pub struct FileTicket {
        account: String,
        generation: u64,
        root: String,
        root_device: u64,
        root_inode: u64,
        relative: String,
        expires: Instant,
    }

    #[derive(serde::Serialize)]
    pub struct PolicyEntry {
        pub name: String,
        #[serde(rename = "isDir")]
        pub is_dir: bool,
        pub size: u64,
        #[serde(rename = "modifiedAt")]
        pub modified_at: u64,
    }

    impl ManagedFilePolicy {
        pub fn new(
            account: String,
            generation: u64,
            roots: Vec<(String, PathBuf)>,
        ) -> io::Result<Self> {
            if account.is_empty() || generation == 0 || roots.is_empty() {
                return Err(denied());
            }
            let mut opened = HashMap::new();
            for (id, path) in roots {
                if id.is_empty()
                    || opened.contains_key(&id)
                    || !path.is_absolute()
                    || path.components().any(|part| {
                        matches!(
                            part,
                            std::path::Component::ParentDir | std::path::Component::CurDir
                        )
                    })
                {
                    return Err(denied());
                }
                let descriptor = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(
                        libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                    )
                    .open(&path)?;
                if !descriptor.metadata()?.is_dir() {
                    return Err(denied());
                }
                opened.insert(id, Root { descriptor, path });
            }
            Ok(Self {
                account,
                generation,
                roots: opened,
            })
        }
        pub fn root_path(&self, id: &str) -> io::Result<PathBuf> {
            Ok(self.root(id)?.path.clone())
        }
        fn root(&self, id: &str) -> io::Result<&Root> {
            self.roots.get(id).ok_or_else(denied)
        }
        fn open(
            &self,
            root: &File,
            name: &CStr,
            flags: i32,
            mode: u64,
            controls: bool,
        ) -> io::Result<File> {
            #[repr(C)]
            struct OpenHow {
                flags: u64,
                mode: u64,
                resolve: u64,
            }
            let nonblocking = if flags & libc::O_PATH != 0 {
                0
            } else {
                libc::O_NONBLOCK
            };
            let how = OpenHow {
                flags: (flags | libc::O_CLOEXEC | nonblocking) as u64,
                mode,
                resolve: RESOLVE_BENEATH
                    | RESOLVE_NO_MAGICLINKS
                    | if controls { RESOLVE_NO_SYMLINKS } else { 0 },
            };
            let result = unsafe {
                libc::syscall(
                    libc::SYS_openat2,
                    root.as_raw_fd(),
                    name.as_ptr(),
                    &how,
                    std::mem::size_of::<OpenHow>(),
                )
            };
            if result < 0 {
                return Err(io::Error::last_os_error());
            }
            // The successful syscall transfers ownership of exactly one descriptor.
            Ok(unsafe { File::from_raw_fd(result as i32) })
        }
        pub fn open_regular(&self, root: &str, name: &str, maximum: u64) -> io::Result<File> {
            let name = relative(name)?;
            let file = self.open(
                &self.root(root)?.descriptor,
                &name,
                libc::O_RDONLY,
                0,
                false,
            )?;
            let meta = file.metadata()?;
            if !meta.is_file() || meta.len() > maximum {
                return Err(denied());
            }
            Ok(file)
        }
        pub fn read_chunk(&self, root: &str, name: &str, offset: u64, limit: usize) -> io::Result<(Vec<u8>, u64)> {
            use std::io::{Seek, SeekFrom};
            if limit == 0 || limit > 256 * 1024 || offset > 25 * 1024 * 1024 { return Err(denied()); }
            let mut file = self.open_regular(root, name, 25 * 1024 * 1024)?;
            let size = file.metadata()?.len();
            if offset > size { return Err(denied()); }
            file.seek(SeekFrom::Start(offset))?;
            let mut bytes = Vec::new(); file.take(limit as u64).read_to_end(&mut bytes)?;
            Ok((bytes, size))
        }
        pub fn write_chunk(&self, root: &str, name: &str, offset: u64, bytes: &[u8]) -> io::Result<()> {
            use std::io::{Seek, SeekFrom};
            use std::os::unix::fs::MetadataExt;
            if bytes.len() > 256 * 1024 || offset > 25 * 1024 * 1024 || offset + bytes.len() as u64 > 25 * 1024 * 1024 { return Err(denied()); }
            let (parent, leaf) = self.parent(root, name)?;
            let flags = libc::O_WRONLY | if offset == 0 {libc::O_CREAT | libc::O_EXCL} else {0};
            let mut file = self.open(&parent, &leaf, flags, if offset == 0 {0o600} else {0}, true)?;
            if unsafe {libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB)} != 0 { return Err(denied()); }
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() != offset { return Err(denied()); }
            file.seek(SeekFrom::Start(offset))?; file.write_all(bytes)?; file.sync_all()?; parent.sync_all()
        }
        pub fn read(&self, root: &str, name: &str, maximum: u64) -> io::Result<Vec<u8>> {
            if maximum > 25 * 1024 * 1024 {
                return Err(denied());
            }
            let file = self.open_regular(root, name, maximum)?;
            let mut bytes = Vec::new();
            file.take(maximum + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > maximum {
                return Err(denied());
            }
            Ok(bytes)
        }
        pub fn ticket(&self, root: &str, name: &str, lifetime: Duration) -> io::Result<FileTicket> {
            self.open_regular(root, name, u64::MAX)?;
            if lifetime > Duration::from_secs(600) {
                return Err(denied());
            }
            let metadata = self.root(root)?.descriptor.metadata()?;
            Ok(FileTicket {
                root_device: metadata.dev(),
                root_inode: metadata.ino(),
                account: self.account.clone(),
                generation: self.generation,
                root: root.to_owned(),
                relative: name.to_owned(),
                expires: Instant::now().checked_add(lifetime).ok_or_else(denied)?,
            })
        }
        pub fn redeem(&self, ticket: &FileTicket) -> io::Result<File> {
            if ticket.account != self.account
                || ticket.generation != self.generation
                || Instant::now() >= ticket.expires
            {
                return Err(denied());
            }
            let metadata = self.root(&ticket.root)?.descriptor.metadata()?;
            if metadata.dev() != ticket.root_device || metadata.ino() != ticket.root_inode {
                return Err(denied());
            }
            self.open_regular(&ticket.root, &ticket.relative, u64::MAX)
        }
        pub fn scoped_path(&self, directory: &Path, name: &str) -> io::Result<(String, String)> {
            relative(name)?;
            let mut best = None;
            for (id, root) in &self.roots {
                if let Ok(prefix) = directory.strip_prefix(&root.path) {
                    let prefix = prefix.to_str().ok_or_else(denied)?;
                    if !prefix.is_empty() {
                        relative(prefix)?;
                    }
                    let combined = if prefix.is_empty() {
                        name.to_owned()
                    } else {
                        format!("{prefix}/{name}")
                    };
                    if best
                        .as_ref()
                        .map_or(true, |(_, _, length)| root.path.as_os_str().len() > *length)
                    {
                        best = Some((id.clone(), combined, root.path.as_os_str().len()));
                    }
                }
            }
            best.map(|(id, name, _)| (id, name)).ok_or_else(denied)
        }
        pub fn validate_directory(&self, path: &Path) -> io::Result<()> {
            let (root, scoped) = self.scoped_path(path, "probe")?;
            let relative = scoped.strip_suffix("probe").unwrap().trim_end_matches('/');
            self.directory(&root, relative, true)?;
            Ok(())
        }
        pub fn locate(&self, directory: &Path, name: &str) -> io::Result<Option<(String, String)>> {
            let (root, scoped) = self.scoped_path(directory, name)?;
            if self.open_regular(&root, &scoped, u64::MAX).is_ok() {
                return Ok(Some((root, scoped)));
            }
            // Only a bare basename triggers the existing bounded search behavior.
            if name.contains('/') {
                return Ok(None);
            }
            let prefix = self.scoped_path(directory, "probe")?.1;
            let prefix = prefix
                .strip_suffix("probe")
                .unwrap()
                .trim_end_matches('/')
                .to_owned();
            let mut stack = vec![(prefix, 0)];
            let mut seen = 0;
            let mut best: Option<(String, u64)> = None;
            while let Some((path, depth)) = stack.pop() {
                for entry in self.list(&root, &path, 10000)? {
                    seen += 1;
                    if seen > 10000 {
                        return Ok(best.map(|(name, _)| (root, name)));
                    }
                    if entry.name == "node_modules" || entry.name == "__pycache__" {
                        continue;
                    }
                    let relative = if path.is_empty() {
                        entry.name.clone()
                    } else {
                        format!("{path}/{}", entry.name)
                    };
                    if entry.is_dir && depth < 8 {
                        stack.push((relative, depth + 1));
                    } else if !entry.is_dir
                        && entry.name == name
                        && self.open_regular(&root, &relative, u64::MAX).is_ok()
                        && best
                            .as_ref()
                            .map_or(true, |(_, modified)| entry.modified_at > *modified)
                    {
                        best = Some((relative, entry.modified_at));
                    }
                }
            }
            Ok(best.map(|(name, _)| (root, name)))
        }
        fn directory(&self, root: &str, name: &str, controls: bool) -> io::Result<File> {
            let path = if name.is_empty() {
                CString::new(".").unwrap()
            } else {
                relative(name)?
            };
            self.open(
                &self.root(root)?.descriptor,
                &path,
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
                controls,
            )
        }
        fn parent(&self, root: &str, name: &str) -> io::Result<(File, CString)> {
            relative(name)?;
            let (parent, leaf) = name.rsplit_once('/').unwrap_or(("", name));
            Ok((self.directory(root, parent, true)?, relative(leaf)?))
        }
        pub fn mkdir_all(&self, root: &str, name: &str) -> io::Result<()> {
            relative(name)?;
            let mut prefix = String::new();
            for component in name.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(component);
                match self.mkdir(root, &prefix) {
                    Ok(()) => (),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        self.directory(root, &prefix, true)?;
                    }
                    Err(error) => return Err(error),
                }
            }
            Ok(())
        }
        pub fn inventory(&self, root: &str, start: &str) -> io::Result<Vec<(String, PolicyEntry)>> {
            let mut stack = vec![(start.to_owned(), 0)];
            let mut out = Vec::new();
            while let Some((path, depth)) = stack.pop() {
                for entry in self.list(root, &path, 10000)? {
                    if out.len() >= 10000 {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "inventory exceeds limit",
                        ));
                    }
                    if entry.name == "node_modules" || entry.name == "__pycache__" {
                        continue;
                    }
                    let relative = if path.is_empty() {
                        entry.name.clone()
                    } else {
                        format!("{path}/{}", entry.name)
                    };
                    if entry.is_dir && depth < 8 {
                        stack.push((relative.clone(), depth + 1));
                    }
                    out.push((relative, entry));
                }
            }
            Ok(out)
        }
        pub fn mkdir(&self, root: &str, name: &str) -> io::Result<()> {
            let (parent, leaf) = self.parent(root, name)?;
            if unsafe { libc::mkdirat(parent.as_raw_fd(), leaf.as_ptr(), 0o700) } < 0 {
                return Err(io::Error::last_os_error());
            }
            parent.sync_all()
        }
        pub fn write_atomic(&self, root: &str, name: &str, bytes: &[u8]) -> io::Result<()> {
            if bytes.len() > CONTROL_MAX {
                return Err(denied());
            }
            let (parent, leaf) = self.parent(root, name)?;
            // Refuse existing links/special files. renameat never follows the destination,
            // including if it changes after this check.
            let mut meta = std::mem::MaybeUninit::<libc::stat>::uninit();
            let result = unsafe {
                libc::fstatat(
                    parent.as_raw_fd(),
                    leaf.as_ptr(),
                    meta.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if result == 0 {
                if unsafe { meta.assume_init() }.st_mode & libc::S_IFMT != libc::S_IFREG {
                    return Err(denied());
                }
            } else if io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
                return Err(io::Error::last_os_error());
            }
            let temporary =
                CString::new(format!(".scikeel-{}.tmp", crate::runtime::random_hex(12))).unwrap();
            let result = (|| {
                let mut file = self.open(
                    &parent,
                    &temporary,
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW,
                    0o600,
                    true,
                )?;
                file.write_all(bytes)?;
                file.sync_all()?;
                if unsafe {
                    libc::renameat(
                        parent.as_raw_fd(),
                        temporary.as_ptr(),
                        parent.as_raw_fd(),
                        leaf.as_ptr(),
                    )
                } < 0
                {
                    return Err(io::Error::last_os_error());
                }
                parent.sync_all()
            })();
            if result.is_err() {
                unsafe {
                    libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0);
                }
            }
            result
        }
        pub fn unlink(&self, root: &str, name: &str) -> io::Result<()> {
            let (parent, leaf) = self.parent(root, name)?;
            let file = self.open(&parent, &leaf, libc::O_PATH | libc::O_NOFOLLOW, 0, true)?;
            if !file.metadata()?.is_file() {
                return Err(denied());
            }
            if unsafe { libc::unlinkat(parent.as_raw_fd(), leaf.as_ptr(), 0) } < 0 {
                return Err(io::Error::last_os_error());
            }
            parent.sync_all()
        }
        pub fn list(&self, root: &str, name: &str, maximum: usize) -> io::Result<Vec<PolicyEntry>> {
            if maximum == 0 || maximum > 10000 {
                return Err(denied());
            }
            let directory = self.directory(root, name, false)?;
            let fd = directory.into_raw_fd();
            let entries = unsafe { libc::fdopendir(fd) };
            if entries.is_null() {
                let error = io::Error::last_os_error();
                unsafe {
                    libc::close(fd);
                }
                return Err(error);
            }
            struct Dir(*mut libc::DIR);
            impl Drop for Dir {
                fn drop(&mut self) {
                    unsafe {
                        libc::closedir(self.0);
                    }
                }
            }
            let guard = Dir(entries);
            let dirfd = unsafe { libc::dirfd(guard.0) };
            let mut out = Vec::new();
            let mut seen = 0;
            loop {
                unsafe {
                    *libc::__errno_location() = 0;
                }
                let entry = unsafe { libc::readdir(guard.0) };
                if entry.is_null() {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(0) {
                        return Err(error);
                    }
                    break;
                }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                if name.to_bytes() == b"." || name.to_bytes() == b".." {
                    continue;
                }
                seen += 1;
                if seen > maximum {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "directory exceeds limit",
                    ));
                }
                let Ok(text) = name.to_str() else { continue };
                // Match existing browser filtering; never expose private metadata.
                if text.starts_with('.') {
                    continue;
                }
                let mut meta = std::mem::MaybeUninit::<libc::stat>::uninit();
                if unsafe {
                    libc::fstatat(
                        dirfd,
                        name.as_ptr(),
                        meta.as_mut_ptr(),
                        libc::AT_SYMLINK_NOFOLLOW,
                    )
                } < 0
                {
                    continue;
                }
                let meta = unsafe { meta.assume_init() };
                let kind = meta.st_mode & libc::S_IFMT;
                if kind != libc::S_IFREG && kind != libc::S_IFDIR {
                    continue;
                }
                out.push(PolicyEntry {
                    name: text.to_owned(),
                    is_dir: kind == libc::S_IFDIR,
                    size: meta.st_size.max(0) as u64,
                    modified_at: meta.st_mtime.max(0) as u64 * 1000,
                });
            }
            out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
            Ok(out)
        }
    }
}
#[cfg(target_os = "linux")]
pub use linux::*;

// Managed file access is rooted in launcher-approved descriptors, never in
// workspace metadata. The tests define the boundary before implementation.
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    struct Fixture {
        base: PathBuf,
        owned: PathBuf,
        peer: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir()
                .join(format!("scikeel-policy-{}", crate::runtime::random_hex(12)));
            let owned = base.join("owned");
            let peer = base.join("peer");
            std::fs::create_dir_all(&owned).unwrap();
            std::fs::create_dir_all(&peer).unwrap();
            std::fs::write(owned.join("note.txt"), b"owned").unwrap();
            std::fs::write(peer.join("secret"), b"peer-canary").unwrap();
            Self { base, owned, peer }
        }
        fn policy(&self, account: &str, generation: u64) -> ManagedFilePolicy {
            ManagedFilePolicy::new(
                account.to_string(),
                generation,
                vec![("account".to_string(), self.owned.clone())],
            )
            .unwrap()
        }
        fn read(&self, policy: &ManagedFilePolicy, name: &str) -> std::io::Result<Vec<u8>> {
            let mut data = Vec::new();
            policy
                .open_regular("account", name, 1024)?
                .read_to_end(&mut data)?;
            Ok(data)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn rejects_escape_and_non_regular_files() {
        let f = Fixture::new();
        let policy = f.policy("a", 1);
        symlink("note.txt", f.owned.join("internal")).unwrap();
        symlink("../peer/secret", f.owned.join("escape")).unwrap();
        symlink(&f.peer, f.owned.join("absolute")).unwrap();
        assert_eq!(f.read(&policy, "internal").unwrap(), b"owned");
        for path in [
            "escape",
            "absolute/secret",
            "../peer/secret",
            "/etc/passwd",
            "a//b",
            "a/./b",
            "",
        ] {
            assert!(f.read(&policy, path).is_err(), "{path}");
        }
        let fifo = std::ffi::CString::new(f.owned.join("pipe").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(f.read(&policy, "pipe").is_err());
        assert!(f.read(&policy, ".").is_err());
        assert!(policy.open_regular("foreign", "note.txt", 1024).is_err());
        assert!(policy.open_regular("account", "note.txt", 1).is_err());
    }

    #[test]
    fn tickets_reopen_under_owned_root_and_bind_generation_and_expiry() {
        let f = Fixture::new();
        let p = f.policy("a", 1);
        let ticket = p
            .ticket("account", "note.txt", std::time::Duration::from_secs(60))
            .unwrap();
        assert!(p.redeem(&ticket).is_ok());
        assert!(f.policy("b", 1).redeem(&ticket).is_err());
        assert!(f.policy("a", 2).redeem(&ticket).is_err());
        std::fs::write(f.peer.join("note.txt"), b"peer-canary").unwrap();
        let changed_root =
            ManagedFilePolicy::new("a".into(), 1, vec![("account".into(), f.peer.clone())])
                .unwrap();
        assert!(changed_root.redeem(&ticket).is_err());
        let expired = p
            .ticket("account", "note.txt", std::time::Duration::ZERO)
            .unwrap();
        assert!(p.redeem(&expired).is_err());
        std::fs::remove_file(f.owned.join("note.txt")).unwrap();
        symlink("../peer/secret", f.owned.join("note.txt")).unwrap();
        assert!(p.redeem(&ticket).is_err());
    }

    #[test]
    fn control_writes_and_listing_use_descriptors_and_refuse_links() {
        let f = Fixture::new();
        let p = f.policy("a", 1);
        p.mkdir("account", "reports").unwrap();
        p.write_atomic("account", "reports/result.json", b"{\"ok\":true}")
            .unwrap();
        assert_eq!(f.read(&p, "reports/result.json").unwrap(), b"{\"ok\":true}");
        symlink("reports", f.owned.join("linked")).unwrap();
        assert!(p.write_atomic("account", "linked/bad.json", b"x").is_err());
        assert!(p.write_atomic("account", "escape", b"x").is_ok());
        std::fs::remove_file(f.owned.join("escape")).unwrap();
        symlink("../peer/secret", f.owned.join("escape")).unwrap();
        assert!(p.write_atomic("account", "escape", b"x").is_err());
        let entries = p.list("account", "", 10).unwrap();
        assert!(entries
            .iter()
            .any(|entry| entry.name == "reports" && entry.is_dir));
        assert!(!entries
            .iter()
            .any(|entry| entry.name == "escape" || entry.name == "linked"));
        assert!(p.list("account", "", 1).is_err());
        p.unlink("account", "reports/result.json").unwrap();
        assert!(f.read(&p, "reports/result.json").is_err());
    }

    #[test]
    fn swapping_a_link_cannot_read_peer_bytes() {
        let f = Fixture::new();
        let p = f.policy("a", 1);
        let owned = f.owned.clone();
        let thread = std::thread::spawn(move || {
            for i in 0..1000 {
                let temporary = owned.join("swap.tmp");
                let _ = std::fs::remove_file(&temporary);
                symlink(
                    if i % 2 == 0 {
                        "note.txt"
                    } else {
                        "../peer/secret"
                    },
                    &temporary,
                )
                .unwrap();
                std::fs::rename(&temporary, owned.join("swap")).unwrap();
            }
        });
        for _ in 0..1000 {
            if let Ok(bytes) = f.read(&p, "swap") {
                assert_eq!(bytes, b"owned");
            }
        }
        thread.join().unwrap();
    }
    #[test]
    fn managed_previews_ignore_editable_workspace_markers_and_reject_peer_links() {
        let f = Fixture::new();
        let env = crate::Env::new(
            f.base.join("state"),
            f.base.join("res"),
            None,
            "test".into(),
        )
        .with_managed_files(f.policy("a", 1));
        let preview =
            crate::artifact_file::read_artifact(&env, "note.txt".into(), Some("base".into()))
                .unwrap();
        let value = serde_json::to_value(preview).unwrap();
        assert_eq!(value["data"], "owned");
        symlink("../peer/secret", f.owned.join("escape")).unwrap();
        assert!(
            crate::artifact_file::read_artifact(&env, "escape".into(), Some("base".into()))
                .is_err()
        );
        assert!(!crate::project::is_registered_project_path(&env, &f.peer));
    }

    #[test]
    fn managed_runs_query_and_logs_stay_owned_and_bounded() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.owned.join("sessions/one/.openscience/logs")).unwrap();
        let run = r#"{"runId":"run_owned","ts":1,"status":"ok","command":"python local.py","sessionId":"ses_owned","logHash":"abcd","code":[],"outputs":[]}"#;
        std::fs::write(
            f.owned.join("sessions/one/.openscience/runs.jsonl"),
            format!("{run}\n"),
        )
        .unwrap();
        std::fs::write(
            f.owned.join("sessions/one/.openscience/logs/abcd.txt"),
            "owned-log",
        )
        .unwrap();
        let env = crate::Env::new(
            f.base.join("state"),
            f.base.join("res"),
            None,
            "test".into(),
        )
        .with_managed_files(f.policy("a", 1));
        let page = crate::runs_index::query_runs_cmd(&env, Default::default()).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].run_id, "run_owned");
        assert_eq!(
            crate::runs::read_run_log(&env, "abcd").unwrap(),
            "owned-log"
        );
        assert!(crate::runs::read_run_log(&env, "../peer/secret").is_err());
        std::fs::remove_file(f.owned.join("sessions/one/.openscience/logs/abcd.txt")).unwrap();
        symlink(
            &f.peer.join("secret"),
            f.owned.join("sessions/one/.openscience/logs/abcd.txt"),
        )
        .unwrap();
        assert!(crate::runs::read_run_log(&env, "abcd").is_err());
    }

    #[test]
    fn notebook_inventory_and_writes_reject_linked_directories() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.owned.join("notebooks")).unwrap();
        std::fs::write(f.owned.join("notebooks/owned.ipynb"), "{}").unwrap();
        symlink(&f.peer, f.owned.join("foreign")).unwrap();
        let env = crate::Env::new(
            f.base.join("state"),
            f.base.join("res"),
            None,
            "test".into(),
        )
        .with_managed_files(f.policy("a", 1));
        let listed = crate::artifact_file::list_notebooks(&env, Some("base".into())).unwrap();
        assert_eq!(listed.len(), 1);
        crate::artifact_file::write_workspace_file(
            &env,
            "new/sub/owned.ipynb".into(),
            "{}".into(),
            None,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(f.owned.join("new/sub/owned.ipynb")).unwrap(),
            b"{}"
        );
        assert!(crate::artifact_file::write_workspace_file(
            &env,
            "foreign/evil.ipynb".into(),
            "{}".into(),
            None
        )
        .is_err());
        assert!(!f.peer.join("evil.ipynb").exists());
    }
    #[test]
    fn managed_project_listing_does_not_trust_external_source_metadata() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.owned.join("projects/study/.openscience")).unwrap();
        let metadata = serde_json::json!({ "id":"project_owned", "name":"Study", "version":1, "createdAt":1,
            "sourcePath": f.peer.to_string_lossy() });
        std::fs::write(f.owned.join("projects/study/.openscience/project.json"), metadata.to_string()).unwrap();
        let env = crate::Env::new(f.base.join("state"), f.base.join("res"), None, "test".into())
            .with_managed_files(f.policy("a", 1));
        let projects = crate::project::list_projects(&env).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, f.owned.join("projects/study").to_string_lossy());
        assert!(projects[0].imported_from.is_none());
    }

}
