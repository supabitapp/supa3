use serde::Deserialize;
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::time::Instant;

#[derive(Deserialize)]
struct Request {
    source: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    writeln!(
        stdout,
        "{}",
        json!({"ready": true, "renderer": "mermaid-rs-renderer", "version": "0.3.1"})
    )?;
    stdout.flush()?;

    for line in stdin.lock().lines() {
        let line = line?;
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => {
                let start = Instant::now();
                let result =
                    std::panic::catch_unwind(|| mermaid_rs_renderer::render(&request.source));
                let render_ms = start.elapsed().as_secs_f64() * 1_000.0;
                match result {
                    Ok(Ok(output)) => json!({"output": output, "renderMs": render_ms}),
                    Ok(Err(error)) => json!({"error": error.to_string(), "renderMs": render_ms}),
                    Err(_) => json!({"error": "Renderer panicked", "renderMs": render_ms}),
                }
            }
            Err(error) => json!({"error": error.to_string(), "renderMs": 0.0}),
        };
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }
    Ok(())
}
