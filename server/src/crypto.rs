use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, Mac};
use rand::{RngCore, rngs::OsRng};
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const PREFIX: &str = "enc:1:";
pub const SENSITIVE: &[&str] = &[
    "token",
    "refreshToken",
    "accessToken",
    "userAuthToken",
    "authToken",
    "appId",
    "appSecret",
    "secret",
    "arl",
    "masterSecret",
    "password",
    "cookie",
    "username",
    "email",
    "userId",
    "countryCode",
    "note",
    "session",
    "bypassToken",
    "turnstileJwt",
];
#[derive(Debug, Clone, Copy)]
pub struct CryptoError;
impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Credential encryption is unavailable.")
    }
}
impl std::error::Error for CryptoError {}
pub fn load_key(raw: &str) -> Option<[u8; 32]> {
    STANDARD.decode(raw).ok()?.try_into().ok()
}
pub fn sha256(value: impl AsRef<[u8]>) -> [u8; 32] {
    Sha256::digest(value).into()
}
pub fn secret_matches(a: &str, b: &str) -> bool {
    bool::from(sha256(a).ct_eq(&sha256(b)))
}
pub fn derive_client_key(key: &str) -> [u8; 32] {
    sha256(format!("archivepool-client:{key}"))
}
pub fn random_hex(len: usize) -> String {
    let mut bytes = vec![0; len];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
pub fn random_url(len: usize) -> String {
    let mut bytes = vec![0; len];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn encrypt_value(text: &str, key: &[u8; 32]) -> Result<String, CryptoError> {
    let mut iv = [0; 12];
    OsRng.fill_bytes(&mut iv);
    encrypt_with_iv(text, key, &iv)
}
pub fn encrypt_with_iv(text: &str, key: &[u8; 32], iv: &[u8; 12]) -> Result<String, CryptoError> {
    let cipher = Aes256Gcm::new(key.into());
    let sealed = cipher
        .encrypt(Nonce::from_slice(iv), text.as_bytes())
        .map_err(|_| CryptoError)?;
    Ok(format!(
        "{PREFIX}{}:{}",
        STANDARD.encode(iv),
        STANDARD.encode(sealed)
    ))
}
pub fn decrypt_value(text: &str, key: &[u8; 32]) -> Result<String, CryptoError> {
    let body = text.strip_prefix(PREFIX).ok_or(CryptoError)?;
    let (iv, data) = body.split_once(':').ok_or(CryptoError)?;
    let iv = STANDARD.decode(iv).map_err(|_| CryptoError)?;
    let iv: [u8; 12] = iv.try_into().map_err(|_| CryptoError)?;
    let data = STANDARD.decode(data).map_err(|_| CryptoError)?;
    let cipher = Aes256Gcm::new(key.into());
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), data.as_slice())
        .map_err(|_| CryptoError)?;
    String::from_utf8(plain).map_err(|_| CryptoError)
}
pub fn has_sensitive(payload: &Value, plaintext_only: bool) -> bool {
    payload.as_object().is_some_and(|o| {
        o.iter().any(|(k, v)| {
            SENSITIVE.contains(&k.as_str())
                && v.as_str()
                    .is_some_and(|s| !s.is_empty() && (!plaintext_only || !s.starts_with(PREFIX)))
        })
    })
}
pub fn encrypt(payload: &Value, key: Option<&[u8; 32]>) -> Result<Value, CryptoError> {
    let mut out = payload.clone();
    if let (Some(key), Some(obj)) = (key, out.as_object_mut()) {
        for (name, value) in obj {
            if let Some(text) = value.as_str().filter(|s| {
                SENSITIVE.contains(&name.as_str()) && !s.is_empty() && !s.starts_with(PREFIX)
            }) {
                *value = Value::String(encrypt_value(text, key)?);
            }
        }
    }
    Ok(out)
}
pub fn encrypt_at_rest(payload: &Value, key: Option<&[u8; 32]>) -> Result<Value, CryptoError> {
    if key.is_none() && has_sensitive(payload, false) {
        return Err(CryptoError);
    }
    encrypt(payload, key)
}
pub fn decrypt(payload: &Value, key: Option<&[u8; 32]>) -> Value {
    let mut out = payload.clone();
    if let Some(obj) = out.as_object_mut() {
        for (_, value) in obj {
            if let Some(text) = value.as_str().filter(|s| s.starts_with(PREFIX)) {
                *value = Value::String(
                    key.and_then(|k| decrypt_value(text, k).ok())
                        .unwrap_or_default(),
                );
            }
        }
    }
    out
}
pub fn sign(payload: &str, secret: &str) -> Result<String, CryptoError> {
    if secret.trim().is_empty() {
        return Err(CryptoError);
    }
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(secret.trim().as_bytes()).map_err(|_| CryptoError)?;
    mac.update(payload.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}
pub fn verify_signature(payload: &str, signature: &str, secret: &str) -> bool {
    sign(payload, secret).is_ok_and(|s| secret_matches(&s, signature))
}
pub fn session_token(user_id: i64, now: i64, secret: &str) -> Result<String, CryptoError> {
    let payload = format!("{user_id}.{}", now + 2_592_000_000i64);
    Ok(format!("{payload}.{}", sign(&payload, secret)?))
}
pub fn parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let len = s
        .char_indices()
        .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '+' || *c == '-')))
        .last()
        .map(|(i, c)| i + c.len_utf8())?;
    s[..len].parse().ok()
}
pub fn verify_session(token: &str, now: i64, secret: &str) -> Option<i64> {
    let p: Vec<_> = token.split('.').collect();
    if p.len() != 3 || !verify_signature(&format!("{}.{}", p[0], p[1]), p[2], secret) {
        return None;
    }
    if parse_int(p[1])? <= now {
        return None;
    }
    parse_int(p[0])
}
pub fn hash_password(password: &str) -> Result<String, CryptoError> {
    let salt = random_hex(16);
    let mut out = [0; 64];
    scrypt::scrypt(
        password.as_bytes(),
        &hex::decode(&salt).map_err(|_| CryptoError)?,
        &scrypt::Params::new(14, 8, 1, 64).map_err(|_| CryptoError)?,
        &mut out,
    )
    .map_err(|_| CryptoError)?;
    Ok(format!("16384:8:1:{salt}:{}", hex::encode(out)))
}
pub fn verify_password(password: &str, stored: &str) -> bool {
    let p: Vec<_> = stored.split(':').collect();
    if p.len() == 4 && p[0] == "pbkdf2" {
        let Ok(rounds) = p[1].parse::<u32>() else {
            return false;
        };
        let (Ok(salt), Ok(expected)) = (hex::decode(p[2]), hex::decode(p[3])) else {
            return false;
        };
        if rounds == 0 || rounds > 1_000_000 || expected.is_empty() || expected.len() > 128 {
            return false;
        }
        let mut out = vec![0; expected.len()];
        pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, rounds, &mut out);
        return bool::from(out.ct_eq(&expected));
    }
    if p.len() != 5 {
        return false;
    }
    let (Ok(n), Ok(r), Ok(par), Ok(salt), Ok(expected)) = (
        p[0].parse::<u32>(),
        p[1].parse::<u32>(),
        p[2].parse::<u32>(),
        hex::decode(p[3]),
        hex::decode(p[4]),
    ) else {
        return false;
    };
    if !n.is_power_of_two()
        || n > 65536
        || r > 16
        || par > 4
        || salt.is_empty()
        || expected.is_empty()
        || expected.len() > 128
    {
        return false;
    }
    let Ok(params) = scrypt::Params::new(n.trailing_zeros() as u8, r, par, expected.len()) else {
        return false;
    };
    let mut out = vec![0; expected.len()];
    scrypt::scrypt(password.as_bytes(), &salt, &params, &mut out).is_ok()
        && bool::from(out.ct_eq(&expected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const READ: &str = "atp_0123456789abcdef0123456789abcdef0123456789abcdef";
    const CIPHER: &str = "enc:1:AQIDBAUGBwgJCgsM:tMjrKmeOr80S7UHA/tzmwKcWXzToHl+ndlmCBalmuNRm/A==";
    fn key() -> [u8; 32] {
        load_key("ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8=").unwrap()
    }
    #[test]
    fn typescript_encryption_vectors() {
        assert_eq!(
            hex::encode(derive_client_key(READ)),
            "ab7c5854faacc76d498f04e371c614b5519ddff6d01d723cf33502853af10ee4"
        );
        assert_eq!(decrypt_value(CIPHER, &key()).unwrap(), "super-secret-token");
        assert_eq!(
            encrypt_with_iv(
                "super-secret-token",
                &key(),
                &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
            )
            .unwrap(),
            CIPHER
        );
        let client = "enc:1:DAsKCQgHBgUEAwIB:+hO7Au0Tn8cPb4Pi1XI/D7XwQj2tRcGwwnbCpUH2yL1d3/8=";
        assert_eq!(
            decrypt_value(client, &derive_client_key(READ)).unwrap(),
            "client-facing-token"
        );
        assert_eq!(
            encrypt_with_iv(
                "client-facing-token",
                &derive_client_key(READ),
                &[12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
            )
            .unwrap(),
            client
        );
    }
    #[test]
    fn sensitive_allowlist_and_fail_closed() {
        for field in SENSITIVE {
            let p = json!({*field:"value"});
            assert!(encrypt_at_rest(&p, None).is_err());
            let e = encrypt_at_rest(&p, Some(&key())).unwrap();
            assert!(e[field].as_str().unwrap().starts_with(PREFIX));
            assert_eq!(decrypt(&e, Some(&key())), p);
            assert_eq!(decrypt(&e, None)[field], "");
            assert_eq!(encrypt_at_rest(&e, Some(&key())).unwrap(), e);
        }
        let p = json!({"baseUrl":"https://example.com","premium":true,"turnstileJwtExpiresAt":"date","token":""});
        assert_eq!(encrypt_at_rest(&p, None).unwrap(), p);
        for malformed in ["enc:1:", "enc:1:AA==:AA==", "enc:1:bad:bad"] {
            assert!(decrypt_value(malformed, &key()).is_err());
        }
        assert!(load_key("invalid").is_none());
        assert!(load_key("").is_none());
    }
    #[test]
    fn typescript_session_vector_and_rejections() {
        let token = "42.1893456000000.IeMj_17z7YPk5BykQBLh8lRBuqCI_desjcUpXvDfuug";
        let secret = "test-session-secret-do-not-use";
        assert_eq!(verify_session(token, 1_800_000_000_000, secret), Some(42));
        for bad in [
            "",
            "42.1893456000000",
            "42.1893456000000.sig.extra",
            "43.1893456000000.IeMj_17z7YPk5BykQBLh8lRBuqCI_desjcUpXvDfuug",
        ] {
            assert_eq!(verify_session(bad, 1_800_000_000_000, secret), None);
        }
        assert_eq!(verify_session(token, 1_893_456_000_000, secret), None);
        assert_eq!(verify_session(token, 0, ""), None);
        assert!(session_token(1, 0, "").is_err());
        let t = session_token(7, 1_800_000_000_000, "another-secret").unwrap();
        assert!(t.starts_with("7.1802592000000."));
        assert_eq!(
            verify_session(&t, 1_800_000_000_000, "another-secret"),
            Some(7)
        );
        for (s, expected) in [
            ("42", Some(42)),
            (" 42abc", Some(42)),
            ("-7", Some(-7)),
            ("abc", None),
            ("", None),
        ] {
            assert_eq!(parse_int(s), expected);
        }
    }
    #[test]
    fn typescript_scrypt_hash() {
        let h = "16384:8:1:00112233445566778899aabbccddeeff:fcd5a58d5301bbc44e90fc9a53f156134baee795eb7735ed6473da86e34ba93009476236665814fe08f7bd38ad1f5a2709832fb447b93b94e1a4a94dc5d1442e";
        assert!(verify_password("correct horse battery staple", h));
        assert!(!verify_password("wrong", h));
        assert!(verify_password(
            "correct horse battery staple",
            &h[..h.len() - 4]
        ));
        let h = hash_password("hunter2hunter2").unwrap();
        assert!(h.starts_with("16384:8:1:"));
        assert_eq!(h.split(':').nth(3).unwrap().len(), 32);
        assert!(verify_password("hunter2hunter2", &h));
        for h in [
            "16384:8:1:abcd",
            "x:8:1:00:11",
            "16384:8:1::11",
            "16384:8:1:00:",
            "16384:8:1:zz:11",
            "github",
            "",
        ] {
            assert!(!verify_password("x", h));
        }
    }
    #[test]
    fn pbkdf2_known_answer() {
        let mut out = [0; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(b"password", b"salt", 1, &mut out);
        assert_eq!(
            hex::encode(out),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
    }
}
