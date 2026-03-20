#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# build_app.sh — Compile TriConnect for distribution
# ══════════════════════════════════════════════════════════════
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${CYAN}➜${NC} $1"; }
ok()    { echo -e "${GREEN}✅${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠️${NC} $1"; }

FORMAT=$1

if [ -z "$FORMAT" ]; then
    echo -e "${CYAN}TriConnect Builder${NC}"
    echo "Usage: ./build_app.sh [format]"
    echo ""
    echo "Available formats:"
    echo "  exe      (Windows NSIS Installer & Executable)"
    echo "  msi      (Windows MSI Installer)"
    echo "  app      (macOS .app bundle)"
    echo "  dmg      (macOS Disk Image)"
    echo "  deb      (Linux Debian Package)"
    echo "  appimage (Linux AppImage portable executable)"
    exit 1
fi

log "Preparing to build TriConnect as: $FORMAT"

case $FORMAT in
    exe)
        warn "Note: Building Windows executables works best when this script is run directly on Windows."
        npx tauri build --bundles nsis
        ;;
    msi)
        npx tauri build --bundles msi
        ;;
    app)
        warn "Note: Apple strictly restricts building .app bundles to macOS machines."
        npx tauri build --bundles app
        ;;
    dmg)
        npx tauri build --bundles dmg
        ;;
    deb)
        npx tauri build --bundles deb
        ;;
    appimage)
        npx tauri build --bundles appimage
        ;;
    *)
        echo -e "${RED}❌ Unknown format: $FORMAT${NC}"
        echo "Supported: exe, msi, app, dmg, deb, appimage"
        exit 1
        ;;
esac

echo ""
ok "Build complete!"
log "Your packaged application is located inside:"
log "src-tauri/target/release/bundle/"
