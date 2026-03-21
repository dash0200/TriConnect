# TriConnect — Rust Utilization Analysis & Feature Recommendations

## Current State: Rust is Barely Used 🔴

Your Rust backend is essentially a **thin Tauri shell** — only **~120 lines** across 3 files, providing just 3 Tauri commands:

| Rust Command | What It Does |
|---|---|
| [read_file_chunk](file:///home/dash/Documents/TriConnect/src-tauri/src/file_ops.rs#5-27) | Reads bytes from disk at an offset |
| [write_file_chunk](file:///home/dash/Documents/TriConnect/src-tauri/src/file_ops.rs#28-50) | Writes bytes to disk at an offset |
| [get_file_metadata](file:///home/dash/Documents/TriConnect/src-tauri/src/file_ops.rs#51-92) | Returns name, size, SHA-256 hash |

**Everything else — WebRTC, signaling, chat, file transfer, video sync, voice — is 100% JavaScript.** The Rust layer adds almost no value beyond what Tauri provides out of the box. Even the file transfer commands aren't being called from the JS side (the file-transfer module uses `File.slice()` / `Blob` browser APIs directly).

### Code Distribution

```
Rust   ≈  120 lines  (3%)   — file I/O wrappers only
JS     ≈ 1,700 lines (97%)  — ALL application logic
```

---

## What Rust *Should* Be Doing

In a Tauri app, Rust is your **performance layer, security boundary, and system integration point**. Here's what you're missing and what could be implemented:

---

## 🚀 Tier 1: Quick Wins (Properly Use What You Have)

### 1. End-to-End Encryption via Rust
> **Why Rust:** Crypto operations are CPU-intensive; Rust's [ring](file:///home/dash/Documents/TriConnect/src/js/video-sync.js#301-308) or `chacha20poly1305` crates are ~10–50x faster than JS crypto.

- Generate keypairs in Rust (X25519 key exchange)
- Encrypt/decrypt WebRTC data channel payloads before they hit the wire
- All 3 peers exchange public keys during signaling, then every message/chunk is E2E encrypted
- Tauri commands: `generate_keypair`, `derive_shared_secret`, `encrypt_payload`, `decrypt_payload`

### 2. File Hashing & Integrity Pipeline in Rust
> **Why Rust:** You already have `sha2` in Cargo.toml but the file transfer JS doesn't use [get_file_metadata](file:///home/dash/Documents/TriConnect/src-tauri/src/file_ops.rs#51-92). Rust hashing is significantly faster for large files.

- Hash files in Rust before sending, send hash alongside the file offer
- Receiver verifies hash in Rust after assembly
- Adds real integrity verification to your GB-scale file transfers
- Add `blake3` crate for even faster hashing (3–5x faster than SHA-256)

### 3. Native File Save Dialog (via Tauri's `dialog` plugin)
> **Why Rust/Tauri:** Currently received files are "downloaded" via a hacky `<a>` click. Use Tauri's native dialog to let users pick a save location, then write directly to disk via your existing [write_file_chunk](file:///home/dash/Documents/TriConnect/src-tauri/src/file_ops.rs#28-50).

---

## 🔧 Tier 2: Meaningful Optimizations (Medium Effort)

### 4. Streaming File I/O with Zero-Copy 
> **Why Rust:** The current JS approach holds the **entire received file in memory** as `receivedChunks[]` array, then assembles it with `new Blob(...)`. For GB-scale files, this will crash.

- On receive: stream chunks directly to disk via Rust ([write_file_chunk](file:///home/dash/Documents/TriConnect/src-tauri/src/file_ops.rs#28-50) at calculated offsets) — **no memory accumulation**
- On send: read chunks from disk via Rust ([read_file_chunk](file:///home/dash/Documents/TriConnect/src-tauri/src/file_ops.rs#5-27)) instead of `File.slice()` — avoids browser memory pressure
- Add a Rust-side `assemble_file` command that memory-maps and verifies the final file

### 5. Compression in Rust
> **Why Rust:** `zstd` or `lz4` compression in Rust is 5–20x faster than JS equivalents.

- Compress file chunks before sending over WebRTC
- Decompress on receive before writing to disk
- Tauri commands: `compress_chunk(data, level) → compressed`, `decompress_chunk(data) → original`
- Especially impactful for text-heavy files, logs, documents

### 6. System Tray & Background Running
> **Why Rust/Tauri:** Real desktop integration.

- Minimize to system tray instead of closing
- Show notification badges for new messages
- Keep P2P connections alive while minimized 
- Tauri plugins: `tauri-plugin-notification`, `tray-icon`

---

## 💡 Tier 3: Feature Ideas (Higher Effort, High Impact)

### 7. Screen Sharing
> **Why:** Completes the "hangout" experience alongside voice, chat, and video sync.

- Use WebRTC's `getDisplayMedia()` for capture
- Add a new DataChannel for screen frames or use media tracks
- Rust can handle thumbnail generation for preview

### 8. Persistent Chat History (SQLite via Rust)
> **Why Rust:** Efficient local database with `rusqlite` or `sea-orm`. Currently all messages are lost on app close.

- Store chat messages, file transfer history, room history in SQLite
- Tauri commands: `save_message`, `get_history`, `search_messages`
- Index by room code, timestamp, sender
- Show history when reconnecting to the same room (optional)

### 9. Clipboard Integration
> **Why Rust/Tauri:** Share clipboard content (text, images) with a hotkey.

- Paste images directly into chat
- Copy room code to clipboard (you have this, but could be richer)
- Tauri plugin: `tauri-plugin-clipboard-manager`

### 10. Auto-Update Mechanism
> **Why Rust/Tauri:** Ship updates seamlessly.

- Tauri's built-in updater plugin checks for new versions
- Users get prompted to update without manual download
- `tauri-plugin-updater`

### 11. Network Quality Indicator
> **Why Rust:** Parse WebRTC stats and compute quality scores efficiently.

- Poll `RTCPeerConnection.getStats()` and forward to Rust
- Rust computes rolling averages, jitter, packet loss metrics
- Display connection quality badge per peer (🟢🟡🔴)
- Tauri command: `compute_network_quality(stats) → { quality, latency, packetLoss }`

### 12. P2P File Sharing Folder (Shared Workspace)
> **Why Rust:** File system watching + diffing.

- Designate a folder that auto-syncs between all 3 peers
- Rust watches for file changes via `notify` crate
- Only diffs (changed chunks) are sent over WebRTC
- Like a mini P2P Dropbox for your triangle

---

## 📋 Priority Recommendation

| Priority | Feature | Effort | Impact |
|---|---|---|---|
| **P0** | Streaming file I/O (#4) | Medium | Fixes memory crash for large files |
| **P0** | File integrity verification (#2) | Low | Already half-built in Rust |
| **P1** | E2E encryption (#1) | Medium | Major security win |
| **P1** | Native file save dialog (#3) | Low | Polished UX |
| **P1** | System tray + notifications (#6) | Low | Real desktop feel |
| **P2** | Compression (#5) | Medium | Faster transfers |
| **P2** | Chat history via SQLite (#8) | Medium | Useful persistence |
| **P2** | Auto-updater (#10) | Low | Ship updates easily |
| **P3** | Screen sharing (#7) | High | Major feature |
| **P3** | Shared folder (#12) | High | Ambitious but cool |

---

## Summary

**You're using Rust as a paperweight.** The three file I/O commands exist but aren't even connected to the actual file transfer flow. To properly leverage Rust in a Tauri app, you should push **CPU-intensive work** (crypto, hashing, compression), **system integration** (tray, notifications, dialogs), and **memory-sensitive operations** (streaming file I/O) into the Rust backend, keeping JavaScript focused on UI rendering and WebRTC orchestration.

Let me know which features interest you and I'll create an implementation plan!
