//! Authenticated encryption for installation-bound provider credentials.
use crate::{Error, Result};
use ring::{
    aead, hmac,
    rand::{SecureRandom, SystemRandom},
};
#[derive(Clone)]
pub struct Vault([u8; 32]);
impl Vault {
    pub fn from_hex(value: &str) -> Result<Self> {
        let bytes = decode_hex(value).ok_or(Error::Invalid(
            "META_CREDENTIAL_KEY must contain 64 hexadecimal characters".into(),
        ))?;
        Ok(Self(bytes.try_into().map_err(|_| {
            Error::Invalid("META_CREDENTIAL_KEY must contain 64 hexadecimal characters".into())
        })?))
    }
    fn key(&self) -> Result<aead::LessSafeKey> {
        Ok(aead::LessSafeKey::new(
            aead::UnboundKey::new(&aead::AES_256_GCM, &self.0).map_err(|_| Error::Internal)?,
        ))
    }
    pub fn seal(&self, context: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| Error::Internal)?;
        let mut data = plaintext.to_vec();
        self.key()?
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(context),
                &mut data,
            )
            .map_err(|_| Error::Internal)?;
        Ok([nonce.to_vec(), data].concat())
    }
    pub fn open(&self, context: &str, ciphertext: &[u8]) -> Result<Vec<u8>> {
        if ciphertext.len() < 28 {
            return Err(Error::Internal);
        }
        let nonce: [u8; 12] = ciphertext[..12].try_into().map_err(|_| Error::Internal)?;
        let mut data = ciphertext[12..].to_vec();
        Ok(self
            .key()?
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(context),
                &mut data,
            )
            .map_err(|_| Error::Internal)?
            .to_vec())
    }
}
fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}
pub fn verify_meta_signature(secret: &str, body: &[u8], signature: &str) -> bool {
    let Some(bytes) = signature.strip_prefix("sha256=").and_then(decode_hex) else {
        return false;
    };
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
        body,
        &bytes,
    )
    .is_ok()
}
pub fn secure_equal(a: &str, b: &str) -> bool {
    let key = hmac::Key::new(hmac::HMAC_SHA256, b"commerce-meta-comparison");
    hmac::verify(&key, a.as_bytes(), hmac::sign(&key, b.as_bytes()).as_ref()).is_ok()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ciphertext_is_random_and_bound_to_installation() {
        let v = Vault::from_hex(&"ab".repeat(32)).unwrap();
        let a = v.seal("one", b"secret").unwrap();
        assert_ne!(a, v.seal("one", b"secret").unwrap());
        assert_eq!(v.open("one", &a).unwrap(), b"secret");
        assert!(v.open("two", &a).is_err());
        let mut corrupt = a;
        corrupt[13] ^= 1;
        assert!(v.open("one", &corrupt).is_err());
    }
    #[test]
    fn signed_body_cannot_be_modified() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"secret");
        let sig = format!(
            "sha256={}",
            hmac::sign(&key, b"body")
                .as_ref()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        assert!(verify_meta_signature("secret", b"body", &sig));
        assert!(!verify_meta_signature("secret", b"changed", &sig));
        assert!(!verify_meta_signature("secret", b"body", "sha256=bad"));
    }
}
