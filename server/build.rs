//! Guarantees `../web/dist` exists so `rust-embed` always has something to embed.
//! When the SPA has not been built yet a placeholder `index.html` is written.

use std::path::Path;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let dist = Path::new(&manifest_dir).join("../web/dist");
    println!("cargo:rerun-if-changed={}", dist.display());

    let is_empty = match std::fs::read_dir(&dist) {
        Ok(mut it) => it.next().is_none(),
        Err(_) => true,
    };
    if is_empty {
        if let Err(err) = std::fs::create_dir_all(&dist) {
            println!("cargo:warning=could not create {}: {err}", dist.display());
            return;
        }
        let placeholder = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>remote-console</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:40rem;padding:2rem;border:1px solid #334155;border-radius:1rem;background:#1e293b}code{background:#0f172a;padding:.15rem .4rem;border-radius:.3rem}</style></head>
<body><main><h1>remote-console</h1><p>The web UI has not been built yet.</p>
<p>Run <code>npm install &amp;&amp; npm run build</code> inside <code>web/</code>, then rebuild or restart the server.</p>
<p>The API is available under <code>/api</code>.</p></main></body></html>
"#;
        if let Err(err) = std::fs::write(dist.join("index.html"), placeholder) {
            println!("cargo:warning=could not write placeholder index.html: {err}");
        }
    }
}
