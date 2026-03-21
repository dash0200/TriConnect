use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{command, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// Registry of active temp files for in-progress downloads.
/// Maps file_id → temp file path.
pub struct TempFileRegistry {
    pub files: Mutex<HashMap<String, PathBuf>>,
}

impl TempFileRegistry {
    pub fn new() -> Self {
        Self {
            files: Mutex::new(HashMap::new()),
        }
    }
}

/// Prepare a temp file for receiving a download.
/// Creates a file in the system temp dir and registers it.
/// Returns the temp file path.
#[command]
pub async fn prepare_receive_file(
    file_id: String,
    file_name: String,
    file_size: u64,
    registry: State<'_, TempFileRegistry>,
) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("triconnect");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let temp_path = temp_dir.join(format!("{}_{}", file_id, file_name));

    // Pre-allocate the file to the expected size
    let file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    file.set_len(file_size)
        .await
        .map_err(|e| format!("Failed to pre-allocate file: {}", e))?;

    let path_str = temp_path.to_string_lossy().to_string();

    registry
        .files
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?
        .insert(file_id, temp_path);

    Ok(path_str)
}

/// Write a chunk of data to a temp file at a specific offset.
/// This is called for each received chunk — no memory accumulation.
#[command]
pub async fn append_chunk(temp_path: String, offset: u64, data: Vec<u8>) -> Result<(), String> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&temp_path)
        .await
        .map_err(|e| format!("Failed to open temp file: {}", e))?;

    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("Failed to seek: {}", e))?;

    file.write_all(&data)
        .await
        .map_err(|e| format!("Failed to write chunk: {}", e))?;

    Ok(())
}

/// Move the completed temp file to the user's chosen save location.
#[command]
pub async fn finalize_file(
    file_id: String,
    temp_path: String,
    save_path: String,
    registry: State<'_, TempFileRegistry>,
) -> Result<(), String> {
    // Try rename first (instant if same filesystem), fall back to copy+delete
    let result = tokio::fs::rename(&temp_path, &save_path).await;
    if result.is_err() {
        tokio::fs::copy(&temp_path, &save_path)
            .await
            .map_err(|e| format!("Failed to copy file: {}", e))?;
        let _ = tokio::fs::remove_file(&temp_path).await;
    }

    // Unregister
    if let Ok(mut files) = registry.files.lock() {
        files.remove(&file_id);
    }

    Ok(())
}

/// Cancel a receive and clean up the temp file.
#[command]
pub async fn cancel_receive(
    file_id: String,
    registry: State<'_, TempFileRegistry>,
) -> Result<(), String> {
    let temp_path = registry
        .files
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?
        .remove(&file_id);

    if let Some(path) = temp_path {
        let _ = tokio::fs::remove_file(&path).await;
    }

    Ok(())
}

/// Read a chunk of a file from disk (used by the sender side).
#[command]
pub async fn read_file_chunk(path: String, offset: u64, size: u64) -> Result<Vec<u8>, String> {
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

/// Get basic file metadata (name and size).
#[command]
pub async fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    let file_path = PathBuf::from(&path);
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Failed to get metadata: {}", e))?;

    Ok(FileMetadata {
        name: file_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        size: metadata.len(),
    })
}

#[derive(serde::Serialize)]
pub struct FileMetadata {
    pub name: String,
    pub size: u64,
}

/// Helper: Flushes pure JS File blobs (e.g. pasted images) to the TriConnect OS Temp directory.
/// Returns the absolute path so the Rust-optimized file-transfer pipeline can transmit it.
#[tauri::command]
pub async fn save_pasted_file(data: Vec<u8>, filename: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("triconnect");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    
    let path = temp_dir.join(&filename);
    tokio::fs::write(&path, data)
        .await
        .map_err(|e| format!("Failed to write dumped blob: {}", e))?;
        
    Ok(path.to_string_lossy().to_string())
}
