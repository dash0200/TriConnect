/* ═══════════════════════════════════════════════════════════
   signaling.js — Client for the signaling server
   ═══════════════════════════════════════════════════════════ */

window.Signaling = (() => {
  const isTauri = typeof window.__TAURI__ !== "undefined";
  let ws = null;
  let serverUrl = "";
  const handlers = {}; // type → [callback]

  function on(type, callback) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(callback);
  }

  function emit(type, data) {
    (handlers[type] || []).forEach((cb) => cb(data));
  }

  async function connect(url) {
    serverUrl = url;
    
    // ── Tier 3: Native Rust Signaling ──
    if (isTauri && window.__TAURI__.event) {
      console.log("[Signaling] Connecting via Rust backend to", url);
      
      // Setup listeners for Rust events
      await window.__TAURI__.event.listen("signaling-message", (event) => {
        const msg = event.payload;
        // The Rust payload JSON matches our protocol
        console.log("[Signaling] Received from Rust:", msg.type, msg);
        emit(msg.type, msg);
      });
      
      await window.__TAURI__.event.listen("signaling-disconnected", () => {
        console.log("[Signaling] Disconnected via Rust");
        emit("disconnected", {});
      });
      
      return window.__TAURI__.core.invoke("window_start_signaling", { urlStr: url });
    }

    // ── Fallback: Web Browser WS ──
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url);

      ws.onopen = () => {
        console.log("[Signaling] Connected to", url);
        resolve();
      };

      ws.onerror = (err) => {
        console.error("[Signaling] Connection error:", err);
        reject(new Error("Failed to connect to signaling server"));
      };

      ws.onclose = () => {
        console.log("[Signaling] Disconnected");
        emit("disconnected", {});
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          console.warn("[Signaling] Invalid message:", event.data);
          return;
        }
        console.log("[Signaling] Received:", msg.type, msg);
        emit(msg.type, msg);
      };
    });
  }

  function send(message) {
    if (isTauri && window.__TAURI__.core) {
      console.warn("[Signaling] send() called directly in Rust mode! This is ignored as Rust handles WebRTC signaling automatically.");
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      console.warn("[Signaling] Cannot send — not connected");
    }
  }

  function createRoom() {
    if (isTauri && window.__TAURI__.core) {
      window.__TAURI__.core.invoke("signaling_create_room");
    } else {
      send({ type: "create-room" });
    }
  }

  function joinRoom(roomCode) {
    if (isTauri && window.__TAURI__.core) {
      window.__TAURI__.core.invoke("signaling_join_room", { code: roomCode.toUpperCase().trim() });
    } else {
      send({ type: "join-room", roomCode: roomCode.toUpperCase().trim() });
    }
  }

  function sendOffer(targetPeerId, sdp) { send({ type: "offer", targetPeerId, sdp }); }
  function sendAnswer(targetPeerId, sdp) { send({ type: "answer", targetPeerId, sdp }); }
  function sendIceCandidate(targetPeerId, candidate) { send({ type: "ice-candidate", targetPeerId, candidate }); }

  function disconnect() {
    if (isTauri && window.__TAURI__.core) {
      window.__TAURI__.core.invoke("disconnect_all");
    } else if (ws) {
      ws.close();
      ws = null;
    }
  }

  return { connect, on, createRoom, joinRoom, sendOffer, sendAnswer, sendIceCandidate, disconnect };
})();
