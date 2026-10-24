use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc,
    sync::Mutex,
    thread::{sleep, spawn},
    time::Duration,
};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use url::Url;

struct InkTrailServer(Mutex<Option<Child>>);

fn wait_for_ready(child: &mut Child) -> Result<Url, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "InkTrail's local service did not provide startup output.".to_string())?;
    let (sender, receiver) = mpsc::sync_channel(1);
    spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .read_line(&mut line)
            .map(|_| line)
            .map_err(|error| error.to_string());
        let _ = sender.send(result);
    });
    let line = receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| {
            "InkTrail's local service did not report its ready URL within five seconds.".to_string()
        })??;
    let url = line
        .trim()
        .strip_prefix("INKTRAIL_READY ")
        .ok_or_else(|| "InkTrail's local service reported an invalid ready message.".to_string())?;
    let url = Url::parse(url).map_err(|error| error.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("InkTrail's local service reported an unsafe ready URL.".into());
    }
    Ok(url)
}

fn wait_for_health(port: u16) -> Result<(), String> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    for _ in 0..100 {
        if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(100)) {
            let _ = stream.write_all(
                b"GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            );
            let mut response = String::new();
            if stream.read_to_string(&mut response).is_ok() && response.starts_with("HTTP/1.1 200")
            {
                return Ok(());
            }
        }
        sleep(Duration::from_millis(50));
    }
    Err("InkTrail's local service did not become ready within five seconds.".into())
}

fn runtime_directory(app: &tauri::App) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("resources")
        .join("runtime")
        .canonicalize()
        .map_err(|_| {
            "InkTrail desktop resources are missing. Run the desktop preparation command first."
                .into()
        })
}

fn stop_child(child: &mut Child) {
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"INKTRAIL_SHUTDOWN\n");
        let _ = stdin.flush();
    }
    for _ in 0..100 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        sleep(Duration::from_millis(100));
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    let _ = child.kill();
    for _ in 0..10 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        sleep(Duration::from_millis(100));
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGKILL);
    }
    let _ = child.wait();
}

fn stop_server(app: &tauri::AppHandle) {
    if let Some(server) = app.try_state::<InkTrailServer>() {
        if let Ok(mut child) = server.0.lock() {
            if let Some(mut child) = child.take() {
                stop_child(&mut child);
            }
        }
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let runtime = runtime_directory(app)?;
            let data_directory = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            std::fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
            let mut child = Command::new(runtime.join("node"))
                .arg(runtime.join("src").join("server.js"))
                .current_dir(&runtime)
                .env("INKTRAIL_DATA_DIR", data_directory)
                .env("PORT", "0")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("InkTrail's local service could not start: {error}"))?;

            let url = match wait_for_ready(&mut child) {
                Ok(url) => url,
                Err(error) => {
                    stop_child(&mut child);
                    return Err(error.into());
                }
            };
            let port = url.port().expect("ready URLs must include a port");

            app.manage(InkTrailServer(Mutex::new(Some(child))));
            if let Err(error) = wait_for_health(port) {
                stop_server(&app.handle());
                return Err(error.into());
            }

            if let Err(error) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("InkTrail")
                .inner_size(1180.0, 820.0)
                .min_inner_size(900.0, 620.0)
                .build()
            {
                stop_server(&app.handle());
                return Err(error.to_string().into());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build InkTrail desktop");
    app.run(|app, event| {
        if matches!(event, RunEvent::Exit { .. }) {
            stop_server(app);
        }
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::stop_child;
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    #[test]
    fn force_stops_a_child_that_ignores_termination() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; while :; do :; done"])
            .stdin(Stdio::null())
            .spawn()
            .expect("starts a termination-resistant child");
        let started = Instant::now();

        stop_child(&mut child);

        assert!(started.elapsed() < Duration::from_secs(12));
        assert!(child.try_wait().expect("checks child state").is_some());
    }
}
