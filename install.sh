#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# install.sh — Install all dependencies for TriConnect
# ══════════════════════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log()   { echo -e "${CYAN}[TriConnect]${NC} $1"; }
ok()    { echo -e "${GREEN}  ✅ $1${NC}"; }
warn()  { echo -e "${YELLOW}  ⚠️  $1${NC}"; }
fail()  { echo -e "${RED}  ❌ $1${NC}"; exit 1; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     TriConnect — Dependency Installer        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── 1. System dependencies (Linux only) ──
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    log "Installing system dependencies (requires sudo)..."
    sudo apt-get update -qq
    sudo apt-get install -y \
        libwebkit2gtk-4.1-dev \
        librsvg2-dev \
        patchelf \
        libssl-dev \
        libgtk-3-dev \
        libayatana-appindicator3-dev \
        2>&1 | tail -3
    ok "System dependencies installed"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    log "macOS detected — no extra system deps needed for Tauri."
    ok "System dependencies OK"
else
    warn "Windows detected — ensure WebView2 is installed (comes with Win 10/11)."
fi

# ── 2. Rust toolchain ──
log "Checking Rust..."
if command -v rustc &>/dev/null; then
    ok "Rust $(rustc --version | awk '{print $2}') already installed"
else
    log "Installing Rust via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
    ok "Rust installed: $(rustc --version)"
fi

# ── 3. Node.js check ──
log "Checking Node.js..."
if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 18 ]; then
        ok "Node.js $NODE_VER"
    else
        fail "Node.js 18+ required (found $NODE_VER). Please upgrade."
    fi
else
    fail "Node.js not found. Install from https://nodejs.org/"
fi

# ── 4. Frontend & Tauri dependencies ──
log "Installing frontend & Tauri dependencies..."
cd "$SCRIPT_DIR"
if [ ! -f "package.json" ]; then
    npm init -y > /dev/null
fi
npm install @tauri-apps/cli@^2 @tauri-apps/api@^2 --silent
ok "Frontend dependencies installed"

# ── 5. Signaling server deps ──
log "Installing signaling server dependencies..."
cd "$SCRIPT_DIR/signaling-server"
npm install --silent
ok "Signaling server dependencies installed"

echo ""
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  All dependencies installed successfully! 🎉${NC}"
echo -e "${GREEN}  Run ./run.sh to start the app.${NC}"
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo ""
