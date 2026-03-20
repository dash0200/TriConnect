use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::command;

/// Read a chunk of a file from disk
#[command]
pub async fn read_file_chunk(path: String, offset: u64, size: u64) -> Result<Vec<u8>, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;

    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("Failed to seek: {}", e))?;

    let mut buffer = vec![0u8; size as usize];
    let bytes_read = file
        .read(&mut buffer)
        .await
        .map_err(|e| format!("Failed to read: {}", e))?;

    buffer.truncate(bytes_read);
    Ok(buffer)
}

/// Write a chunk of data to a file at a specific offset
#[command]
pub async fn write_file_chunk(path: String, offset: u64, data: Vec<u8>) -> Result<(), String> {
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&path)
        .await
        .map_err(|e| format!("Failed to open file for writing: {}", e))?;

    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("Failed to seek: {}", e))?;

    file.write_all(&data)
        .await
        .map_err(|e| format!("Failed to write: {}", e))?;

    Ok(())
}

/// Get file metadata (name, size, SHA-256 hash)
#[command]
pub async fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    use tokio::io::AsyncReadExt;

    let file_path = PathBuf::from(&path);
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Failed to get metadata: {}", e))?;

    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024]; // 1MB buffer for hashing

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

    let hash = format!("{:x}", hasher.finalize());

    Ok(FileMetadata {
        name: file_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        size: metadata.len(),
        hash,
    })
}

#[derive(serde::Serialize)]
pub struct FileMetadata {
    pub name: String,
    pub size: u64,
    pub hash: String,
}
