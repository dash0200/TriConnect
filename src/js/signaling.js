/* ═══════════════════════════════════════════════════════════
   signaling.js — WebSocket client for the signaling server
   ═══════════════════════════════════════════════════════════ */

window.Signaling = (() => {
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

  function connect(url) {
    return new Promise((resolve, reject) => {
      serverUrl = url;
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      console.warn("[Signaling] Cannot send — not connected");
    }
  }

  function createRoom() {
    send({ type: "create-room" });
  }

  function joinRoom(roomCode) {
    send({ type: "join-room", roomCode: roomCode.toUpperCase().trim() });
  }

  function sendOffer(targetPeerId, sdp) {
    send({ type: "offer", targetPeerId, sdp });
  }

  function sendAnswer(targetPeerId, sdp) {
    send({ type: "answer", targetPeerId, sdp });
  }

  function sendIceCandidate(targetPeerId, candidate) {
    send({ type: "ice-candidate", targetPeerId, candidate });
  }

  function disconnect() {
    if (ws) {
      ws.close();
      ws = null;
    }
  }

  return { connect, on, createRoom, joinRoom, sendOffer, sendAnswer, sendIceCandidate, disconnect };
})();
