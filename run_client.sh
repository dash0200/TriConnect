#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# run_client.sh — Open an additional TriConnect desktop window
# 
# IMPORTANT: You must have already run ./run.sh in another
# terminal so that the signaling and web servers are active!
# ══════════════════════════════════════════════════════════════

echo -e "\033[0;36m[TriConnect]\033[0m Starting additional desktop client..."
cd "$(dirname "$0")"

# Ensure the binary is built
if [ ! -f "src-tauri/target/debug/triconnect" ]; then
    echo -e "\033[0;31m  ❌ App binary not found. Please run ./run.sh first to compile it.\033[0m"
    exit 1
fi

# Launch the compiled Tauri binary directly
./src-tauri/target/debug/triconnect
