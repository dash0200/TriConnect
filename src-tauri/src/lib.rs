mod compression;
mod crypto;
mod file_ops;
mod hash;
mod network;

use file_ops::TempFileRegistry;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ── Plugins ──
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // ── Managed state ──
        .manage(TempFileRegistry::new())
        .manage(network::MeshState::new())
        // ── Tauri commands ──
        .invoke_handler(tauri::generate_handler![
            // File operations
            file_ops::prepare_receive_file,
            file_ops::append_chunk,
            file_ops::finalize_file,
            file_ops::cancel_receive,
            file_ops::read_file_chunk,
            file_ops::get_file_metadata,
            file_ops::save_pasted_file,
            // Hashing
            hash::hash_file,
            hash::hash_data,
            // Encryption
            crypto::generate_keypair,
            crypto::derive_shared_secret,
            crypto::encrypt,
            crypto::decrypt,
            // Compression
            compression::compress_data,
            compression::decompress_data,
            // Native Networking (Tier 3)
            network::window_start_signaling,
            network::signaling_create_room,
            network::signaling_join_room,
            network::send_message,
            network::disconnect_all,
        ])
        // ── System Tray ──
        .setup(|app| {
            // Build tray menu
            let show = MenuItemBuilder::with_id("show", "Show TriConnect").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            // Build tray icon (uses the app icon)
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("TriConnect")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Intercept window close → minimize to tray instead of quitting
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TriConnect");
}
