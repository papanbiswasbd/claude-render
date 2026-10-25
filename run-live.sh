#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "🚀 Starting Claude Remotion Auto-Renderer..."
node server.js &
SERVER_PID=$!

sleep 2

echo "🌐 Creating Free Global Public HTTPS URL (Cloudflare Tunnel)..."
cloudflared tunnel --url http://localhost:4500

kill $SERVER_PID 2>/dev/null
