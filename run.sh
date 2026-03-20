#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# run.sh — Run TriConnect locally (signaling server + Tauri app))
# ══════════════════════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${CYAN}[TriConnect]${NC} $1"; }
ok()   { echo -e "${GREEN}  ✅ $1${NC}"; }
warn() { echo -e "${YELLOW}  ⚠️  $1${NC}"; }

# Track background PIDs for cleanup
PIDS=()

cleanup() {
    echo ""
    log "Shutting down..."
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null
            wait "$pid" 2>/dev/null
        fi
    done
    ok "All processes stopped."
    exit 0
}

trap cleanup SIGINT SIGTERM

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║         TriConnect — Local Development       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── 1. Start signaling server ──
log "Starting signaling server on port 8080..."
cd "$SCRIPT_DIR/signaling-server"
node server.js &
PIDS+=($!)
sleep 1

if kill -0 "${PIDS[0]}" 2>/dev/null; then
    ok "Signaling server running (PID: ${PIDS[0]}, ws://localhost:8080)"
else
    echo -e "${RED}  ❌ Signaling server failed to start${NC}"
    exit 1
fi

# ── 2. Start frontend dev server ──
log "Starting static file server on port 1420..."
cd "$SCRIPT_DIR"
npx --yes http-server src -p 1420 -c-1 -s &
PIDS+=($!)
sleep 2

# ── 3. Start Tauri dev server ──
log "Starting Tauri app in development mode..."
log "(First run will compile Rust — this takes a few minutes)"
echo ""

npx tauri dev 2>&1 &
PIDS+=($!)

ok "Tauri dev started (PID: ${PIDS[1]})"
echo ""
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  TriConnect is starting!${NC}"
echo -e "${GREEN}  • Signaling server: ws://localhost:8080${NC}"
echo -e "${GREEN}  • App window will open shortly...${NC}"
echo -e "${GREEN}  • Press Ctrl+C to stop everything${NC}"
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo ""

# Wait for any child to finish
wait
