/* ═══════════════════════════════════════════════════════════
   chat.js — Chat feature over WebRTC DataChannel
   ═══════════════════════════════════════════════════════════ */

window.Chat = (() => {
  const CHANNEL = "chat";
  const PEER_COLORS = ["var(--peer-0)", "var(--peer-1)", "var(--peer-2)"];
  const peerNames = { 0: "You", 1: "Peer 1", 2: "Peer 2" };

  let messagesContainer = null;
  let logsContainer = null;
  let inputField = null;
  let isActiveTab = true;
  let unreadCount = 0;
  const latencies = {}; // peerId -> ms

  window.Network = {
    getLatency: (id) => latencies[id] || null
  };

  function init() {
    messagesContainer = document.getElementById("chat-messages");
    logsContainer = document.getElementById("log-messages");
    inputField = document.getElementById("chat-input");

    const tabChat = document.getElementById("tab-btn-chat");
    const tabLogs = document.getElementById("tab-btn-logs");

    if (tabChat && tabLogs) {
      tabChat.addEventListener("click", () => {
        tabChat.style.background = "var(--bg-surface)";
        tabLogs.style.background = "transparent";
        messagesContainer.style.display = "flex";
        logsContainer.style.display = "none";
      });
      tabLogs.addEventListener("click", () => {
        tabLogs.style.background = "var(--bg-surface)";
        tabChat.style.background = "transparent";
        logsContainer.style.display = "flex";
        messagesContainer.style.display = "none";
      });
    }

    document.getElementById("btn-send-chat").addEventListener("click", sendMessage);
    inputField.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Listen for image pastes
    inputField.addEventListener("paste", async (e) => {
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      for (const item of items) {
        if (item.type.indexOf("image/") === 0) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          
          if (typeof window.__TAURI__ === "undefined") {
            if (window.UI) window.UI.toast("Image pasting requires the desktop app", "warning");
            continue;
          }
          
          try {
            if (window.UI) window.UI.toast("Processing pasted image...", "info");
            const buffer = await file.arrayBuffer();
            const uint8 = new Uint8Array(buffer);
            const ext = file.type.split("/")[1] || "png";
            const filename = `paste_${Date.now()}.${ext}`;
            
            const path = await window.__TAURI__.core.invoke("save_pasted_file", {
              data: Array.from(uint8),
              filename: filename
            });
            
            if (window.FileTransfer && window.FileTransfer.sendFile) {
              window.FileTransfer.sendFile(path);
            }
          } catch(err) {
            console.error("Paste error:", err);
            if (window.UI) window.UI.toast("Failed to paste image", "error");
          }
        }
      }
    });

    // Start latency ping loop
    setInterval(() => {
      const peers = WebRTCMesh.getConnectedPeerIds();
      if (peers.length === 0) return;
      const ts = Date.now();
      const pingMsg = JSON.stringify({ type: "ping", ts, sender: WebRTCMesh.getMyPeerId() });
      for (const peerId of peers) {
        if (WebRTCMesh.isChannelOpen(peerId, CHANNEL)) {
          WebRTCMesh.sendToPeer(peerId, CHANNEL, pingMsg);
        }
      }
    }, 3000);

    // Listen for incoming chat messages
    WebRTCMesh.on("message", async ({ peerId, channel, data }) => {
      if (channel !== CHANNEL) return;
      
      let msgText = null;
      let msg = null;

      // Handle binary encrypted data
      if (data instanceof ArrayBuffer) {
        const secret = window.AppCrypto.getSharedSecret(peerId);
        if (secret) {
          try {
            // Need to convert ArrayBuffer to Array for rust vec
            const ciphertext = Array.from(new Uint8Array(data));
            const plaintext = await window.__TAURI__.core.invoke("decrypt", {
              sharedSecretB64: secret,
              ciphertext: ciphertext
            });
            msgText = new TextDecoder().decode(new Uint8Array(plaintext));
          } catch (err) {
            console.error("[Chat] Failed to decrypt message:", err);
            return;
          }
        } else {
          console.warn("[Chat] Received encrypted message but no shared secret");
          return;
        }
      } else if (typeof data === "string") {
        msgText = data;
      }

      if (msgText) {
        try {
          msg = JSON.parse(msgText);
          
          if (msg.type === "ping") {
            const pongMsg = JSON.stringify({ type: "pong", ts: msg.ts, sender: WebRTCMesh.getMyPeerId() });
            WebRTCMesh.sendToPeer(msg.sender, CHANNEL, pongMsg);
            return;
          } else if (msg.type === "pong") {
            const rtt = Date.now() - msg.ts;
            // Simple exponential moving average for smooth UI
            latencies[msg.sender] = latencies[msg.sender] ? Math.floor(latencies[msg.sender] * 0.7 + rtt * 0.3) : rtt;
            if (window.updatePeerIndicators) window.updatePeerIndicators();
            return;
          } else if (msg.type === "chat-message") {
            addMessage(msg.sender, msg.message, msg.timestamp, false);
            // Send system notification
            if (window.AppCrypto.sendNotification) {
              const senderName = peerNames[msg.sender] || `Peer ${msg.sender}`;
              window.AppCrypto.sendNotification(`New message from ${senderName}`, msg.message);
            }
          }
        } catch (err) {
          // Might be unecrypted key-exchange format handled by app.js
        }
      }
    });
  }

  async function sendMessage() {
    const text = inputField.value.trim();
    if (!text) return;

    const msgObj = {
      type: "chat-message",
      sender: WebRTCMesh.getMyPeerId(),
      message: text,
      timestamp: Date.now(),
    };

    const msgStr = JSON.stringify(msgObj);
    const msgBytes = new TextEncoder().encode(msgStr);
    
    // Broadcast to all peers
    const connectedPeers = WebRTCMesh.getConnectedPeerIds();
    for (const peerId of connectedPeers) {
      const secret = window.AppCrypto.getSharedSecret(peerId);
      if (secret && window.AppCrypto.isTauri()) {
        try {
          // Encrypt
          const plaintext = Array.from(msgBytes);
          const ciphertextVec = await window.__TAURI__.core.invoke("encrypt", {
            sharedSecretB64: secret,
            plaintext: plaintext
          });
          const ciphertextBuffer = new Uint8Array(ciphertextVec).buffer;
          WebRTCMesh.sendToPeer(peerId, CHANNEL, ciphertextBuffer);
        } catch (err) {
          console.error(`[Chat] Failed to encrypt for peer ${peerId}:`, err);
        }
      } else {
        // Fallback to unencrypted string
        WebRTCMesh.sendToPeer(peerId, CHANNEL, msgStr);
      }
    }

    addMessage(msgObj.sender, msgObj.message, msgObj.timestamp, true);
    inputField.value = "";
    inputField.focus();
  }

  function addMessage(senderId, text, timestamp, isSelf) {
    // Remove empty state
    const emptyEl = messagesContainer.querySelector(".chat-empty");
    if (emptyEl) emptyEl.remove();

    const el = document.createElement("div");
    el.className = `chat-msg ${isSelf ? "self" : "peer"}`;

    const peerIndex = senderId;
    const senderName = isSelf ? "You" : (peerNames[peerIndex] || `Peer ${peerIndex}`);
    const senderColor = PEER_COLORS[peerIndex] || "var(--text-secondary)";
    const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    el.innerHTML = `
      <span class="msg-sender" style="color: ${senderColor}">${senderName}</span>
      <div class="msg-bubble">${escapeHtml(text)}</div>
      <span class="msg-time">${timeStr}</span>
    `;

    messagesContainer.appendChild(el);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // Badge for unread
    if (!isSelf && !isActiveTab) {
      unreadCount++;
      updateBadge();
    }
  }

  function addSystemMessage(text) {
    if (!logsContainer) return;
    const emptyEl = logsContainer.querySelector(".chat-empty");
    if (emptyEl) emptyEl.remove();

    const el = document.createElement("div");
    el.className = "chat-system-msg";
    el.textContent = text;
    logsContainer.appendChild(el);
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }

  function setActiveTab(active) {
    isActiveTab = active;
    if (active) {
      unreadCount = 0;
      updateBadge();
    }
  }

  function updateBadge() {
    const badge = document.getElementById("chat-badge");
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 99 ? "99+" : unreadCount;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function setPeerName(peerId, name) {
    peerNames[peerId] = name;
  }

  return { init, addSystemMessage, setActiveTab, setPeerName };
})();
