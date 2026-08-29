//! Branded email templates. One table-based layout with inline CSS (what mail clients
//! render reliably); every builder returns an [`OutgoingMail`] without recipients.
//!
//! All branding strings are HTML-escaped: product name, organisation and support text are
//! admin input, but an admin's typo must not turn into markup in every user's inbox.

use super::OutgoingMail;
use protocol::bakery::Branding;

/// What an emailed code is for; changes the subject and the explanation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodePurpose {
    Login,
    Enrol,
}

/// Text colour that stays readable on the accent (same rule as the SPA's `accentInk`).
pub fn accent_ink(hex: &str) -> &'static str {
    if luminance(hex) > 0.42 {
        "#0b1220"
    } else {
        "#ffffff"
    }
}

/// Relative luminance of `#rrggbb` (0 = black, 1 = white); 0.5 for anything else.
fn luminance(hex: &str) -> f64 {
    let hex = hex.trim();
    if hex.len() != 7 || !hex.starts_with('#') {
        return 0.5;
    }
    let channel = |i: usize| -> Option<f64> {
        let v = u8::from_str_radix(&hex[i..i + 2], 16).ok()? as f64 / 255.0;
        Some(if v <= 0.03928 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        })
    };
    match (channel(1), channel(3), channel(5)) {
        (Some(r), Some(g), Some(b)) => 0.2126 * r + 0.7152 * g + 0.0722 * b,
        _ => 0.5,
    }
}

/// The accent as `#rrggbb`, falling back to the default when the stored value is not one.
fn accent(branding: &Branding) -> String {
    let a = branding.accent.trim();
    let valid = a.len() == 7 && a.starts_with('#') && a[1..].chars().all(|c| c.is_ascii_hexdigit());
    if valid {
        a.to_ascii_lowercase()
    } else {
        "#3b82f6".to_string()
    }
}

/// Decoded logo, when the branding has one that decodes.
fn logo_bytes(branding: &Branding) -> Option<Vec<u8>> {
    use base64::Engine;
    let b64 = branding.logo_png_base64.as_deref()?.trim();
    if b64.is_empty() {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Content of one email, rendered by [`render`].
struct Layout<'a> {
    branding: &'a Branding,
    public_url: Option<&'a str>,
    subject: String,
    title: String,
    /// Paragraphs above the call to action / code.
    intro: Vec<String>,
    /// Button label + absolute URL.
    cta: Option<(String, String)>,
    /// A one-time code, shown large.
    code: Option<String>,
    /// Paragraphs below the call to action / code.
    outro: Vec<String>,
    /// "You received this email because …" line in the footer.
    reason: String,
}

fn render(layout: Layout<'_>) -> OutgoingMail {
    let b = layout.branding;
    let product = b.product_name.trim();
    let product_html = escape(product);
    let accent = accent(b);
    let ink = accent_ink(&accent);
    let logo = logo_bytes(b);
    let public_url = layout
        .public_url
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(escape);

    // ── HTML ──────────────────────────────────────────────────────────────
    let brand = match &logo {
        Some(_) => format!(
            "<img src=\"cid:logo\" alt=\"{product_html}\" height=\"36\" style=\"display:block;height:36px;max-width:220px;border:0;outline:none;\">"
        ),
        None => format!(
            "<span style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:{ink};\">{product_html}</span>"
        ),
    };
    let brand = match &public_url {
        Some(url) => {
            format!("<a href=\"{url}\" style=\"text-decoration:none;color:{ink};\">{brand}</a>")
        }
        None => brand,
    };
    let para = |p: &str| -> String {
        format!(
            "<p style=\"margin:0 0 14px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#1f2937;\">{}</p>",
            escape(p)
        )
    };
    let mut body = String::new();
    body.push_str(&format!(
        "<h1 style=\"margin:0 0 18px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:20px;line-height:28px;font-weight:600;color:#0b1220;\">{}</h1>",
        escape(&layout.title)
    ));
    for p in &layout.intro {
        body.push_str(&para(p));
    }
    if let Some((label, url)) = &layout.cta {
        body.push_str(&format!(
            "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:22px 0;\"><tr><td align=\"center\" bgcolor=\"{accent}\" style=\"border-radius:8px;background-color:{accent};\"><a href=\"{url}\" style=\"display:inline-block;padding:12px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:{ink};text-decoration:none;border-radius:8px;\">{label}</a></td></tr></table>",
            url = escape(url),
            label = escape(label),
        ));
        body.push_str(&format!(
            "<p style=\"margin:0 0 14px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#6b7280;\">If the button does not work, copy this link into your browser:<br><a href=\"{u}\" style=\"color:{accent};word-break:break-all;\">{u}</a></p>",
            u = escape(url),
        ));
    }
    if let Some(code) = &layout.code {
        body.push_str(&format!(
            "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\" style=\"margin:22px 0;\"><tr><td align=\"center\" bgcolor=\"#f3f4f6\" style=\"border-radius:8px;background-color:#f3f4f6;padding:18px 12px;\"><span style=\"font-family:SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:32px;line-height:40px;letter-spacing:8px;font-weight:700;color:#0b1220;\">{}</span></td></tr></table>",
            escape(code)
        ));
    }
    for p in &layout.outro {
        body.push_str(&para(p));
    }

    let mut footer = String::new();
    let org = b.organization.trim();
    if !org.is_empty() {
        footer.push_str(&format!(
            "<p style=\"margin:0 0 6px 0;font-weight:600;color:#374151;\">{}</p>",
            escape(org)
        ));
    }
    let support = b.support_text.trim();
    if !support.is_empty() {
        footer.push_str(&format!(
            "<p style=\"margin:0 0 6px 0;\">{}</p>",
            escape(support)
        ));
    }
    footer.push_str(&format!(
        "<p style=\"margin:0;\">You received this email because {}</p>",
        escape(&layout.reason)
    ));

    let html = format!(
        "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title></head>\
<body style=\"margin:0;padding:0;background-color:#eef0f3;\">\
<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" bgcolor=\"#eef0f3\" style=\"background-color:#eef0f3;\"><tr><td align=\"center\" style=\"padding:28px 12px;\">\
<table role=\"presentation\" width=\"560\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"max-width:560px;width:100%;\">\
<tr><td bgcolor=\"{accent}\" style=\"background-color:{accent};padding:18px 28px;border-radius:12px 12px 0 0;\">{brand}</td></tr>\
<tr><td bgcolor=\"#ffffff\" style=\"background-color:#ffffff;padding:28px;border-radius:0 0 12px 12px;\">{body}</td></tr>\
<tr><td style=\"padding:18px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#6b7280;\">{footer}</td></tr>\
</table></td></tr></table></body></html>",
        title = escape(&layout.title),
    );

    // ── plain text ────────────────────────────────────────────────────────
    let mut text = String::new();
    text.push_str(product);
    text.push_str("\n\n");
    text.push_str(&layout.title);
    text.push_str("\n\n");
    for p in &layout.intro {
        text.push_str(p);
        text.push_str("\n\n");
    }
    if let Some((label, url)) = &layout.cta {
        text.push_str(&format!("{label}: {url}\n\n"));
    }
    if let Some(code) = &layout.code {
        text.push_str(&format!("    {code}\n\n"));
    }
    for p in &layout.outro {
        text.push_str(p);
        text.push_str("\n\n");
    }
    text.push_str("--\n");
    if !org.is_empty() {
        text.push_str(org);
        text.push('\n');
    }
    if !support.is_empty() {
        text.push_str(support);
        text.push('\n');
    }
    text.push_str(&format!(
        "You received this email because {}\n",
        layout.reason
    ));

    OutgoingMail {
        to: Vec::new(),
        subject: layout.subject,
        text,
        html,
        inline_logo_png: logo,
    }
}

fn minutes(n: i64) -> String {
    if n == 1 {
        "1 minute".to_string()
    } else {
        format!("{n} minutes")
    }
}

/// "Reset your {product} password" with the reset link.
pub fn password_reset(
    branding: &Branding,
    public_url: &str,
    link: &str,
    ttl_minutes: i64,
) -> OutgoingMail {
    let product = branding.product_name.trim();
    render(Layout {
        branding,
        public_url: Some(public_url),
        subject: format!("Reset your {product} password"),
        title: "Reset your password".to_string(),
        intro: vec![format!(
            "Someone requested a password reset for your {product} account. Use the button below to choose a new password."
        )],
        cta: Some(("Choose a new password".to_string(), link.to_string())),
        code: None,
        outro: vec![format!(
            "The link expires in {}. If you did not request this, ignore this email — your password stays as it is.",
            minutes(ttl_minutes)
        )],
        reason: format!("a password reset was requested for your {product} account."),
    })
}

/// "Your {product} password was changed" — security notice after a reset.
pub fn password_changed(branding: &Branding, public_url: &str, when: &str) -> OutgoingMail {
    let product = branding.product_name.trim();
    render(Layout {
        branding,
        public_url: Some(public_url),
        subject: format!("Your {product} password was changed"),
        title: "Your password was changed".to_string(),
        intro: vec![
            format!("The password of your {product} account was changed on {when}."),
            "All other sessions have been signed out.".to_string(),
        ],
        cta: Some(("Sign in".to_string(), format!("{}/login", public_url.trim_end_matches('/')))),
        code: None,
        outro: vec![
            "If this wasn't you, contact your administrator immediately so the account can be secured.".to_string(),
        ],
        reason: format!("the password of your {product} account was changed."),
    })
}

/// A one-time code for signing in or for enrolling email as a second factor.
pub fn two_factor_code(
    branding: &Branding,
    code: &str,
    ttl_minutes: i64,
    purpose: CodePurpose,
) -> OutgoingMail {
    let product = branding.product_name.trim();
    let (subject, title, intro) = match purpose {
        CodePurpose::Login => (
            format!("{code} is your {product} sign-in code"),
            "Your sign-in code".to_string(),
            format!("Enter this code to finish signing in to {product}."),
        ),
        CodePurpose::Enrol => (
            format!("{code} is your {product} verification code"),
            "Verify your email address".to_string(),
            format!(
                "Enter this code in {product} to confirm that email codes should be used as your second factor."
            ),
        ),
    };
    render(Layout {
        branding,
        public_url: None,
        subject,
        title,
        intro: vec![intro],
        cta: None,
        code: Some(code.to_string()),
        outro: vec![format!(
            "Expires in {}. Never share this code — {product} staff will never ask for it.",
            minutes(ttl_minutes)
        )],
        reason: format!("a sign-in code was requested for your {product} account."),
    })
}

/// "{product}: test email" — confirms the relay works and who triggered it.
pub fn test_message(branding: &Branding, public_url: &str, sent_by: &str) -> OutgoingMail {
    let product = branding.product_name.trim();
    render(Layout {
        branding,
        public_url: Some(public_url),
        subject: format!("{product}: test email"),
        title: "Email delivery works".to_string(),
        intro: vec![
            format!("This test message confirms that {product} can send email through the configured SMTP relay."),
            format!("It was sent by {sent_by} from the console settings."),
        ],
        cta: Some(("Open the console".to_string(), public_url.to_string())),
        code: None,
        outro: vec![],
        reason: format!("an administrator sent a test message from {product}."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn branding(logo: bool) -> Branding {
        Branding {
            product_name: "Acme <Remote>".into(),
            accent: "#12ab9f".into(),
            logo_png_base64: logo.then(|| {
                base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G'])
            }),
            support_text: "Support & help: +1 555".into(),
            organization: "Acme \"Corp\"".into(),
            apply_to_console: true,
        }
    }

    #[test]
    fn reset_mail_carries_link_and_escapes_branding() {
        let m = password_reset(
            &branding(false),
            "https://console.example",
            "https://console.example/reset-password?token=abc&x=1",
            30,
        );
        assert_eq!(m.subject, "Reset your Acme <Remote> password");
        assert!(m
            .text
            .contains("https://console.example/reset-password?token=abc&x=1"));
        assert!(
            m.html.contains("reset-password?token=abc&amp;x=1"),
            "{}",
            m.html
        );
        assert!(m.text.contains("30 minutes"));
        assert!(m.html.contains("#12ab9f"), "accent used");
        assert!(!m.html.contains("cid:logo"), "no logo → no cid");
        assert!(m.inline_logo_png.is_none());
        assert!(m.html.contains("Acme &lt;Remote&gt;"), "product escaped");
        assert!(!m.html.contains("Acme <Remote>"), "{}", m.html);
        assert!(
            m.html.contains("Acme &quot;Corp&quot;"),
            "organisation escaped"
        );
        assert!(
            m.html.contains("Support &amp; help"),
            "support text escaped"
        );
        assert!(m.html.contains("You received this email because"));
        assert!(m.to.is_empty());
    }

    #[test]
    fn logo_is_referenced_only_when_present() {
        let m = test_message(
            &branding(true),
            "https://console.example",
            "admin@example.com",
        );
        assert!(m.html.contains("src=\"cid:logo\""));
        assert_eq!(
            m.inline_logo_png.as_deref(),
            Some(&[0x89, b'P', b'N', b'G'][..])
        );
        assert_eq!(m.subject, "Acme <Remote>: test email");
        assert!(m.text.contains("admin@example.com"));
        let plain = test_message(&branding(false), "https://console.example", "x");
        assert!(!plain.html.contains("cid:logo"));
    }

    #[test]
    fn code_mail_shows_code_in_all_parts() {
        let m = two_factor_code(&branding(false), "042917", 10, CodePurpose::Login);
        assert_eq!(m.subject, "042917 is your Acme <Remote> sign-in code");
        assert!(m.text.contains("042917"));
        assert!(m.html.contains("042917"));
        assert!(m.html.contains("letter-spacing"), "large monospaced code");
        assert!(m.text.contains("10 minutes"));
        assert!(m.text.contains("Never share this code"));
        let e = two_factor_code(&branding(false), "000001", 10, CodePurpose::Enrol);
        assert_eq!(e.subject, "000001 is your Acme <Remote> verification code");
    }

    #[test]
    fn changed_mail_has_security_note() {
        let m = password_changed(
            &branding(false),
            "https://console.example",
            "2026-01-01 10:00 UTC",
        );
        assert_eq!(m.subject, "Your Acme <Remote> password was changed");
        assert!(m.text.contains("contact your administrator"));
        assert!(m.html.contains("2026-01-01 10:00 UTC"));
    }

    #[test]
    fn accent_ink_flips_on_light_colours() {
        assert_eq!(accent_ink("#ffffff"), "#0b1220");
        assert_eq!(accent_ink("#fde047"), "#0b1220");
        assert_eq!(accent_ink("#1d4ed8"), "#ffffff");
        assert_eq!(accent_ink("#000000"), "#ffffff");
        // Unparsable colours count as mid-grey (luminance 0.5), like the SPA.
        assert_eq!(accent_ink("garbage"), "#0b1220");
        let b = Branding {
            accent: "not-a-colour".into(),
            ..branding(false)
        };
        assert_eq!(accent(&b), "#3b82f6", "invalid accent falls back");
    }
}
