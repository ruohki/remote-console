//! Shared single sign-on logic: identity → console user (link / provision), IdP group → role /
//! device-group mapping, and grant synchronisation. Used by OIDC, SAML and LDAP.

use crate::app::AppState;
use crate::db::{self, audit::Actor, models::AuthMethod, models::GroupPermission, models::Role};
use crate::error::ApiError;
use anyhow::Result;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

/// What an identity provider told us about the person who just authenticated.
#[derive(Debug, Clone)]
pub struct SsoIdentity {
    pub provider: AuthMethod,
    /// Stable subject identifier at the provider (`sub`, SAML `NameID`, LDAP DN).
    pub subject: String,
    pub email: String,
    /// `false` only when the provider explicitly says the address is unverified.
    pub email_verified: bool,
    pub name: String,
    pub groups: Vec<String>,
    /// The provider asserted a multi-factor authentication.
    pub mfa: bool,
}

/// One mapping rule (API.md "IdP group / role mapping").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Mapping {
    pub idp_group: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<GroupGrantSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroupGrantSpec {
    pub group_id: String,
    pub permission: GroupPermission,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    #[default]
    Additive,
    Authoritative,
}

/// Role for users no rule matched.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum DefaultRole {
    #[default]
    Operator,
    Admin,
    /// Reject the login.
    None,
}

/// Provider-independent policy settings shared by all SSO providers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderPolicy {
    #[serde(default = "default_true")]
    pub auto_provision: bool,
    #[serde(default)]
    pub default_role: DefaultRole,
    #[serde(default)]
    pub mappings: Vec<Mapping>,
    #[serde(default)]
    pub sync_mode: SyncMode,
    #[serde(default)]
    pub trust_idp_mfa: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_domains: Vec<String>,
}

fn default_true() -> bool {
    true
}

impl Default for ProviderPolicy {
    fn default() -> Self {
        Self {
            auto_provision: true,
            default_role: DefaultRole::Operator,
            mappings: vec![],
            sync_mode: SyncMode::Additive,
            trust_idp_mfa: false,
            allowed_domains: vec![],
        }
    }
}

/// Result of evaluating the mapping rules against a user's IdP groups.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct MappingOutcome {
    /// Highest role from matching rules (`None` when no rule set a role).
    pub role: Option<Role>,
    /// Device-group grants (highest permission per group).
    pub grants: BTreeMap<String, GroupPermission>,
    /// Rules that matched (for the test endpoint / audit).
    pub matched: Vec<String>,
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    if pattern.contains(['*', '?', '[']) {
        glob_match::glob_match(pattern, value)
    } else {
        pattern.eq_ignore_ascii_case(value)
    }
}

/// Evaluate all rules top to bottom; every matching rule applies.
pub fn evaluate(mappings: &[Mapping], groups: &[String]) -> MappingOutcome {
    let mut out = MappingOutcome::default();
    for rule in mappings {
        let hit = groups.iter().any(|g| glob_matches(&rule.idp_group, g));
        if !hit {
            continue;
        }
        out.matched.push(rule.idp_group.clone());
        if let Some(role) = rule.role {
            out.role = match (out.role, role) {
                (Some(Role::Admin), _) | (_, Role::Admin) => Some(Role::Admin),
                _ => Some(role),
            };
        }
        for g in &rule.groups {
            let entry = out
                .grants
                .entry(g.group_id.clone())
                .or_insert(GroupPermission::View);
            if g.permission == GroupPermission::Connect {
                *entry = GroupPermission::Connect;
            }
        }
    }
    out
}

fn domain_allowed(policy: &ProviderPolicy, email: &str) -> bool {
    if policy.allowed_domains.is_empty() {
        return true;
    }
    let domain = email.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    policy.allowed_domains.iter().any(|d| {
        d.trim()
            .trim_start_matches('@')
            .eq_ignore_ascii_case(&domain)
    })
}

/// The console user for an identity, after linking / provisioning and mapping sync.
pub struct SsoLogin {
    pub user: db::models::UserRow,
    pub provisioned: bool,
    pub linked: bool,
    /// The IdP satisfied the second-factor requirement.
    pub mfa_satisfied: bool,
}

/// Resolve or create the user and apply role/group mappings. Errors are API errors so the
/// callers can surface them to the browser (`403 sso_denied`, `409 …`).
pub async fn login(
    state: &AppState,
    identity: &SsoIdentity,
    policy: &ProviderPolicy,
) -> Result<SsoLogin, ApiError> {
    let provider = identity.provider.as_str();
    let email = identity.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(denied(
            "the identity provider did not supply an email address",
        ));
    }
    if !identity.email_verified {
        return Err(denied(
            "the identity provider reports the email address as unverified",
        ));
    }
    if !domain_allowed(policy, &email) {
        return Err(denied("this email domain is not allowed to sign in"));
    }

    let outcome = evaluate(&policy.mappings, &identity.groups);

    // 1. Existing link → user.
    let mut linked = false;
    let mut provisioned = false;
    let user = match db::auth::user_id_for_link(&state.db, provider, &identity.subject).await? {
        Some(uid) => db::users::by_id(&state.db, &uid).await?,
        None => None,
    };
    let user = match user {
        Some(u) => Some(u),
        None => {
            // 2. Link by email.
            match db::users::by_email(&state.db, &email).await? {
                Some(u) => {
                    db::auth::link_user(
                        &state.db,
                        &u.id,
                        provider,
                        &identity.subject,
                        Some(&email),
                    )
                    .await?;
                    linked = true;
                    Some(u)
                }
                None => None,
            }
        }
    };
    let user = match user {
        Some(u) => u,
        None => {
            // 3. Provision.
            if !policy.auto_provision {
                return Err(denied("no console account exists for this identity"));
            }
            let role = match (outcome.role, policy.default_role) {
                (Some(r), _) => r,
                (None, DefaultRole::Operator) => Role::Operator,
                (None, DefaultRole::Admin) => Role::Admin,
                (None, DefaultRole::None) => {
                    return Err(denied(
                        "no access rule matched this identity and self-service access is off",
                    ))
                }
            };
            let name = if identity.name.trim().is_empty() {
                email.clone()
            } else {
                identity.name.trim().to_string()
            };
            // Unusable password: SSO accounts sign in through the provider only.
            let hash = crate::auth::hash_password(&crate::ids::secret())?;
            let user = db::users::create(&state.db, &email, &name, &hash, role).await?;
            db::users::set_auth_methods(&state.db, &user.id, &[identity.provider]).await?;
            db::auth::link_user(
                &state.db,
                &user.id,
                provider,
                &identity.subject,
                Some(&email),
            )
            .await?;
            provisioned = true;
            db::audit::record_lossy(
                &state.db,
                Some(Actor {
                    id: &user.id,
                    name: &user.name,
                }),
                "sso.provision",
                Some(&user.id),
                json!({ "provider": provider, "email": email, "role": role }),
            )
            .await;
            db::users::by_id(&state.db, &user.id).await?.unwrap_or(user)
        }
    };

    if user.disabled {
        return Err(denied("this account is disabled"));
    }
    if linked {
        db::audit::record_lossy(
            &state.db,
            Some(Actor {
                id: &user.id,
                name: &user.name,
            }),
            "sso.link",
            Some(&user.id),
            json!({ "provider": provider, "email": email }),
        )
        .await;
        // Remember that the account can also sign in through this provider.
        let mut methods = user.auth_methods();
        if !methods.contains(&identity.provider) {
            methods.push(identity.provider);
            db::users::set_auth_methods(&state.db, &user.id, &methods).await?;
        }
    }

    // 4. Role + grant synchronisation.
    let changes = sync_mappings(state, &user, &outcome, policy).await?;
    if changes.changed() {
        db::audit::record_lossy(
            &state.db,
            Some(Actor {
                id: &user.id,
                name: &user.name,
            }),
            "sso.mapping",
            Some(&user.id),
            json!({
                "provider": provider,
                "matched": outcome.matched,
                "role": changes.role,
                "grants_added": changes.added,
                "grants_removed": changes.removed,
                "sync_mode": policy.sync_mode,
            }),
        )
        .await;
        state.hub.refresh_access().await;
    }

    let user = db::users::by_id(&state.db, &user.id).await?.unwrap_or(user);
    Ok(SsoLogin {
        mfa_satisfied: policy.trust_idp_mfa && identity.mfa,
        user,
        provisioned,
        linked,
    })
}

#[derive(Debug, Default, Serialize)]
pub struct SyncChanges {
    pub role: Option<Role>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

impl SyncChanges {
    fn changed(&self) -> bool {
        self.role.is_some() || !self.added.is_empty() || !self.removed.is_empty()
    }
}

/// Apply the mapping outcome to an existing user according to the sync mode.
pub async fn sync_mappings(
    state: &AppState,
    user: &db::models::UserRow,
    outcome: &MappingOutcome,
    policy: &ProviderPolicy,
) -> Result<SyncChanges, ApiError> {
    let mut changes = SyncChanges::default();

    // Role: additive never demotes; authoritative sets the computed role (or the default)
    // but never removes the last active admin.
    let target_role = match (policy.sync_mode, outcome.role) {
        (_, Some(r)) => Some(r),
        (SyncMode::Authoritative, None) => match policy.default_role {
            DefaultRole::Operator => Some(Role::Operator),
            DefaultRole::Admin => Some(Role::Admin),
            DefaultRole::None => None,
        },
        (SyncMode::Additive, None) => None,
    };
    if let Some(target) = target_role {
        let current = user.role();
        let apply = match policy.sync_mode {
            SyncMode::Additive => target == Role::Admin && current != Role::Admin,
            SyncMode::Authoritative => target != current,
        };
        if apply {
            if current == Role::Admin
                && target != Role::Admin
                && db::users::count_active_admins(&state.db).await? <= 1
            {
                tracing::warn!(user = %user.email, "SSO mapping would remove the last admin; kept");
                db::audit::record_lossy(
                    &state.db,
                    None,
                    "sso.mapping",
                    Some(&user.id),
                    json!({ "refused": "last_admin", "wanted_role": target }),
                )
                .await;
            } else {
                db::users::set_role(&state.db, &user.id, target).await?;
                changes.role = Some(target);
            }
        }
    }

    // Grants: only touch rows the SSO owns; manual grants stay.
    let existing = db::auth::grants_with_source(&state.db, &user.id).await?;
    for (group_id, permission) in &outcome.grants {
        if db::groups::by_id(&state.db, group_id).await?.is_none() {
            tracing::warn!(group_id, "SSO mapping references an unknown group; skipped");
            continue;
        }
        let already = existing.iter().find(|g| &g.group_id == group_id);
        let needs = match already {
            None => true,
            Some(g) => {
                g.source == "sso"
                    && GroupPermission::parse(&g.permission) != Some(*permission)
                    && *permission == GroupPermission::Connect
            }
        };
        if needs {
            db::auth::upsert_sso_grant(&state.db, &user.id, group_id, *permission).await?;
            changes.added.push(group_id.clone());
        }
    }
    if policy.sync_mode == SyncMode::Authoritative {
        for g in existing.iter().filter(|g| g.source == "sso") {
            if !outcome.grants.contains_key(&g.group_id) {
                db::auth::delete_sso_grant(&state.db, &user.id, &g.group_id).await?;
                changes.removed.push(g.group_id.clone());
            }
        }
    }
    Ok(changes)
}

fn denied(message: &str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "sso_denied", message)
}

/// Return path validation for `?return=`: same-origin absolute paths only.
pub fn safe_return(path: Option<&str>) -> String {
    match path {
        Some(p)
            if p.starts_with('/') && !p.starts_with("//") && !p.contains("\\") && p.len() < 512 =>
        {
            p.to_string()
        }
        _ => "/devices".to_string(),
    }
}

/// Whether an OIDC `amr` / SAML AuthnContext indicates multi-factor authentication.
pub fn indicates_mfa<'a>(values: impl IntoIterator<Item = &'a str>) -> bool {
    values.into_iter().any(|v| {
        let v = v.to_ascii_lowercase();
        v == "mfa"
            || v == "hwk"
            || v == "otp"
            || v == "sc"
            || v == "swk"
            || v == "fido"
            || v == "fpt"
            || v == "iris"
            || v == "face"
            || v == "vbm"
            || v.contains("multifactor")
            || v.contains("multipleauthn")
            || v.ends_with(":ac:classes:timesynctoken")
            || v.ends_with(":ac:classes:x509")
            || v.ends_with(":ac:classes:smartcardpki")
            || v.ends_with(":ac:classes:mobiletwofactorcontract")
            || v.ends_with(":ac:classes:mobiletwofactorunregistered")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(g: &str, role: Option<Role>, groups: &[(&str, GroupPermission)]) -> Mapping {
        Mapping {
            idp_group: g.into(),
            role,
            groups: groups
                .iter()
                .map(|(id, p)| GroupGrantSpec {
                    group_id: id.to_string(),
                    permission: *p,
                })
                .collect(),
        }
    }

    #[test]
    fn evaluates_exact_and_glob_rules() {
        let rules = vec![
            rule(
                "it-support-*",
                Some(Role::Operator),
                &[("grp_a", GroupPermission::View)],
            ),
            rule("IT-Admins", Some(Role::Admin), &[]),
            rule(
                "berlin",
                None,
                &[
                    ("grp_a", GroupPermission::Connect),
                    ("grp_b", GroupPermission::View),
                ],
            ),
        ];
        let out = evaluate(&rules, &["it-support-de".into(), "berlin".into()]);
        assert_eq!(out.role, Some(Role::Operator));
        assert_eq!(
            out.grants["grp_a"],
            GroupPermission::Connect,
            "highest wins"
        );
        assert_eq!(out.grants["grp_b"], GroupPermission::View);
        assert_eq!(out.matched, vec!["it-support-*", "berlin"]);

        let admin = evaluate(&rules, &["it-admins".into()]);
        assert_eq!(
            admin.role,
            Some(Role::Admin),
            "exact match is case-insensitive"
        );
        let none = evaluate(&rules, &["marketing".into()]);
        assert_eq!(none.role, None);
        assert!(none.grants.is_empty());
    }

    #[test]
    fn admin_only_via_explicit_rule() {
        let rules = vec![rule("*", Some(Role::Operator), &[])];
        assert_eq!(
            evaluate(&rules, &["anything".into()]).role,
            Some(Role::Operator)
        );
    }

    #[test]
    fn domain_and_return_helpers() {
        let mut p = ProviderPolicy::default();
        assert!(domain_allowed(&p, "a@example.com"));
        p.allowed_domains = vec!["Example.com".into(), "@corp.example".into()];
        assert!(domain_allowed(&p, "a@example.com"));
        assert!(domain_allowed(&p, "b@corp.example"));
        assert!(!domain_allowed(&p, "c@evil.example"));
        assert_eq!(safe_return(Some("/sessions?x=1")), "/sessions?x=1");
        assert_eq!(safe_return(Some("//evil.example")), "/devices");
        assert_eq!(safe_return(Some("https://evil.example")), "/devices");
        assert_eq!(safe_return(None), "/devices");
    }

    #[test]
    fn mfa_indicators() {
        assert!(indicates_mfa(["pwd", "mfa"]));
        assert!(indicates_mfa([
            "urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken"
        ]));
        assert!(indicates_mfa([
            "http://schemas.microsoft.com/claims/multipleauthn"
        ]));
        assert!(!indicates_mfa(["pwd"]));
        assert!(!indicates_mfa([
            "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"
        ]));
    }
}
