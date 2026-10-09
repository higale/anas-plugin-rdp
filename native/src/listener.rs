use tokio::net::TcpListener;
async fn bind_dynamic_listener(seed: u16) -> std::io::Result<TcpListener> {
    // Browser-restricted ports are below the IANA dynamic/private range.
    // Spread bounded retries across that range to avoid reserved Windows blocks.
    for attempt in 0..128u32 {
        let port = 49152 + ((u32::from(seed) + attempt * 7919) % 16384) as u16;
        match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
            Ok(listener) => return Ok(listener),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied
                ) => {}
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AddrNotAvailable,
        "no browser-compatible loopback port available",
    ))
}

pub(crate) async fn bind_browser_listener() -> std::io::Result<TcpListener> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    if port >= 49152 {
        return Ok(listener);
    }
    // OS ephemeral port ranges can be customized and include blocked ports (6566).
    drop(listener);
    bind_dynamic_listener(port).await
}
