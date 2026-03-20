const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// In-memory room storage: Map<roomCode, { peers: Map<peerId, ws>, nextId: number }>
const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function broadcastToRoom(roomCode, message, excludePeerId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const [peerId, ws] of room.peers) {
    if (peerId !== excludePeerId && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function sendTo(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function cleanupPeer(ws) {
  const { roomCode, peerId } = ws;
  if (roomCode == null || peerId == null) return;

  const room = rooms.get(roomCode);
  if (!room) return;

  room.peers.delete(peerId);
  console.log(`[Room ${roomCode}] Peer ${peerId} left. ${room.peers.size} peers remaining.`);

  broadcastToRoom(roomCode, { type: "peer-left", peerId });

  if (room.peers.size === 0) {
    rooms.delete(roomCode);
    console.log(`[Room ${roomCode}] Room destroyed (empty).`);
  }
}

wss.on("connection", (ws) => {
  console.log("New connection");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendTo(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "create-room": {
        let roomCode = generateRoomCode();
        while (rooms.has(roomCode)) roomCode = generateRoomCode();

        const peerId = 0;
        const room = { peers: new Map(), nextId: 1 };
        room.peers.set(peerId, ws);
        rooms.set(roomCode, room);

        ws.roomCode = roomCode;
        ws.peerId = peerId;

        console.log(`[Room ${roomCode}] Created by peer ${peerId}`);
        sendTo(ws, {
          type: "room-created",
          roomCode,
          peerId,
        });
        break;
      }

      case "join-room": {
        const { roomCode } = msg;
        const room = rooms.get(roomCode);

        if (!room) {
          sendTo(ws, { type: "error", message: "Room not found" });
          return;
        }

        if (room.peers.size >= 3) {
          sendTo(ws, { type: "error", message: "Room is full (max 3 users)" });
          return;
        }

        const peerId = room.nextId++;
        room.peers.set(peerId, ws);

        ws.roomCode = roomCode;
        ws.peerId = peerId;

        console.log(`[Room ${roomCode}] Peer ${peerId} joined. ${room.peers.size}/3 peers.`);

        // Tell existing peers about the new peer
        const existingPeerIds = [];
        for (const [id] of room.peers) {
          if (id !== peerId) existingPeerIds.push(id);
        }

        // Inform the joiner about existing peers
        sendTo(ws, {
          type: "room-joined",
          roomCode,
          peerId,
          existingPeers: existingPeerIds,
        });

        // Inform existing peers
        broadcastToRoom(roomCode, { type: "peer-joined", peerId }, peerId);
        break;
      }

      case "offer":
      case "answer":
      case "ice-candidate": {
        const { targetPeerId } = msg;
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        const targetWs = room.peers.get(targetPeerId);
        if (!targetWs) return;

        sendTo(targetWs, {
          ...msg,
          fromPeerId: ws.peerId,
        });
        break;
      }

      default:
        sendTo(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    console.log("Connection closed");
    cleanupPeer(ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    cleanupPeer(ws);
  });
});

console.log(`TriConnect signaling server running on port ${PORT}`);
