#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# run_frontend.sh — Start an instance of the TriConnect frontend
#
# Usage: ./run_frontend.sh [port]
# Example: ./run_frontend.sh 1421
# ══════════════════════════════════════════════════════════════

PORT=${1:-1420}

echo -e "\033[0;36m[TriConnect]\033[0m Starting frontend static server on port $PORT..."
cd "$(dirname "$0")"

# Start the static file server
npx --yes http-server src -p "$PORT" -c-1 -s &
SERVER_PID=$!

echo -e "\033[0;32m  ✅ Frontend server running at http://localhost:$PORT\033[0m"
echo -e "\033[1;33m  (Press Ctrl+C to stop)\033[0m"

# Wait for Ctrl+C
wait $SERVER_PID
