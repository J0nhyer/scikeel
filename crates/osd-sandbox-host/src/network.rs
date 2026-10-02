use crate::{config::Config, protocol::Result, registry::Account, secure};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, os::{fd::AsRawFd, unix::fs::{MetadataExt, OpenOptionsExt}},
    path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant}};

const IP: &str = "/usr/bin/ip";
const NFT: &str = "/usr/sbin/nft";
const BROKER_ADDRESS: &str = "172.31.240.1";

pub fn environment() -> Vec<String> {
    // Job-specific short-lived grants are added by the approved tool adapter.
    // A plain inherited proxy cannot turn networking on.
    vec!["HTTP_PROXY=http://172.31.240.1:4794", "HTTPS_PROXY=http://172.31.240.1:4794",
        "http_proxy=http://172.31.240.1:4794", "https_proxy=http://172.31.240.1:4794",
        "NO_PROXY=localhost,127.0.0.1,172.31.240.1", "no_proxy=localhost,127.0.0.1,172.31.240.1"]
        .into_iter().map(str::to_string).collect()
}

struct Policy {
    namespace: String, table: String, host_link: String, tenant_link: String, address: String, platform_uid: u32,
}
impl Policy {
    fn new(account: &Account, platform_uid: u32) -> Result<Self> {
        if !crate::protocol::identifier(&account.instance_id, 64) || !(2..=254).contains(&account.address)
            || account.generation == 0 || account.generation > 9_007_199_254_740_991 || platform_uid == 0 {
            return Err("invalid_network_identity");
        }
        let namespace = format!("scikeel-{}-g{}", account.instance_id, account.generation);
        let hash = format!("{:x}", Sha256::digest(namespace.as_bytes()));
        Ok(Self { table: format!("scikeel_t{}_g{}", account.address, account.generation),
            host_link: format!("skh{}", &hash[..10]), tenant_link: format!("skt{}", &hash[..10]), namespace,
            address: format!("172.31.240.{}", account.address), platform_uid })
    }
    fn path(&self) -> PathBuf { Path::new("/run/netns").join(&self.namespace) }
    fn receipt(&self, config: &Config) -> PathBuf { config.state_dir.join("network").join(format!("{}.json", self.namespace)) }
    fn rules(&self) -> String {
        let Self { table, host_link: link, address, platform_uid: uid, .. } = self;
        // A dedicated table scopes every rule to this veth; unrelated host rules remain untouched.
        format!(r#"table inet {table} {{
 chain input {{
  type filter hook input priority -150; policy accept;
  iifname "{link}" meta nfproto != ipv4 drop
  iifname "{link}" ip saddr != {address} drop
  iifname "{link}" ct state established accept
  iifname "{link}" ip daddr {BROKER_ADDRESS} tcp dport {{ 4792, 4793, 4794 }} accept
  iifname "{link}" drop
 }}
 chain output {{
  type filter hook output priority -150; policy accept;
  oifname "{link}" meta nfproto != ipv4 drop
  oifname "{link}" ip daddr != {address} drop
  oifname "{link}" ct state established accept
  oifname "{link}" meta skuid {{ 0, {uid} }} tcp dport {{ 4790, 4791 }} accept
  oifname "{link}" drop
 }}
 chain forward {{
  type filter hook forward priority -150; policy accept;
  iifname "{link}" drop
  oifname "{link}" drop
 }}
}}
"#)
    }
    fn hash(&self) -> String { format!("{:x}", Sha256::digest(self.rules().as_bytes())) }
}

fn run(binary: &str, args: &[&str], input: Option<&str>) -> Result<(bool, Vec<u8>)> {
    let mut child = Command::new(binary).args(args).env_clear().env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "network_tool_unavailable")?;
    if let Some(input) = input {
        if child.stdin.take().ok_or("network_command_failed")?.write_all(input.as_bytes()).is_err() {
            let _ = child.kill(); let _ = child.wait(); return Err("network_command_failed");
        }
    }
    let mut output = child.stdout.take().ok_or("network_command_failed")?;
    let fd = output.as_raw_fd();
    if unsafe { libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
        let _ = child.kill(); let _ = child.wait(); return Err("network_command_failed");
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut bytes = Vec::new(); let mut status = None;
    loop {
        let mut buffer = [0;4096];
        loop {
            match output.read(&mut buffer) {
                Ok(0) => { if let Some(status) = status { return Ok((status, bytes)); } break; }
                Ok(length) => {
                    bytes.extend_from_slice(&buffer[..length]);
                    if bytes.len() > 65536 {
                        let _ = child.kill(); let _ = child.wait(); return Err("network_response_too_large");
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err("network_command_failed"); }
            }
        }
        match child.try_wait() {
            Ok(Some(exit)) => status = Some(exit.success()), Ok(None) => (),
            Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err("network_command_failed"); }
        }
        if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err("network_command_timeout"); }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn execute(binary: &str, args: &[&str], input: Option<&str>) -> Result<()> {
    if !run(binary, args, input)?.0 { return Err("network_command_failed"); } Ok(())
}
fn value(binary: &str, args: &[&str]) -> Result<Value> {
    let (ok, bytes) = run(binary, args, None)?;
    if !ok { return Err("network_inspection_failed"); }
    serde_json::from_slice(&bytes).map_err(|_| "network_inspection_failed")
}
fn snapshot(value: Value) -> Result<Value> {
    let values = value["nftables"].as_array().ok_or("invalid_network_snapshot")?;
    let mut output = Vec::new();
    for value in values {
        if value.get("metainfo").is_some() { continue; }
        let mut value = value.clone();
        for key in ["table", "chain", "rule"] {
            if let Some(object) = value.get_mut(key).and_then(Value::as_object_mut) {
                for volatile in ["handle", "index", "position"] { object.remove(volatile); }
            }
        }
        output.push(value);
    }
    if output.is_empty() { return Err("invalid_network_snapshot"); }
    Ok(json!(output))
}
fn table_present(policy: &Policy) -> Result<bool> {
    let tables = value(NFT, &["-j", "list", "tables"])?;
    Ok(tables["nftables"].as_array().ok_or("network_inspection_failed")?.iter().any(|v|
        v["table"]["family"] == "inet" && v["table"]["name"] == policy.table))
}
pub fn preflight() -> Result<()> {
    secure::root_owned(Path::new(IP), false)?; secure::root_owned(Path::new(NFT), false)?;
    value(NFT, &["-j", "list", "tables"])?;
    Ok(())
}
fn network_collision(policy: &Policy) -> Result<bool> {
    let links = value(IP, &["-j", "link", "show"])?;
    if links.as_array().ok_or("network_inspection_failed")?.iter().any(|v| v["ifname"] == policy.host_link) { return Ok(true); }
    let routes = value(IP, &["-j", "-4", "route", "show", "table", "all"])?;
    for route in routes.as_array().ok_or("network_inspection_failed")? {
        let Some(dst) = route["dst"].as_str().filter(|dst| *dst != "default") else { continue; };
        let (ip, bits) = dst.split_once('/').unwrap_or((dst, "32"));
        let Some(ip) = ip.parse::<std::net::Ipv4Addr>().ok() else { return Err("network_inspection_failed"); };
        let bits: u32 = bits.parse().map_err(|_| "network_inspection_failed")?;
        if bits > 32 { return Err("network_inspection_failed"); }
        let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
        let base = u32::from(std::net::Ipv4Addr::new(172, 31, 240, 0));
        // Reject overlapping broad routes, even if they belong to another container system.
        if u32::from(ip) & mask == base & mask && bits <= 24 { return Ok(true); }
        if u32::from(ip) & 0xffffff00 == base {
            let device = route["dev"].as_str().unwrap_or("");
            if !device.starts_with("skh") || dst == policy.address || dst == format!("{}/32", policy.address) { return Ok(true); }
        }
    }
    Ok(false)
}
pub fn ensure(config: &Config, account: &Account) -> Result<PathBuf> {
    let policy = Policy::new(account, config.platform_uid)?;
    if policy.receipt(config).exists() { return verify(config, account); }
    preflight()?;
    if fs::symlink_metadata(policy.path()).is_ok() || table_present(&policy)? || network_collision(&policy)? {
        return Err("network_resource_collision");
    }
    let directory = config.state_dir.join("network");
    fs::create_dir_all(&directory).map_err(|_| "network_receipt_failed")?; secure::root_owned(&directory, true)?;
    let setup = (|| {
        execute(IP, &["netns", "add", &policy.namespace], None)?;
        // Install deny rules before bringing up any link.
        execute(NFT, &["-f", "-"], Some(&policy.rules()))?;
        execute(IP, &["link", "add", &policy.host_link, "type", "veth", "peer", "name", &policy.tenant_link], None)?;
        execute(IP, &["link", "set", &policy.tenant_link, "netns", &policy.namespace], None)?;
        execute(IP, &["-n", &policy.namespace, "link", "set", &policy.tenant_link, "name", "eth0"], None)?;
        execute(IP, &["addr", "add", &format!("{BROKER_ADDRESS}/32"), "dev", &policy.host_link], None)?;
        execute(IP, &["-n", &policy.namespace, "addr", "add", &format!("{}/32", policy.address), "dev", "eth0"], None)?;
        execute(IP, &["-n", &policy.namespace, "link", "set", "lo", "up"], None)?;
        execute(IP, &["link", "set", &policy.host_link, "up"], None)?;
        execute(IP, &["-n", &policy.namespace, "link", "set", "eth0", "up"], None)?;
        execute(IP, &["route", "add", &format!("{}/32", policy.address), "dev", &policy.host_link, "src", BROKER_ADDRESS], None)?;
        execute(IP, &["-n", &policy.namespace, "route", "add", &format!("{BROKER_ADDRESS}/32"), "dev", "eth0"], None)?;
        execute(IP, &["-n", &policy.namespace, "route", "add", "default", "via", BROKER_ADDRESS], None)?;
        let metadata = secure::root_owned(&policy.path(), false)?.metadata().map_err(|_| "network_inspection_failed")?;
        let rules = snapshot(value(NFT, &["-j", "list", "table", "inet", &policy.table])?)?;
        let receipt = json!({"schema":1,"instanceId":account.instance_id,"generation":account.generation,
            "address":policy.address,"defaultDeny":true,"policyHash":policy.hash(),"namespaceInode":metadata.ino(),"rules":rules});
        let path = policy.receipt(config); let temporary = path.with_extension("tmp");
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary).map_err(|_| "network_receipt_failed")?;
        file.write_all(&serde_json::to_vec(&receipt).map_err(|_| "network_receipt_failed")?).and_then(|_| file.sync_all()).map_err(|_| "network_receipt_failed")?;
        fs::rename(temporary, &path).map_err(|_| "network_receipt_failed")?;
        File::open(&directory).and_then(|file| file.sync_all()).map_err(|_| "network_receipt_failed")?;
        verify(config, account)
    })();
    match setup { Ok(path) => Ok(path), Err(error) => { remove(config, account)?; Err(error) } }
}
pub fn verify(config: &Config, account: &Account) -> Result<PathBuf> {
    let policy = Policy::new(account, config.platform_uid)?;
    let namespace = secure::root_owned(&policy.path(), false)?;
    let receipt: Value = serde_json::from_slice(&secure::read_root_owned(&policy.receipt(config), 65536)?).map_err(|_| "network_not_ready")?;
    if receipt["schema"] != 1 || receipt["instanceId"] != account.instance_id || receipt["generation"] != account.generation
        || receipt["address"] != policy.address || receipt["defaultDeny"] != true || receipt["policyHash"] != policy.hash()
        || receipt["namespaceInode"] != namespace.metadata().map_err(|_| "network_inspection_failed")?.ino()
        || receipt["rules"] != snapshot(value(NFT, &["-j", "list", "table", "inet", &policy.table])?)? {
        return Err("network_policy_changed");
    }
    let links = value(IP, &["-j", "link", "show", "dev", &policy.host_link])?;
    if links.as_array().is_none_or(|links| links.len() != 1 || links[0]["operstate"] != "UP") { return Err("network_not_ready"); }
    Ok(policy.path())
}
pub fn remove(config: &Config, account: &Account) -> Result<()> {
    let policy = Policy::new(account, config.platform_uid)?;
    let links = value(IP, &["-j", "link", "show"])?;
    if links.as_array().ok_or("network_inspection_failed")?.iter().any(|v| v["ifname"] == policy.host_link) {
        execute(IP, &["link", "del", &policy.host_link], None)?;
    }
    if fs::symlink_metadata(policy.path()).is_ok() {
        secure::root_owned(&policy.path(), false)?;
        execute(IP, &["netns", "del", &policy.namespace], None)?;
    }
    // Remove the deny table last, after the link and namespace are gone.
    if table_present(&policy)? { execute(NFT, &["delete", "table", "inet", &policy.table], None)?; }
    for path in [policy.receipt(config), policy.receipt(config).with_extension("tmp")] {
        if fs::symlink_metadata(&path).is_ok() { secure::root_owned(&path, false)?; fs::remove_file(path).map_err(|_| "network_cleanup_failed")?; }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account() -> crate::registry::Account {
        crate::registry::Registry::default().register("sandbox-test-a", "sandbox-test-a").unwrap()
    }
    #[test]
    fn generated_policy_is_scoped_to_one_generation_and_never_flushes_host_rules() {
        let a = account(); let p = Policy::new(&a, 1000).unwrap();
        let rules = p.rules();
        assert!(rules.contains("hook input")); assert!(rules.contains("hook output")); assert!(rules.contains("hook forward"));
        assert!(rules.contains("tcp dport { 4792, 4793, 4794 }"));
        assert!(rules.contains("tcp dport { 4790, 4791 }"));
        assert!(rules.contains("ip saddr != 172.31.240.2 drop")); assert!(rules.contains("meta skuid { 0, 1000 }"));
        assert!(!rules.contains("flush")); assert!(!rules.contains("masquerade"));
        assert!(p.host_link.len() <= 15); assert!(p.tenant_link.len() <= 15);
        let mut next = a.clone(); next.generation += 1;
        let next = Policy::new(&next, 1000).unwrap();
        assert_ne!(p.table, next.table); assert_ne!(p.namespace, next.namespace); assert_ne!(p.host_link, next.host_link);
    }
    #[test]
    fn caller_controlled_names_addresses_and_root_platform_identity_are_rejected() {
        let mut a = account(); a.instance_id = "a; flush ruleset".into(); assert!(Policy::new(&a, 1000).is_err());
        let mut a = account(); a.address = 1; assert!(Policy::new(&a, 1000).is_err());
        let mut a = account(); a.generation = 0; assert!(Policy::new(&a, 1000).is_err());
        assert!(Policy::new(&account(), 0).is_err());
    }
    #[test]
    fn proxy_environment_is_fixed_and_never_inherits_an_administrator_proxy() {
        let env = environment();
        assert!(env.contains(&"HTTPS_PROXY=http://172.31.240.1:4794".to_string()));
        assert!(env.contains(&"NO_PROXY=localhost,127.0.0.1,172.31.240.1".to_string()));
        assert!(env.iter().all(|value| !value.contains('@') && !value.contains("secret")));
    }
    #[test]
    fn policy_snapshot_ignores_kernel_handles_but_detects_a_changed_verdict() {
        let first = serde_json::json!({"nftables":[{"metainfo":{"version":"1"}}, {"rule":{"handle":1,"expr":[{"drop":null}]}}]});
        let renumbered = serde_json::json!({"nftables":[{"metainfo":{"version":"2"}}, {"rule":{"handle":9,"expr":[{"drop":null}]}}]});
        let changed = serde_json::json!({"nftables":[{"rule":{"handle":1,"expr":[{"accept":null}]}}]});
        assert_eq!(snapshot(first).unwrap(), snapshot(renumbered.clone()).unwrap());
        assert_ne!(snapshot(changed).unwrap(), snapshot(renumbered).unwrap());
        assert!(snapshot(serde_json::json!({})).is_err());
    }
    #[test]
    fn bounded_commands_drain_outputs_larger_than_a_pipe_without_deadlock() {
        let (ok, bytes) = run("/usr/bin/python3", &["-c", "import sys;sys.stdout.write('x'*60000)"], None).unwrap();
        assert!(ok); assert_eq!(bytes.len(), 60000);
        assert!(matches!(run("/usr/bin/python3", &["-c", "import sys;sys.stdout.write('x'*70000)"], None), Err("network_response_too_large")));
    }
    #[test]
    #[ignore = "requires sudo and private mount/network namespaces"]
    fn kernel_policy_blocks_bypasses_and_detects_rule_changes() {
        if unsafe { libc::geteuid() } != 0 {
            let status = Command::new("sudo").args(["-n", "/usr/bin/unshare", "--mount", "--net", "--"])
                .arg(std::env::current_exe().unwrap()).args(["--exact", "network::tests::kernel_policy_blocks_bypasses_and_detects_rule_changes", "--ignored", "--nocapture"])
                .status().expect("isolated kernel probe must start");
            assert!(status.success()); return;
        }
        for namespace in ["net", "mnt"] {
            assert_ne!(fs::metadata(format!("/proc/self/ns/{namespace}")).unwrap().ino(),
                fs::metadata(format!("/proc/1/ns/{namespace}")).unwrap().ino(), "probe cannot change the host namespace");
        }
        use std::os::unix::fs::PermissionsExt;
        let directory = PathBuf::from(format!("/run/scikeel-network-probe-{}", std::process::id()));
        fs::create_dir(&directory).unwrap(); fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let config: Config = serde_json::from_value(json!({"schema":1,"platformUid":1000,"platformGid":1000,
            "socketPath":"/run/scikeel/host.sock","stateDir":directory,"roots":{"instances":"/unused/instances","native":"/unused/native","images":"/unused/images"},
            "runsc":"/usr/local/lib/scikeel/runsc","runscSha256":"a".repeat(64),"quotaDevice":"/dev/loop1","quotaBytes":67108864,
            "quotaInodes":1024,"quotaBackingFile":"/unused/data.img","quotaCapacity":134217728})).unwrap();
        let mut registry = crate::registry::Registry::default();
        let a = registry.register("sandbox-test-network-a", "sandbox-test-network-a").unwrap();
        let b = registry.register("sandbox-test-network-b", "sandbox-test-network-b").unwrap();
        struct Cleanup { config: Config, accounts: Vec<Account>, children: Vec<std::process::Child> }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for child in &mut self.children { let _ = child.kill(); let _ = child.wait(); }
                for account in &self.accounts { let _ = remove(&self.config, account); }
                let _ = fs::remove_dir_all(&self.config.state_dir);
            }
        }
        let mut cleanup = Cleanup { config, accounts: vec![a.clone(), b.clone()], children: Vec::new() };
        let config = &cleanup.config;
        ensure(config, &a).unwrap(); ensure(config, &b).unwrap(); verify(config, &a).unwrap();
        let ap = Policy::new(&a, 1000).unwrap(); let bp = Policy::new(&b, 1000).unwrap();
        // Local witnesses stand in for public/private/metadata destinations: no real remote requests.
        for ip in ["1.1.1.1", "10.0.0.1", "169.254.169.254"] {
            execute(IP, &["addr", "add", &format!("{ip}/32"), "dev", "lo"], None).unwrap();
        }
        let broker = std::net::TcpListener::bind((BROKER_ADDRESS, 4794)).unwrap();
        let host = std::net::TcpListener::bind((BROKER_ADDRESS, 4800)).unwrap();
        let public = std::net::TcpListener::bind(("1.1.1.1", 443)).unwrap();
        let private = std::net::TcpListener::bind(("10.0.0.1", 80)).unwrap();
        let metadata = std::net::TcpListener::bind(("169.254.169.254", 80)).unwrap();
        let _witnesses = (broker, host, public, private, metadata);
        let mut worker = Command::new(IP).args(["netns", "exec", &bp.namespace, "/usr/bin/python3", "-u", "-c",
            "import socket,select\ns=[]\nfor port in (4790,4800):\n x=socket.socket();x.bind(('0.0.0.0',port));x.listen(8);s.append(x)\nprint('ready',flush=True)\nwhile True:\n for x in select.select(s,[],[])[0]:\n  c,_=x.accept();c.close()"])
            .stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        use std::io::BufRead;
        let mut line = String::new(); std::io::BufReader::new(worker.stdout.take().unwrap()).read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ready"); cleanup.children.push(worker);
        for (address, port, allowed) in [(BROKER_ADDRESS, 4794, true), (BROKER_ADDRESS, 4800, false),
            ("1.1.1.1", 443, false), ("10.0.0.1", 80, false), ("169.254.169.254", 80, false), (bp.address.as_str(), 4790, false)] {
            let expected = if allowed { "True" } else { "False" };
            let code = format!("import socket\ns=socket.socket();s.settimeout(0.15)\ntry:\n s.connect(('{address}',{port}));ok=True\nexcept OSError:\n ok=False\ns.close();assert ok is {expected}, 'unexpected connection policy'");
            execute(IP, &["netns", "exec", &ap.namespace, "/usr/bin/python3", "-c", &code], None).unwrap();
        }
        let worker_address: std::net::SocketAddr = format!("{}:4790", bp.address).parse().unwrap();
        assert!(std::net::TcpStream::connect_timeout(&worker_address, Duration::from_millis(150)).is_ok());
        let host_only: std::net::SocketAddr = format!("{}:4800", bp.address).parse().unwrap();
        assert!(std::net::TcpStream::connect_timeout(&host_only, Duration::from_millis(150)).is_err());
        let untrusted = format!("import os,socket\nos.setgid(1001);os.setuid(1001)\ns=socket.socket();s.settimeout(0.15)\ntry:\n s.connect(('{}',4790));ok=True\nexcept OSError:\n ok=False\nassert not ok", bp.address);
        execute("/usr/bin/python3", &["-c", &untrusted], None).unwrap();
        let udp = std::net::UdpSocket::bind((BROKER_ADDRESS, 4794)).unwrap();
        udp.set_read_timeout(Some(Duration::from_millis(150))).unwrap();
        execute(IP, &["netns", "exec", &ap.namespace, "/usr/bin/python3", "-c", "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.sendto(b'blocked',('172.31.240.1',4794))"], None).unwrap();
        assert!(udp.recv_from(&mut [0u8;16]).is_err());
        execute(NFT, &["add", "rule", "inet", &ap.table, "input", "accept"], None).unwrap();
        assert!(matches!(verify(&cleanup.config, &a), Err("network_policy_changed")));
        remove(&cleanup.config, &a).unwrap(); remove(&cleanup.config, &a).unwrap();
        assert!(verify(&cleanup.config, &b).is_ok(), "one account cleanup must preserve its peer");
        println!("kernel network evidence: approved broker reachable, host/peer/direct/private/metadata/UDP denied; untrusted host uid denied; rule mutation detected; cleanup idempotent");
    }
}
