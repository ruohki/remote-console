//! macOS `.app` bundle assembly for baked agents.
//!
//! Layout produced by [`create_bundle`]:
//!
//! ```text
//! <Product>.app/
//!   Contents/Info.plist
//!   Contents/MacOS/remote-agent            base binary (no trailer), mode 0755
//!   Contents/Resources/baked.json          signed BakedPayload sidecar
//!   Contents/Resources/AppIcon.icns        from the branding logo (optional)
//! ```
//!
//! The payload lives in a sidecar so code signing covers it; the agent reads it when running
//! from a bundle and falls back to the executable trailer otherwise.

use anyhow::{anyhow, Context, Result};
use protocol::bakery::BakedPayload;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

/// Everything needed to lay out one bundle.
pub struct BundleSpec<'a> {
    pub product: &'a str,
    pub version: &'a str,
    pub binary: &'a [u8],
    pub payload: &'a BakedPayload,
    /// PNG bytes of the branding logo, if any.
    pub logo_png: Option<&'a [u8]>,
}

/// Lower-case, dash-separated identifier fragment from the product name.
pub fn bundle_slug(product: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for c in product.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "agent".to_string()
    } else {
        out
    }
}

pub fn bundle_id(product: &str) -> String {
    format!("com.remoteagent.{}", bundle_slug(product))
}

/// Folder name of the bundle (`<Product>.app`) with filesystem-unsafe characters removed.
pub fn app_dir_name(product: &str) -> String {
    let cleaned: String = product
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '\0'))
        .collect();
    let cleaned = cleaned.trim();
    let stem = if cleaned.is_empty() {
        "Remote Agent"
    } else {
        cleaned
    };
    format!("{stem}.app")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `Info.plist` contents.
pub fn info_plist(product: &str, bundle_id: &str, version: &str, has_icon: bool) -> String {
    let icon = if has_icon {
        "    <key>CFBundleIconFile</key>\n    <string>AppIcon</string>\n"
    } else {
        ""
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>remote-agent</string>
    <key>CFBundleIdentifier</key>
    <string>{id}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>{name}</string>
    <key>CFBundleDisplayName</key>
    <string>{name}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>{version}</string>
    <key>CFBundleVersion</key>
    <string>{version}</string>
{icon}    <key>LSMinimumSystemVersion</key>
    <string>12.3</string>
    <key>LSUIElement</key>
    <false/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>{name}</string>
</dict>
</plist>
"#,
        id = xml_escape(bundle_id),
        name = xml_escape(product),
        version = xml_escape(version),
        icon = icon,
    )
}

/// Create `<dir>/<Product>.app` and return its path.
pub fn create_bundle(dir: &Path, spec: &BundleSpec<'_>) -> Result<PathBuf> {
    let app = dir.join(app_dir_name(spec.product));
    let contents = app.join("Contents");
    let macos = contents.join("MacOS");
    let resources = contents.join("Resources");
    std::fs::create_dir_all(&macos).context("creating MacOS dir")?;
    std::fs::create_dir_all(&resources).context("creating Resources dir")?;

    let exe = macos.join("remote-agent");
    std::fs::write(&exe, spec.binary).context("writing executable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755))
            .context("chmod executable")?;
    }

    let sidecar = serde_json::to_vec_pretty(spec.payload).context("serializing payload")?;
    std::fs::write(resources.join("baked.json"), sidecar).context("writing baked.json")?;

    let mut has_icon = false;
    if let Some(png) = spec.logo_png {
        match icns_from_png(png) {
            Ok(icns) => {
                std::fs::write(resources.join("AppIcon.icns"), icns).context("writing icon")?;
                has_icon = true;
            }
            Err(err) => tracing::warn!("bundle icon skipped: {err:#}"),
        }
    }

    std::fs::write(
        contents.join("Info.plist"),
        info_plist(
            spec.product,
            &bundle_id(spec.product),
            spec.version,
            has_icon,
        ),
    )
    .context("writing Info.plist")?;
    Ok(app)
}

/// Version string of the agent: `<binary> --version` when the base binary is runnable on this
/// host (macOS only), else the fallback.
pub fn detect_version(local_binary: Option<&Path>, fallback: &str) -> String {
    if !cfg!(target_os = "macos") {
        return fallback.to_string();
    }
    let Some(path) = local_binary else {
        return fallback.to_string();
    };
    let out = std::process::Command::new(path).arg("--version").output();
    match out {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout);
            text.split_whitespace()
                .last()
                .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .map(str::to_string)
                .unwrap_or_else(|| fallback.to_string())
        }
        _ => fallback.to_string(),
    }
}

// ─── icon ─────────────────────────────────────────────────────────────────────

/// Decode a PNG into 8-bit RGBA.
fn decode_png_rgba(png: &[u8]) -> Result<(u32, u32, Vec<u8>)> {
    let mut decoder = png::Decoder::new(Cursor::new(png));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().context("reading PNG header")?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| anyhow!("PNG too large"))?;
    let mut buf = vec![0u8; size];
    let info = reader.next_frame(&mut buf).context("decoding PNG")?;
    buf.truncate(info.buffer_size());
    let (color, _) = reader.output_color_type();
    let (w, h) = (info.width, info.height);
    let px = (w as usize) * (h as usize);
    let rgba = match color {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(px * 4);
            for c in buf.as_chunks::<3>().0 {
                out.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity(px * 4);
            for &g in &buf {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = Vec::with_capacity(px * 4);
            for c in buf.as_chunks::<2>().0 {
                out.extend_from_slice(&[c[0], c[0], c[0], c[1]]);
            }
            out
        }
        png::ColorType::Indexed => return Err(anyhow!("indexed PNG not expanded")),
    };
    if rgba.len() != px * 4 {
        return Err(anyhow!("unexpected PNG buffer size"));
    }
    Ok((w, h, rgba))
}

/// Box-filter resize of RGBA pixels into a `size`×`size` square (letterboxed with
/// transparency when the source is not square).
fn resize_square(src: &[u8], sw: u32, sh: u32, size: u32) -> Vec<u8> {
    let mut out = vec![0u8; (size as usize) * (size as usize) * 4];
    let side = sw.max(sh) as f64;
    // Offsets that center the image inside the square, in source pixel units.
    let ox = (side - sw as f64) / 2.0;
    let oy = (side - sh as f64) / 2.0;
    let scale = side / size as f64;
    for y in 0..size {
        for x in 0..size {
            // Source rectangle covered by this output pixel.
            let x0 = (x as f64 * scale - ox).max(0.0);
            let x1 = ((x + 1) as f64 * scale - ox).min(sw as f64);
            let y0 = (y as f64 * scale - oy).max(0.0);
            let y1 = ((y + 1) as f64 * scale - oy).min(sh as f64);
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
            let (xs, xe) = (x0.floor() as u32, (x1.ceil() as u32).min(sw));
            let (ys, ye) = (y0.floor() as u32, (y1.ceil() as u32).min(sh));
            for sy in ys..ye {
                for sx in xs..xe {
                    let i = ((sy * sw + sx) * 4) as usize;
                    r += u64::from(src[i]);
                    g += u64::from(src[i + 1]);
                    b += u64::from(src[i + 2]);
                    a += u64::from(src[i + 3]);
                    n += 1;
                }
            }
            if n == 0 {
                continue;
            }
            let o = ((y * size + x) * 4) as usize;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
            out[o + 3] = (a / n) as u8;
        }
    }
    out
}

/// Build an `.icns` file (128/256/512 px) from PNG bytes.
pub fn icns_from_png(png_bytes: &[u8]) -> Result<Vec<u8>> {
    let (w, h, rgba) = decode_png_rgba(png_bytes)?;
    if w == 0 || h == 0 {
        return Err(anyhow!("empty image"));
    }
    let mut family = icns::IconFamily::new();
    for size in [128u32, 256, 512] {
        let pixels = resize_square(&rgba, w, h, size);
        let image = icns::Image::from_data(icns::PixelFormat::RGBA, size, size, pixels)
            .map_err(|e| anyhow!("icns image {size}px: {e}"))?;
        family
            .add_icon(&image)
            .map_err(|e| anyhow!("icns add {size}px: {e}"))?;
    }
    let mut out = Vec::new();
    family
        .write(&mut out)
        .map_err(|e| anyhow!("icns write: {e}"))?;
    Ok(out)
}

// ─── zip ──────────────────────────────────────────────────────────────────────

/// Zip the directory `root` so that its contents appear under `top_level/` (e.g.
/// `Product.app/Contents/...`). Files under `MacOS/` (or already executable on disk) get
/// mode 0755, everything else 0644.
pub fn zip_dir(root: &Path, top_level: &str) -> Result<Vec<u8>> {
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    let mut entries = Vec::new();
    collect_entries(root, root, &mut entries)?;
    entries.sort();

    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let dir_opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o755);
    zip.add_directory(format!("{top_level}/"), dir_opts)
        .context("zip top-level dir")?;

    for rel in entries {
        let abs = root.join(&rel);
        let name = format!("{top_level}/{}", rel.to_string_lossy().replace('\\', "/"));
        let meta = std::fs::metadata(&abs)?;
        if meta.is_dir() {
            zip.add_directory(format!("{name}/"), dir_opts)
                .with_context(|| format!("zip dir {name}"))?;
            continue;
        }
        let executable =
            is_executable(&abs, &meta) || rel.components().any(|c| c.as_os_str() == "MacOS");
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(if executable { 0o755 } else { 0o644 })
            .large_file(meta.len() >= u32::MAX as u64);
        zip.start_file(&name, opts)
            .with_context(|| format!("zip file {name}"))?;
        let bytes = std::fs::read(&abs).with_context(|| format!("reading {}", abs.display()))?;
        zip.write_all(&bytes)?;
    }
    let cursor = zip.finish().context("finishing zip")?;
    Ok(cursor.into_inner())
}

fn collect_entries(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("listing {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|_| anyhow!("path outside root"))?
            .to_path_buf();
        out.push(rel);
        if entry.file_type()?.is_dir() {
            collect_entries(root, &path, out)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(_path: &Path, meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_path: &Path, _meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::bakery::{sign_payload, BakedConfig, Branding};

    fn payload() -> BakedPayload {
        let key = ed25519_dalek::SigningKey::from_bytes(&[3u8; 32]);
        sign_payload(
            BakedConfig {
                version: protocol::bakery::BAKED_VERSION,
                server_url: "https://c.example".into(),
                enroll_token: None,
                quick_support: false,
                branding: Branding {
                    product_name: "Acme Remote".into(),
                    accent: "#123456".into(),
                    logo_png_base64: None,
                    support_text: String::new(),
                    organization: String::new(),
                    apply_to_console: true,
                },
                issued_at: 1,
                console_tls_spki_sha256: None,
            },
            &key,
        )
    }

    /// A 2×2 RGBA PNG (red/green/blue/transparent).
    fn tiny_png() -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, 2, 2);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0])
                .unwrap();
        }
        out
    }

    #[test]
    fn slugs_and_ids() {
        assert_eq!(bundle_slug("Acme Remote Support!"), "acme-remote-support");
        assert_eq!(bundle_slug("   "), "agent");
        assert_eq!(bundle_id("Acme"), "com.remoteagent.acme");
        assert_eq!(app_dir_name("Acme/Remote:Care"), "AcmeRemoteCare.app");
        assert_eq!(app_dir_name(""), "Remote Agent.app");
    }

    #[test]
    fn plist_contains_product_and_escapes() {
        let p = info_plist("A & B", "com.remoteagent.a-b", "1.2.3", true);
        assert!(p.contains("<string>A &amp; B</string>"));
        assert!(p.contains("<string>com.remoteagent.a-b</string>"));
        assert!(p.contains("<key>CFBundleIconFile</key>"));
        assert!(p.contains("<string>1.2.3</string>"));
        let p = info_plist("A", "com.remoteagent.a", "1", false);
        assert!(!p.contains("CFBundleIconFile"));
    }

    #[test]
    fn icns_from_tiny_png_has_three_sizes() {
        let icns = icns_from_png(&tiny_png()).unwrap();
        assert_eq!(&icns[..4], b"icns");
        let family = icns::IconFamily::read(Cursor::new(&icns)).unwrap();
        // 128 px is stored as an RGB element plus a mask element; 256/512 as one PNG each.
        assert!(
            family.elements.len() >= 3,
            "elements: {}",
            family.elements.len()
        );
        assert!(family.available_icons().len() >= 3);
    }

    #[test]
    fn bundle_layout_and_zip_modes() {
        let tmp = tempfile::tempdir().unwrap();
        let payload = payload();
        let png = tiny_png();
        let app = create_bundle(
            tmp.path(),
            &BundleSpec {
                product: "Acme Remote",
                version: "0.1.0",
                binary: b"MZ-fake",
                payload: &payload,
                logo_png: Some(&png),
            },
        )
        .unwrap();
        assert!(app.ends_with("Acme Remote.app"));
        assert!(app.join("Contents/Info.plist").is_file());
        assert!(app.join("Contents/MacOS/remote-agent").is_file());
        assert!(app.join("Contents/Resources/baked.json").is_file());
        assert!(app.join("Contents/Resources/AppIcon.icns").is_file());

        let zipped = zip_dir(&app, "Acme Remote.app").unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(zipped)).unwrap();
        let names: Vec<String> = archive.file_names().map(String::from).collect();
        assert!(names.contains(&"Acme Remote.app/Contents/Info.plist".to_string()));
        let exe = archive
            .by_name("Acme Remote.app/Contents/MacOS/remote-agent")
            .unwrap();
        assert_eq!(exe.unix_mode().map(|m| m & 0o777), Some(0o755));
        drop(exe);
        let plist = archive
            .by_name("Acme Remote.app/Contents/Info.plist")
            .unwrap();
        assert_eq!(plist.unix_mode().map(|m| m & 0o777), Some(0o644));
    }

    #[test]
    fn detect_version_falls_back() {
        assert_eq!(detect_version(None, "9.9.9"), "9.9.9");
        assert_eq!(
            detect_version(Some(Path::new("/nonexistent/agent")), "1.0.0"),
            "1.0.0"
        );
    }
}
