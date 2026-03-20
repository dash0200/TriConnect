mod file_ops;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            file_ops::read_file_chunk,
            file_ops::write_file_chunk,
            file_ops::get_file_metadata,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TriConnect");
}
