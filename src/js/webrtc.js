/* ═══════════════════════════════════════════════════════════
   webrtc.js — P2P Mesh Network layer
   ═══════════════════════════════════════════════════════════ */

window.WebRTCMesh = (() => {
  const isTauri = typeof window.__TAURI__ !== "undefined";
  
  // Local active Web browser peers fallback (if not Tauri)
  const peers = new Map(); // remotePeerId -> { pc, channels: Map }
  const handlers = {}; // type -> [callback]
  let myPeerId = null;

  const CHANNELS = ["chat", "file-transfer", "video-sync"];
  const RENDER_ICE = [
    { urls: "stun:stun.l.google.com:19302" },
  ];
  
  // If we are in Tauri, we listen to rust events once
  let rustEventsBound = false;

  function on(type, callback) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(callback);
    
    // Bind Rust IPC listeners on the first call to map Native streams to JS callbacks
    if (isTauri && window.__TAURI__.event && !rustEventsBound) {
      rustEventsBound = true;
      console.log("[WebRTCMesh] Binding Native Rust IPC DataChannel events");
      
      const listen = window.__TAURI__.event.listen;
      
      listen("channel-open", (event) => {
        const p = event.payload;
        const pid = p.peerId ?? p.peer_id;
        // Block zombie channel-open events from resurrecting a peer that already disconnected!
        if (!peers.has(pid)) return; 
        peers.get(pid).channels.set(p.channel, "open");
        
        emit("channel-open", { peerId: pid, channel: p.channel });
      });
      
      listen("channel-message", (event) => {
        const p = event.payload;
        const pid = p.peerId ?? p.peer_id;
        let formattedData = p.data;
        if (Array.isArray(p.data)) {
           formattedData = new Uint8Array(p.data).buffer;
        }
        emit("message", { peerId: pid, channel: p.channel, data: formattedData });
      });
      
      listen("peer-state", (event) => {
        const p = event.payload;
        const pid = p.peerId ?? p.peer_id;
        if (p.state === "connected") emit("peer-connected", { peerId: pid });
        if (p.state === "disconnected" || p.state === "failed" || p.state === "closed" || p.state === "Closed") {
          emit("peer-disconnected", { peerId: pid });
        }
      });
    }
  }

  function emit(type, data) {
    (handlers[type] || []).forEach((cb) => cb(data));
  }

  function setMyPeerId(id) {
    myPeerId = id;
  }
  function getMyPeerId() {
    return myPeerId;
  }

  function getConnectedPeerIds() {
    if (isTauri) {
      // For Tauri, since we rely on the internal Rust state, we don't have a direct query for `getConnectedPeerIds` 
      // without asking Rust, but for simplicity, we can just track connection states via the events above if we needed to,
      // OR we just assume any peer announced via "Signaling: peer-joined" has a connection attempt pending.
      // We will track them locally in `peers` map JUST for the IDs.
      return Array.from(peers.keys());
    }
    
    let connected = [];
    for (const [id, peer] of peers) {
      if (peer.pc.iceConnectionState === "connected" || peer.pc.iceConnectionState === "completed") {
        connected.push(id);
      }
    }
    return connected;
  }

  // ── Browser Fallback Implementations ──
  
  function createPeerConnection(remotePeerId, isInitiator) {
    if (isTauri) {
      if (!peers.has(remotePeerId)) {
        peers.set(remotePeerId, { pc: null, channels: new Map() });
      }
      // If it already exists natively in rust, we skip overwriting
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: RENDER_ICE });

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] Peer ${remotePeerId} ICE state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "connected") emit("peer-connected", { peerId: remotePeerId });
      if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
        emit("peer-disconnected", { peerId: remotePeerId });
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        Signaling.sendIceCandidate(remotePeerId, event.candidate);
      }
    };

    const channels = new Map();
    peers.set(remotePeerId, { pc, channels });

    if (isInitiator) {
      for (const name of CHANNELS) {
        const ch = pc.createDataChannel(name, {
          ordered: name === "chat" || name === "video-sync",
          maxRetransmits: name === "file-transfer" ? 10 : undefined,
        });
        setupChannel(ch, remotePeerId, name);
        channels.set(name, ch);
      }
    } else {
      pc.ondatachannel = (event) => {
        const ch = event.channel;
        setupChannel(ch, remotePeerId, ch.label);
        channels.set(ch.label, ch);
      };
    }
  }

  function setupChannel(channel, remotePeerId, name) {
    channel.onopen = () => {
      emit("channel-open", { peerId: remotePeerId, channel: name });
    };

    channel.onmessage = (event) => {
      emit("message", { peerId: remotePeerId, channel: name, data: event.data });
    };

    if (name === "file-transfer" || name === "chat") {
      channel.binaryType = "arraybuffer";
    }
  }

  async function createOffer(remotePeerId) {
    if (isTauri) return; // Rust does this
    const peer = peers.get(remotePeerId);
    if (!peer) return;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      Signaling.sendOffer(remotePeerId, offer);
    } catch (err) {
      console.error("Create offer error", err);
    }
  }

  async function handleOffer(remotePeerId, offer) {
    if (isTauri) return; // Rust does this
    const peer = peers.get(remotePeerId);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(offer);
    } catch (err) {
      console.error("Handle offer error", err);
    }
  }

  async function createAnswer(remotePeerId) {
    if (isTauri) return; // Rust does this
    const peer = peers.get(remotePeerId);
    if (!peer) return;
    try {
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      return answer;
    } catch (err) {
      console.error("Create answer error", err);
    }
  }

  async function handleAnswer(remotePeerId, answer) {
    if (isTauri) return; // Rust does this
    const peer = peers.get(remotePeerId);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(answer);
    } catch (err) {
      console.error("Handle answer error", err);
    }
  }

  async function handleIceCandidate(remotePeerId, candidate) {
    if (isTauri) return; // Rust does this
    const peer = peers.get(remotePeerId);
    if (!peer) return;
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      console.error("Add ICE candidate error", err);
    }
  }

  // ── Unified Sending ──

  function sendToPeer(remotePeerId, channelName, data) {
    if (isTauri && window.__TAURI__.core) {
      let isBinary = false;
      let rustData = data;
      
      if (data instanceof ArrayBuffer) {
        isBinary = true;
        rustData = Array.from(new Uint8Array(data));
      } else if (typeof data === "string") {
        isBinary = false;
        rustData = Array.from(new TextEncoder().encode(data));
      }
      
      console.log(`[WebRTCMesh] SENDING IPC. peerId: ${remotePeerId} (type: ${typeof remotePeerId}), channel: ${channelName}`);
      window.__TAURI__.core.invoke("send_message", {
        payload: {
          peerId: remotePeerId,
          channel: channelName,
          isBinary: isBinary,
          data: rustData
        }
      }).catch(err => console.error(`[WebRTCMesh] IPC Send failed for peer ${remotePeerId}:`, err));
      return true;
    }
    
    const peer = peers.get(remotePeerId);
    if (!peer) return false;
    const ch = peer.channels.get(channelName);
    if (!ch || ch.readyState !== "open") return false;
    ch.send(data);
    return true;
  }

  function broadcast(channelName, data) {
    // Rely on locally tracked IDs to broadcast
    for (const peerId of peers.keys()) {
      sendToPeer(peerId, channelName, data);
    }
  }

  function getChannel(remotePeerId, channelName) {
    if (isTauri) {
       // Return a dummy object so file-transfer.js backpressure loop doesn't crash 
       // (Rust backend backpressure can be added later)
       return { bufferedAmount: 0, send: (d) => sendToPeer(remotePeerId, channelName, d) };
    }
    const peer = peers.get(remotePeerId);
    if (!peer) return null;
    return peer.channels.get(channelName);
  }

  function isChannelOpen(remotePeerId, channelName) {
    const p = peers.get(remotePeerId);
    if (!p) return false;
    if (isTauri) {
      if (!p.channels) return false;
      return p.channels.get(channelName) === "open";
    } else {
      const ch = p.channels.get(channelName);
      return ch && ch.readyState === "open";
    }
  }

  function removePeer(remotePeerId) {
    if (!isTauri) {
      const peer = peers.get(remotePeerId);
      if (peer && peer.pc) peer.pc.close();
    }
    peers.delete(remotePeerId);
  }

  function disconnectAll() {
    if (!isTauri) {
      for (const [id, peer] of peers) {
        if (peer.pc) peer.pc.close();
      }
    }
    peers.clear();
  }

  return {
    on,
    setMyPeerId,
    getMyPeerId,
    createPeerConnection,
    createOffer,
    handleOffer,
    createAnswer,
    handleAnswer,
    handleIceCandidate,
    sendToPeer,
    broadcast,
    getChannel,
    isChannelOpen,
    removePeer,
    disconnectAll,
    getConnectedPeerIds,
  };
})();
