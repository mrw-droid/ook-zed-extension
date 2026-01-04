use futures_util::{SinkExt, StreamExt};
use std::env;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::select;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info, warn};

const DEFAULT_PORT: u16 = 8647;

fn get_remote_host() -> String {
    if let Ok(host) = env::var("OOK_REMOTE_HOST") {
        return host;
    }

    // Default: lima-<hostname>-sandbox
    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "localhost".to_string());

    format!("lima-{}-sandbox", hostname)
}

fn get_remote_port() -> u16 {
    env::var("OOK_REMOTE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging to stderr (stdout is for ACP messages)
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("ook=info".parse().unwrap()),
        )
        .with_writer(std::io::stderr)
        .json()
        .init();

    let host = get_remote_host();
    let port = get_remote_port();
    let url = format!("ws://{}:{}", host, port);

    info!(url = %url, "Connecting to Ook Bridge");

    let (ws_stream, _) = connect_async(&url).await.map_err(|e| {
        error!(error = %e, url = %url, "Failed to connect to Ook Bridge");
        e
    })?;

    info!("Connected to Ook Bridge");

    let (mut ws_sink, mut ws_stream) = ws_stream.split();

    // Set up stdin/stdout for ACP
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut stdin_reader = BufReader::new(stdin).lines();

    loop {
        select! {
            // Read from stdin (Zed -> Bridge)
            line = stdin_reader.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        debug!(direction = "zed->bridge", message = %line, "Forwarding message");
                        if let Err(e) = ws_sink.send(Message::Text(line)).await {
                            error!(error = %e, "Failed to send to WebSocket");
                            break;
                        }
                    }
                    Ok(None) => {
                        info!("Stdin closed, shutting down");
                        break;
                    }
                    Err(e) => {
                        error!(error = %e, "Error reading stdin");
                        break;
                    }
                }
            }

            // Read from WebSocket (Bridge -> Zed)
            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        debug!(direction = "bridge->zed", message = %text, "Forwarding message");
                        // Write to stdout with newline (NDJSON)
                        if let Err(e) = stdout.write_all(text.as_bytes()).await {
                            error!(error = %e, "Failed to write to stdout");
                            break;
                        }
                        if !text.ends_with('\n') {
                            if let Err(e) = stdout.write_all(b"\n").await {
                                error!(error = %e, "Failed to write newline to stdout");
                                break;
                            }
                        }
                        if let Err(e) = stdout.flush().await {
                            error!(error = %e, "Failed to flush stdout");
                            break;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        info!(frame = ?frame, "WebSocket closed by server");
                        break;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        debug!("Received ping, sending pong");
                        if let Err(e) = ws_sink.send(Message::Pong(data)).await {
                            warn!(error = %e, "Failed to send pong");
                        }
                    }
                    Some(Ok(_)) => {
                        // Ignore other message types (Binary, Pong, Frame)
                    }
                    Some(Err(e)) => {
                        error!(error = %e, "WebSocket error");
                        break;
                    }
                    None => {
                        info!("WebSocket stream ended");
                        break;
                    }
                }
            }
        }
    }

    // Clean shutdown
    let _ = ws_sink.close().await;
    info!("Ook extension shutting down");

    Ok(())
}
