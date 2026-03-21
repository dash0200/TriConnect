use tauri::command;

/// Compress data using Zstandard at the given level (1-22, default 3).
/// Level 3 is a good balance of speed vs ratio for real-time file transfer.
#[command]
pub fn compress_data(data: Vec<u8>, level: Option<i32>) -> Result<Vec<u8>, String> {
    let lvl = level.unwrap_or(3);
    zstd::bulk::compress(&data, lvl).map_err(|e| format!("Compression failed: {}", e))
}

/// Decompress Zstandard-compressed data.
#[command]
pub fn decompress_data(data: Vec<u8>) -> Result<Vec<u8>, String> {
    zstd::stream::decode_all(data.as_slice()).map_err(|e| format!("Decompression failed: {}", e))
}
