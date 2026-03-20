# TriConnect
https://dash0200.github.io/TriConnect/
> **P2P mesh desktop app for exactly 3 users** — Chat, file sharing, and synchronized YouTube watching, all peer-to-peer.

![Topology](https://img.shields.io/badge/topology-triangle_mesh-blue)
![Stack](https://img.shields.io/badge/stack-Tauri_v2_%2B_Node.js-green)
![License](https://img.shields.io/badge/license-MIT-yellow)

## Features

- **🔗 P2P Mesh** — Direct WebRTC connections between all 3 users (triangle topology)
- **💬 Chat** — Real-time text messaging with peer colors
- **📁 File Transfer** — Send files of any size (GB-scale) with progress tracking
- **▶️ Watch Together** — Synchronized YouTube viewing with <1s drift correction
- **🔒 No Server** — After initial connection, all data flows directly between peers
- **🖥️ Cross-platform** — Windows, macOS, and Linux

## Architecture

```
┌─────────────────────────────────────┐
│      Node.js Signaling Server       │
│  (WebSocket - initial setup only)   │
└──────┬────────────┬────────┬────────┘
       │            │        │
   ┌───▼───┐   ┌───▼───┐  ┌─▼─────┐
   │ User A│◄─►│ User B│◄►│User C │
   └───────┘   └───────┘  └───────┘
      ▲                       ▲
      └───────────────────────┘
        Direct P2P (WebRTC)
```

## Prerequisites

- **Rust** (1.70+) — [rustup.rs](https://rustup.rs/)
- **Node.js** (18+) — [nodejs.org](https://nodejs.org/)
- **System dependencies** (Linux only):
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev \
    librsvg2-dev patchelf libssl-dev libgtk-3-dev \
    libayatana-appindicator3-dev
  ```

## Quick Start

### 1. Start the Signaling Server

```bash
cd signaling-server
npm install
npm run dev
# Server runs on ws://localhost:8080
```

### 2. Run the Desktop App (Development)

```bash
# Install Tauri CLI if not already installed
cargo install tauri-cli --version "^2"

# Run in development mode
cargo tauri dev
```

### 3. Connect with Friends

1. **User A** clicks "Create Room" → gets a 6-character room code
2. **User B & C** enter the code and click "Join"
3. All 3 are now connected P2P! 🎉

## Building for Production

```bash
cargo tauri build
```

Binaries will be in `src-tauri/target/release/bundle/`.

## Deploying the Signaling Server

```bash
cd signaling-server
docker build -t triconnect-signaling .
docker run -p 8080:8080 triconnect-signaling
```

For cloud deployment, push to Railway, Render, or Fly.io and update the server URL in the app's settings.

## Project Structure

```
TriConnect/
├── signaling-server/          # Node.js WebSocket server
│   ├── server.js              # Room mgmt, SDP/ICE relay
│   ├── package.json
│   └── Dockerfile
├── src-tauri/                 # Rust backend (Tauri v2)
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   └── file_ops.rs        # Streaming file I/O
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                       # Web frontend
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── app.js             # Main orchestrator
│       ├── signaling.js       # WebSocket client
│       ├── webrtc.js          # WebRTC mesh manager
│       ├── chat.js            # Chat feature
│       ├── file-transfer.js   # Chunked file transfer
│       ├── video-sync.js      # YouTube sync engine
│       └── ui.js              # Toasts & helpers
└── README.md
```

## How It Works

### Signaling (Initial Connection)
1. Creator opens a WebSocket to the signaling server and gets a room code
2. Joiners connect and exchange WebRTC SDP offers/answers via the server
3. ICE candidates are relayed through the server
4. Once P2P connections are established, the signaling server is no longer needed

### Data Channels
Each peer connection has 3 named DataChannels:
- `chat` — Ordered, reliable text messages
- `file-transfer` — Binary chunks with backpressure control
- `video-sync` — Play/pause/seek events + timestamp heartbeats

### Video Sync Algorithm
- On play/pause/seek → broadcast action to all peers
- Every 2s → heartbeat with current timestamp
- If drift > 0.8s → auto-seek to correct position
- Buffering coordination: peers pause while others buffer

## License

MIT
