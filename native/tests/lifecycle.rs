use std::process::Stdio;
use std::time::Duration;

use futures_util::SinkExt;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, ChildStdin, Command};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

async fn launch() -> (Child, ChildStdin, u16) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_anas-rdp-bridge"))
        .arg("--serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(format!("{}\n", json!({"host":"test.invalid","port":3389,"origin":"anas-plugin://rdp","token":"a".repeat(64)})).as_bytes()).await.unwrap();
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
    (child, input, port)
}

#[tokio::test]
async fn owner_pipe_closure_reclaims_listener_and_process() {
    let (mut child, input, port) = launch().await;
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
    let (mut child, input, port) = launch().await;
    let url = format!("ws://127.0.0.1:{port}/rdp");
    let mut request = url.clone().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://unrelated.invalid".parse().unwrap());
    assert!(tokio_tungstenite::connect_async(request).await.is_err());
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", "anas-plugin://rdp".parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    ws.send(Message::Binary(vec![0; 64 * 1024 + 1].into()))
        .await
        .unwrap();
    assert!(
        timeout(Duration::from_secs(3), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    drop(input);
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
}
