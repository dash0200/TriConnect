use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    ChaCha20Poly1305, Nonce,
};
use rand::RngCore;
use serde::Serialize;
use tauri::command;
use x25519_dalek::{PublicKey, StaticSecret};

/// Keypair returned to the JS frontend (base64-encoded)
#[derive(Serialize)]
pub struct KeyPair {
    pub public_key: String,
    pub secret_key: String,
}

/// Generate an X25519 keypair for Diffie-Hellman key exchange.
/// Returns base64-encoded public and secret keys.
#[command]
pub fn generate_keypair() -> Result<KeyPair, String> {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);

    Ok(KeyPair {
        public_key: B64.encode(public.as_bytes()),
        secret_key: B64.encode(secret.to_bytes()),
    })
}

/// Derive a shared secret from our secret key and their public key.
/// Returns base64-encoded 32-byte shared secret (used as ChaCha20 key).
#[command]
pub fn derive_shared_secret(my_secret_b64: String, their_public_b64: String) -> Result<String, String> {
    let secret_bytes: [u8; 32] = B64
        .decode(&my_secret_b64)
        .map_err(|e| format!("Invalid secret key: {}", e))?
        .try_into()
        .map_err(|_| "Secret key must be 32 bytes".to_string())?;

    let public_bytes: [u8; 32] = B64
        .decode(&their_public_b64)
        .map_err(|e| format!("Invalid public key: {}", e))?
        .try_into()
        .map_err(|_| "Public key must be 32 bytes".to_string())?;

    let secret = StaticSecret::from(secret_bytes);
    let their_public = PublicKey::from(public_bytes);
    let shared = secret.diffie_hellman(&their_public);

    Ok(B64.encode(shared.as_bytes()))
}

/// Encrypt plaintext using ChaCha20-Poly1305 AEAD.
/// Prepends a random 12-byte nonce to the ciphertext.
/// shared_secret_b64: base64-encoded 32-byte key
/// plaintext: raw bytes to encrypt
/// Returns: [12-byte nonce || ciphertext || 16-byte tag]
#[command]
pub fn encrypt(shared_secret_b64: String, plaintext: Vec<u8>) -> Result<Vec<u8>, String> {
    let key_bytes: [u8; 32] = B64
        .decode(&shared_secret_b64)
        .map_err(|e| format!("Invalid key: {}", e))?
        .try_into()
        .map_err(|_| "Key must be 32 bytes".to_string())?;

    let cipher = ChaCha20Poly1305::new_from_slice(&key_bytes)
        .map_err(|e| format!("Cipher init failed: {}", e))?;

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    // Prepend nonce to ciphertext
    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

/// Decrypt ciphertext using ChaCha20-Poly1305 AEAD.
/// Expects input format: [12-byte nonce || ciphertext || 16-byte tag]
/// shared_secret_b64: base64-encoded 32-byte key
/// Returns: decrypted plaintext bytes
#[command]
pub fn decrypt(shared_secret_b64: String, ciphertext: Vec<u8>) -> Result<Vec<u8>, String> {
    if ciphertext.len() < 12 + 16 {
        return Err("Ciphertext too short (need at least nonce + tag)".to_string());
    }

    let key_bytes: [u8; 32] = B64
        .decode(&shared_secret_b64)
        .map_err(|e| format!("Invalid key: {}", e))?
        .try_into()
        .map_err(|_| "Key must be 32 bytes".to_string())?;

    let cipher = ChaCha20Poly1305::new_from_slice(&key_bytes)
        .map_err(|e| format!("Cipher init failed: {}", e))?;

    let nonce = Nonce::from_slice(&ciphertext[..12]);
    let plaintext = cipher
        .decrypt(nonce, &ciphertext[12..])
        .map_err(|e| format!("Decryption failed: {}", e))?;

    Ok(plaintext)
}
