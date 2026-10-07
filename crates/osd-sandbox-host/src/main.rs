mod protocol;
mod registry;
#[cfg(target_os="linux")] mod config;
#[cfg(target_os="linux")] mod secure;
#[cfg(target_os="linux")] mod quota;
#[cfg(target_os="linux")] mod lifecycle;
#[cfg(target_os="linux")] mod host;
#[cfg(target_os="linux")] mod backend;
#[cfg(target_os="linux")] mod network;

fn main() {
    #[cfg(target_os="linux")]
    if let Err(error)=host::run() {eprintln!("sandbox host: {error}");std::process::exit(1);}
    #[cfg(not(target_os="linux"))]
    {eprintln!("sandbox host requires Linux");std::process::exit(1);}
}
