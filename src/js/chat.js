/* ═══════════════════════════════════════════════════════════
   chat.js — Chat feature over WebRTC DataChannel
   ═══════════════════════════════════════════════════════════ */

window.Chat = (() => {
  const CHANNEL = "chat";
  const PEER_COLORS = ["var(--peer-0)", "var(--peer-1)", "var(--peer-2)"];
  const PEER_NAMES = ["You", "Peer 1", "Peer 2"];

  let messagesContainer = null;
  let inputField = null;
  let isActiveTab = true;
  let unreadCount = 0;

  function init() {
    messagesContainer = document.getElementById("chat-messages");
    inputField = document.getElementById("chat-input");

    document.getElementById("btn-send-chat").addEventListener("click", sendMessage);
    inputField.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Listen for incoming chat messages
    WebRTCMesh.on("message", ({ peerId, channel, data }) => {
      if (channel !== CHANNEL) return;
      try {
        const msg = JSON.parse(data);
        if (msg.type === "chat-message") {
          addMessage(msg.sender, msg.message, msg.timestamp, false);
        }
      } catch (err) {
        console.warn("[Chat] Invalid message data:", err);
      }
    });
  }

  function sendMessage() {
    const text = inputField.value.trim();
    if (!text) return;

    const msg = {
      type: "chat-message",
      sender: WebRTCMesh.getMyPeerId(),
      message: text,
      timestamp: Date.now(),
    };

    WebRTCMesh.broadcast(CHANNEL, JSON.stringify(msg));
    addMessage(msg.sender, msg.message, msg.timestamp, true);
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
    const senderName = isSelf ? "You" : (PEER_NAMES[peerIndex] || `Peer ${peerIndex}`);
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
    const emptyEl = messagesContainer.querySelector(".chat-empty");
    if (emptyEl) emptyEl.remove();

    const el = document.createElement("div");
    el.className = "chat-system-msg";
    el.textContent = text;
    messagesContainer.appendChild(el);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
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

  return { init, addSystemMessage, setActiveTab };
})();
