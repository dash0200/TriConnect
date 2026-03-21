/* ═══════════════════════════════════════════════════════════
   app.js — Main application orchestrator
   ═══════════════════════════════════════════════════════════ */

(() => {
  // ── State ──
  let appState = "disconnected"; // disconnected | connecting | in-room | connected
  let roomCode = null;
  let myPeerId = null;
  let myDisplayName = "";
  const peerNames = {}; // peerId → display name
  
  // ── Crypto state ──
  let myKeyPair = null;
  let sharedSecrets = {}; // peerId -> sharedSecret (base64)
  const isTauri = typeof window.__TAURI__ !== "undefined";

  // ── DOM elements ──
  const landingView = document.getElementById("landing-view");
  const appView = document.getElementById("app-view");

  const btnCreate = document.getElementById("btn-create-room");
  const btnJoin = document.getElementById("btn-join-room");
  const inputRoomCode = document.getElementById("input-room-code");
  const inputServerUrl = document.getElementById("input-server-url");
  const inputDisplayName = document.getElementById("input-display-name");

  const displayRoomCode = document.getElementById("display-room-code");
  const btnCopyCode = document.getElementById("btn-copy-code");
  const btnLeave = document.getElementById("btn-leave");

  // ── Init ──
  async function init() {
    // Load environment variables if present
    if (window.APP_ENV && window.APP_ENV.SIGNALING_URL) {
      inputServerUrl.value = window.APP_ENV.SIGNALING_URL;
    }

    // Initialize crypto first
    if (isTauri) {
      try {
        myKeyPair = await window.__TAURI__.core.invoke("generate_keypair");
        console.log("[Crypto] Generated local X25519 keypair");
      } catch (err) {
        console.error("[Crypto] Failed to generate keypair:", err);
      }
    }

    // Initialize feature modules
    VoiceChat.init();
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

    // Chat sidebar toggle
    const btnToggleChat = document.getElementById("btn-toggle-chat");
    const panelChat = document.getElementById("panel-chat");
    if (btnToggleChat && panelChat) {
      btnToggleChat.addEventListener("click", () => {
        panelChat.classList.toggle("collapsed");
        const isHidden = panelChat.classList.contains("collapsed");
        Chat.setActiveTab(!isHidden);
      });
    }

    // Wire up signaling events
    setupSignalingHandlers();
    setupWebRTCHandlers();
    setupNameExchange();

    console.log("[App] TriConnect initialized");
  }

  // ── Notify ──
  function sendNotification(title, body) {
    if (!document.hasFocus() && isTauri && window.__TAURI__.notification) {
      window.__TAURI__.notification.sendNotification({ title, body });
    }
  }

  // ── Name & Key exchange over WebRTC ──
  function setupNameExchange() {

    const displayRoomCodeParent = document.getElementById("display-room-code")?.parentElement;
    if (displayRoomCodeParent) {
      displayRoomCodeParent.addEventListener("click", copyRoomCode);
      displayRoomCodeParent.style.cursor = "pointer";
      displayRoomCodeParent.title = "Click to copy room code";
    }

    // Toggle chat panel opens, announce our name and public key
    WebRTCMesh.on("channel-open", ({ peerId, channel }) => {
      if (channel === "chat") {
        const msg = JSON.stringify({
          type: "name-announce",
          name: myDisplayName,
          publicKey: myKeyPair ? myKeyPair.public_key : null,
          sender: WebRTCMesh.getMyPeerId(),
        });
        // We send this UNENCRYPTED since it's the key exchange
        WebRTCMesh.sendToPeer(peerId, "chat", msg);
      }
    });

    // Listen for name & key announcements (these are sent unencrypted)
    WebRTCMesh.on("message", async ({ peerId, channel, data }) => {
      if (channel !== "chat") return;
      
      // If it's a JSON string, try to parse it
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "name-announce") {
            // Robustly ensure this peer is in our mapping loop
            WebRTCMesh.createPeerConnection(msg.sender, false);
            
            peerNames[msg.sender] = msg.name;
            Chat.setPeerName(msg.sender, msg.name);
            updatePeerIndicators();
            
            // Derive shared secret if they sent a public key and we have our secret
            if (msg.publicKey && myKeyPair && isTauri) {
              try {
                const sharedSecret = await window.__TAURI__.core.invoke("derive_shared_secret", {
                  mySecretB64: myKeyPair.secret_key,
                  theirPublicB64: msg.publicKey
                });
                sharedSecrets[msg.sender] = sharedSecret;
                console.log(`[Crypto] Established shared secret with peer ${msg.sender}`);
                updateEncryptionBadge();
                UI.toast(`E2E Encryption enabled with ${msg.name}`, "info");
              } catch (err) {
                console.error(`[Crypto] Failed to derive shared secret:`, err);
              }
            }
          }
        } catch (e) {
          // If it fails to parse, it might be an encrypted message, handled by Chat
        }
      }
    });
  }
  
  function updateEncryptionBadge() {
    let encryptedPeers = Object.keys(sharedSecrets).length;
    let totalConnected = WebRTCMesh.getConnectedPeerIds().length;
    
    // Create badge if not exists
    let badge = document.getElementById("encryption-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "encryption-badge";
      badge.className = "room-label";
      badge.style.marginLeft = "10px";
      document.querySelector(".top-bar-left").appendChild(badge);
    }
    
    if (totalConnected === 0) {
      badge.innerHTML = "";
    } else if (encryptedPeers === totalConnected) {
      badge.innerHTML = `<span style="color:var(--text-accent)">🔒 E2E Encrypted</span>`;
    } else {
      badge.innerHTML = `<span style="color:var(--peer-2)">🔓 Unencrypted</span>`;
    }
  }
  
  // Expose shared secrets to feature modules
  window.AppCrypto = {
    getSharedSecret: (peerId) => sharedSecrets[peerId] || null,
    isTauri: () => isTauri,
    sendNotification
  };

  // ── Signaling event handlers ──
  function setupSignalingHandlers() {
    Signaling.on("room-created", (msg) => {
      roomCode = msg.roomCode;
      myPeerId = msg.peerId;
      WebRTCMesh.setMyPeerId(myPeerId);
      showApp();
      UI.toast(`Room created! Code: ${roomCode}`, "success");
      Chat.addSystemMessage(`Room ${roomCode} created. Share the code to invite others.`);
      copyRoomCode();
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
      WebRTCMesh.createPeerConnection(msg.peerId, false);
      UI.toast(`Peer ${msg.peerId} joined the room`, "info");
      Chat.addSystemMessage(`Peer ${msg.peerId} joined.`);
      updatePeerIndicators();
      updateEncryptionBadge();
      // The existing peer waits for the offer from the joiner natively in Rust
    });

    Signaling.on("peer-left", (msg) => {
      UI.toast(`Peer ${msg.peerId} left the room`, "warning");
      Chat.addSystemMessage(`Peer ${msg.peerId} left.`);
      WebRTCMesh.removePeer(msg.peerId);
      delete sharedSecrets[msg.peerId];
      updatePeerIndicators();
      updateEncryptionBadge();
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
    const name = inputDisplayName.value.trim();
    if (!name) {
      UI.showStatus("landing-status", "Please enter your name first", "error");
      inputDisplayName.focus();
      return;
    }
    myDisplayName = name;

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
      const errMsg = err.message || (typeof err === "string" ? err : "Connection failed");
      UI.showStatus("landing-status", errMsg, "error");
      setState("disconnected");
      enableLandingButtons(true);
    }
  }

  async function joinRoom() {
    const name = inputDisplayName.value.trim();
    if (!name) {
      UI.showStatus("landing-status", "Please enter your name first", "error");
      inputDisplayName.focus();
      return;
    }
    myDisplayName = name;

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
      const errMsg = err.message || (typeof err === "string" ? err : "Connection failed");
      UI.showStatus("landing-status", errMsg, "error");
      setState("disconnected");
      enableLandingButtons(true);
    }
  }

  function leaveRoom() {
    WebRTCMesh.disconnectAll();
    Signaling.disconnect();
    sharedSecrets = {};
    updateEncryptionBadge();
    setState("disconnected");
    roomCode = null;
    myPeerId = null;
    showLanding();
    UI.hideStatus("landing-status");
    enableLandingButtons(true);
  }

  async function copyRoomCode() {
    if (!roomCode) return;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(roomCode);
      } else {
        // Fallback
        const input = document.createElement("input");
        input.value = roomCode;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      UI.toast(`Room code ${roomCode} copied to clipboard!`, "info");
    } catch (err) {
      console.warn("Clipboard auto-copy failed", err);
    }
  }

  // ── View management ──
  function showApp() {
    landingView.classList.remove("active");
    appView.classList.add("active");
    displayRoomCode.textContent = roomCode;
    updatePeerIndicators();
    updateEncryptionBadge();
    setState("in-room");
  }

  function showLanding() {
    appView.classList.remove("active");
    landingView.classList.add("active");
  }

  // ── Peer indicators ──
  function updatePeerIndicators() {
    const connectedPeers = WebRTCMesh.getConnectedPeerIds();

    const getIcon = (id) => (id === 0 || id === 1) ? "💖" : "🤡";
    const getName = (id, isSelf) => {
      const name = isSelf ? myDisplayName : (peerNames[id] || null);
      const role = (id === 0 || id === 1) ? "Partner" : "3rd Wheel";
      if (name) return `${name} (${role})`;
      return isSelf ? `You (${role})` : role;
    };

    // Reset all
    for (let i = 0; i < 3; i++) {
      const dot = document.getElementById(`peer-dot-${i}`);
      if (!dot) continue;
      dot.className = "peer-dot";
      dot.innerHTML = `<span class="peer-label">—</span>`;
      dot.title = `Slot ${i}`;
    }

    // Mark self
    if (myPeerId != null) {
      const selfDot = document.getElementById(`peer-dot-${myPeerId}`);
      if (selfDot) {
        selfDot.classList.add("self");
        if (myPeerId === 2) selfDot.classList.add("third-wheeler");
        selfDot.innerHTML = `${getIcon(myPeerId)}<span class="peer-label">${getName(myPeerId, true)}</span>`;
        selfDot.title = getName(myPeerId, true);
      }
    }

    // Mark connected peers
    for (const peerId of connectedPeers) {
      const dot = document.getElementById(`peer-dot-${peerId}`);
      if (dot) {
        dot.classList.add("connected");
        if (peerId === 2) dot.classList.add("third-wheeler");
        
        let latencyHtml = "";
        if (window.Network) {
          const lat = window.Network.getLatency(peerId);
          if (lat !== null) {
            const quality = lat < 100 ? "excellent" : (lat < 300 ? "fair" : "poor");
            latencyHtml = `
              <div class="network-badge" title="Round-Trip Ping">
                <span class="network-dot ${quality}"></span>
                <span>${lat}ms</span>
              </div>
            `;
          }
        }
        
        dot.innerHTML = `${getIcon(peerId)}${latencyHtml}<span class="peer-label">${getName(peerId, false)}</span>`;
        dot.title = getName(peerId, false);
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
  window.updatePeerIndicators = updatePeerIndicators;
  init();
})();
