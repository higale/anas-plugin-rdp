use std::process::Stdio;
use std::time::Duration;

use futures_util::SinkExt;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStdin, Command};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

async fn launch() -> (Child, ChildStdin, u16, TcpListener) {
    // Keep negotiation pending independently of DNS or a real RDP server.
    let peer = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_anas-rdp-session"))
        .arg("--session")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(format!("{}\n", json!({"host":"127.0.0.1","port":peer.local_addr().unwrap().port(),"username":"test","password":"test","origin":"anas-plugin://display","token":"a".repeat(64)})).as_bytes()).await.unwrap();
    let mut line = String::new();
    timeout(
        Duration::from_secs(5),
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    let event: serde_json::Value = serde_json::from_str(&line).unwrap();
    let port = event["port"].as_u64().unwrap() as u16;
    (child, input, port, peer)
}

#[tokio::test]
async fn owner_pipe_closure_reclaims_listener_and_process() {
    let (mut child, input, port, _peer) = launch().await;
    drop(input);
    assert!(
        timeout(Duration::from_secs(3), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
}

#[tokio::test]
async fn rejects_foreign_origin_then_accepts_bound_origin() {
    let (mut child, input, port, _peer) = launch().await;
    let url = format!("ws://127.0.0.1:{port}/display");
    let mut request = url.clone().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://unrelated.invalid".parse().unwrap());
    assert!(tokio_tungstenite::connect_async(request).await.is_err());
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", "anas-plugin://display".parse().unwrap());
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!("anas-rdp, {}, test-page", "a".repeat(64))
            .parse()
            .unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    ws.send(Message::Binary(vec![0; 64 * 1024 + 1].into()))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        child.try_wait().unwrap().is_none(),
        "A display failure must not terminate the session resource."
    );
    drop(input);
    assert!(
        timeout(Duration::from_secs(3), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
}

#[tokio::test]
async fn terminal_remote_failure_reclaims_listener_without_waiting_for_owner() {
    let (mut child, _input, port, peer) = launch().await;
    drop(peer);
    assert!(
        timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
}
