/* ═══════════════════════════════════════════════════════════
   app.js — Main application orchestrator
   ═══════════════════════════════════════════════════════════ */

(() => {
  // ── State ──
  let appState = "disconnected"; // disconnected | connecting | in-room | connected
  let roomCode = null;
  let myPeerId = null;

  // ── DOM elements ──
  const landingView = document.getElementById("landing-view");
  const appView = document.getElementById("app-view");

  const btnCreate = document.getElementById("btn-create-room");
  const btnJoin = document.getElementById("btn-join-room");
  const inputRoomCode = document.getElementById("input-room-code");
  const inputServerUrl = document.getElementById("input-server-url");

  const displayRoomCode = document.getElementById("display-room-code");
  const btnCopyCode = document.getElementById("btn-copy-code");
  const btnLeave = document.getElementById("btn-leave");

  // ── Init ──
  function init() {
    // Initialize feature modules
    Chat.init();
    FileTransfer.init();
    VideoSync.init();

    // Landing events
    btnCreate.addEventListener("click", createRoom);
    btnJoin.addEventListener("click", joinRoom);
    inputRoomCode.addEventListener("keydown", (e) => {
      if (e.key === "Enter") joinRoom();
    });

    // App events
    btnCopyCode.addEventListener("click", copyRoomCode);
    btnLeave.addEventListener("click", leaveRoom);

    // Tab switching
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });

    // Wire up signaling events
    setupSignalingHandlers();
    setupWebRTCHandlers();

    console.log("[App] TriConnect initialized");
  }

  // ── Signaling event handlers ──
  function setupSignalingHandlers() {
    Signaling.on("room-created", (msg) => {
      roomCode = msg.roomCode;
      myPeerId = msg.peerId;
      WebRTCMesh.setMyPeerId(myPeerId);
      showApp();
      UI.toast(`Room created! Code: ${roomCode}`, "success");
      Chat.addSystemMessage(`Room ${roomCode} created. Share the code to invite others.`);
    });

    Signaling.on("room-joined", (msg) => {
      roomCode = msg.roomCode;
      myPeerId = msg.peerId;
      WebRTCMesh.setMyPeerId(myPeerId);
      showApp();
      UI.toast(`Joined room ${roomCode}`, "success");
      Chat.addSystemMessage(`You joined room ${roomCode}.`);

      // Connect to existing peers
      for (const existingPeerId of msg.existingPeers) {
        // The joiner creates the offer to existing peers
        WebRTCMesh.createPeerConnection(existingPeerId, true);
        WebRTCMesh.createOffer(existingPeerId);
      }
    });

    Signaling.on("peer-joined", (msg) => {
      UI.toast(`Peer ${msg.peerId} joined the room`, "info");
      Chat.addSystemMessage(`Peer ${msg.peerId} joined.`);
      updatePeerIndicators();
      // The existing peer waits for the offer from the joiner
    });

    Signaling.on("peer-left", (msg) => {
      UI.toast(`Peer ${msg.peerId} left the room`, "warning");
      Chat.addSystemMessage(`Peer ${msg.peerId} left.`);
      WebRTCMesh.removePeer(msg.peerId);
      updatePeerIndicators();
    });

    Signaling.on("error", (msg) => {
      UI.showStatus("landing-status", msg.message, "error");
      UI.toast(msg.message, "error");
      if (appState === "connecting") {
        setState("disconnected");
        enableLandingButtons(true);
      }
    });

    Signaling.on("disconnected", () => {
      if (appState !== "disconnected") {
        UI.toast("Disconnected from signaling server", "error");
        leaveRoom();
      }
    });
  }

  // ── WebRTC event handlers ──
  function setupWebRTCHandlers() {
    WebRTCMesh.on("peer-connected", ({ peerId }) => {
      console.log(`[App] Peer ${peerId} connected!`);
      updatePeerIndicators();
      setState("connected");
    });

    WebRTCMesh.on("peer-disconnected", ({ peerId }) => {
      console.log(`[App] Peer ${peerId} disconnected`);
      updatePeerIndicators();
    });

    WebRTCMesh.on("channel-open", ({ peerId, channel }) => {
      console.log(`[App] Channel "${channel}" open with peer ${peerId}`);
      updatePeerIndicators();
    });
  }

  // ── Room actions ──
  async function createRoom() {
    const serverUrl = inputServerUrl.value.trim();
    if (!serverUrl) {
      UI.showStatus("landing-status", "Please enter a server URL", "error");
      return;
    }

    enableLandingButtons(false);
    setState("connecting");
    UI.showStatus("landing-status", "Connecting to server...", "info");

    try {
      await Signaling.connect(serverUrl);
      Signaling.createRoom();
    } catch (err) {
      UI.showStatus("landing-status", err.message, "error");
      setState("disconnected");
      enableLandingButtons(true);
    }
  }

  async function joinRoom() {
    const serverUrl = inputServerUrl.value.trim();
    const code = inputRoomCode.value.trim().toUpperCase();

    if (!serverUrl) {
      UI.showStatus("landing-status", "Please enter a server URL", "error");
      return;
    }
    if (!code || code.length < 4) {
      UI.showStatus("landing-status", "Please enter a valid room code", "error");
      return;
    }

    enableLandingButtons(false);
    setState("connecting");
    UI.showStatus("landing-status", "Connecting to server...", "info");

    try {
      await Signaling.connect(serverUrl);
      Signaling.joinRoom(code);
    } catch (err) {
      UI.showStatus("landing-status", err.message, "error");
      setState("disconnected");
      enableLandingButtons(true);
    }
  }

  function leaveRoom() {
    WebRTCMesh.disconnectAll();
    Signaling.disconnect();
    setState("disconnected");
    roomCode = null;
    myPeerId = null;
    showLanding();
    UI.hideStatus("landing-status");
    enableLandingButtons(true);
  }

  function copyRoomCode() {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode).then(() => {
      UI.toast("Room code copied!", "success");
    }).catch(() => {
      // Fallback
      const input = document.createElement("input");
      input.value = roomCode;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      UI.toast("Room code copied!", "success");
    });
  }

  // ── View management ──
  function showApp() {
    landingView.classList.remove("active");
    appView.classList.add("active");
    displayRoomCode.textContent = roomCode;
    updatePeerIndicators();
    setState("in-room");
  }

  function showLanding() {
    appView.classList.remove("active");
    landingView.classList.add("active");
  }

  // ── Tab management ──
  function switchTab(tabName) {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === tabName);
    });
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.toggle("active", p.id === `panel-${tabName}`);
    });

    // Notify chat module
    Chat.setActiveTab(tabName === "chat");
  }

  // ── Peer indicators ──
  function updatePeerIndicators() {
    const connectedPeers = WebRTCMesh.getConnectedPeerIds();

    // Reset all
    for (let i = 0; i < 3; i++) {
      const dot = document.getElementById(`peer-dot-${i}`);
      if (!dot) continue;
      dot.className = "peer-dot";
      dot.querySelector(".peer-label").textContent = "—";
    }

    // Mark self
    if (myPeerId != null) {
      const selfDot = document.getElementById(`peer-dot-${myPeerId}`);
      if (selfDot) {
        selfDot.classList.add("self");
        selfDot.querySelector(".peer-label").textContent = "You";
      }
    }

    // Mark connected peers
    for (const peerId of connectedPeers) {
      const dot = document.getElementById(`peer-dot-${peerId}`);
      if (dot) {
        dot.classList.add("connected");
        dot.querySelector(".peer-label").textContent = `P${peerId}`;
      }
    }

    // Update connectors
    const conn01 = document.getElementById("conn-0-1");
    const conn02 = document.getElementById("conn-0-2");
    if (conn01) conn01.classList.toggle("active", connectedPeers.length >= 1);
    if (conn02) conn02.classList.toggle("active", connectedPeers.length >= 2);
  }

  // ── Helpers ──
  function setState(state) {
    appState = state;
    console.log(`[App] State: ${state}`);
  }

  function enableLandingButtons(enabled) {
    btnCreate.disabled = !enabled;
    btnJoin.disabled = !enabled;
    inputRoomCode.disabled = !enabled;
  }

  // ── Bootstrap ──
  init();
})();
