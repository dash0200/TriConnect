use tauri::command;
use tokio::io::AsyncReadExt;

/// Stream a file through BLAKE3 hasher and return the hex digest.
/// Uses a 1MB buffer to avoid loading the entire file into memory.
#[command]
pub async fn hash_file(path: String) -> Result<String, String> {
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("Failed to open file for hashing: {}", e))?;

    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; 1024 * 1024]; // 1MB buffer

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read for hashing: {}", e))?;

        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(hasher.finalize().to_hex().to_string())
}

/// Hash in-memory data with BLAKE3 and return the hex digest.
/// Useful for small payloads like chat messages.
#[command]
pub fn hash_data(data: Vec<u8>) -> String {
    blake3::hash(&data).to_hex().to_string()
}
