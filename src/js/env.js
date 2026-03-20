// Environment Configuration
// This file acts as your .env equivalent for the vanilla JS frontend.

window.APP_ENV = {
  // The WebSocket URL for the signaling server.
  // Local development: "ws://localhost:8080"
  // GCP Production:    "ws://136.112.149.55:8080"
  SIGNALING_URL: "wss://136.112.149.55.sslip.io"
};
