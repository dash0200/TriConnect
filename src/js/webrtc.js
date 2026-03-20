/* ═══════════════════════════════════════════════════════════
   webrtc.js — WebRTC mesh manager (up to 2 peer connections)
   ═══════════════════════════════════════════════════════════ */

window.WebRTCMesh = (() => {
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  // Channel names used by features
  const CHANNELS = ["chat", "file-transfer", "video-sync"];

  // peer connections: Map<peerId, { pc, channels: Map<name, RTCDataChannel> }>
  const peers = new Map();
  let myPeerId = null;

  const handlers = {};

  function on(event, callback) {
    if (!handlers[event]) handlers[event] = [];
    handlers[event].push(callback);
  }

  function emit(event, data) {
    (handlers[event] || []).forEach((cb) => cb(data));
  }

  function setMyPeerId(id) {
    myPeerId = id;
  }

  function getMyPeerId() {
    return myPeerId;
  }

  function createPeerConnection(remotePeerId, isInitiator) {
    console.log(`[WebRTC] Creating connection to peer ${remotePeerId} (initiator: ${isInitiator})`);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channels = new Map();

    // Add local voice track if available
    if (window.VoiceChat) {
      const stream = VoiceChat.getStream();
      if (stream) {
        stream.getTracks().forEach(track => {
          pc.addTrack(track, stream);
        });
      }
    }

    const peerData = { pc, channels, remotePeerId, isInitiator };
    peers.set(remotePeerId, peerData);

    // Incoming track handling
    pc.ontrack = (event) => {
      if (window.VoiceChat) {
        VoiceChat.handleIncomingTrack(remotePeerId, event);
      }
    };

    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        Signaling.sendIceCandidate(remotePeerId, event.candidate);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE state with peer ${remotePeerId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        emit("peer-connected", { peerId: remotePeerId });
      } else if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
        emit("peer-disconnected", { peerId: remotePeerId });
      }
    };

    // If we're the initiator, create data channels
    if (isInitiator) {
      for (const name of CHANNELS) {
        const ch = pc.createDataChannel(name, {
          ordered: name === "chat" || name === "video-sync",
          maxRetransmits: name === "file-transfer" ? 10 : undefined,
        });
        setupChannel(ch, remotePeerId, name);
        channels.set(name, ch);
      }
    }

    // Handle incoming data channels (non-initiator side)
    pc.ondatachannel = (event) => {
      const ch = event.channel;
      console.log(`[WebRTC] Received data channel "${ch.label}" from peer ${remotePeerId}`);
      setupChannel(ch, remotePeerId, ch.label);
      channels.set(ch.label, ch);
    };

    return peerData;
  }

  function setupChannel(channel, remotePeerId, name) {
    channel.onopen = () => {
      console.log(`[WebRTC] Channel "${name}" open with peer ${remotePeerId}`);
      emit("channel-open", { peerId: remotePeerId, channel: name });
    };

    channel.onclose = () => {
      console.log(`[WebRTC] Channel "${name}" closed with peer ${remotePeerId}`);
      emit("channel-close", { peerId: remotePeerId, channel: name });
    };

    channel.onerror = (err) => {
      console.error(`[WebRTC] Channel "${name}" error with peer ${remotePeerId}:`, err);
    };

    channel.onmessage = (event) => {
      emit("message", { peerId: remotePeerId, channel: name, data: event.data });
    };

    // For file-transfer channel, use arraybuffer
    if (name === "file-transfer") {
      channel.binaryType = "arraybuffer";
    }
  }

  async function createOffer(remotePeerId) {
    const peer = peers.get(remotePeerId);
    if (!peer) return;

    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    Signaling.sendOffer(remotePeerId, peer.pc.localDescription);
  }

  async function handleOffer(remotePeerId, sdp) {
    let peer = peers.get(remotePeerId);
    if (!peer) {
      peer = createPeerConnection(remotePeerId, false);
    }

    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    Signaling.sendAnswer(remotePeerId, peer.pc.localDescription);
  }

  async function handleAnswer(remotePeerId, sdp) {
    const peer = peers.get(remotePeerId);
    if (!peer) return;
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async function handleIceCandidate(remotePeerId, candidate) {
    const peer = peers.get(remotePeerId);
    if (!peer) return;
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn(`[WebRTC] Failed to add ICE candidate from peer ${remotePeerId}:`, err);
    }
  }

  /** Send data on a named channel to a specific peer */
  function sendToPeer(remotePeerId, channelName, data) {
    const peer = peers.get(remotePeerId);
    if (!peer) return false;
    const ch = peer.channels.get(channelName);
    if (!ch || ch.readyState !== "open") return false;
    ch.send(data);
    return true;
  }

  /** Broadcast data on a named channel to ALL connected peers */
  function broadcast(channelName, data) {
    for (const [peerId, peer] of peers) {
      const ch = peer.channels.get(channelName);
      if (ch && ch.readyState === "open") {
        ch.send(data);
      }
    }
  }

  /** Get the data channel for a specific peer */
  function getChannel(remotePeerId, channelName) {
    const peer = peers.get(remotePeerId);
    if (!peer) return null;
    return peer.channels.get(channelName) || null;
  }

  function removePeer(remotePeerId) {
    const peer = peers.get(remotePeerId);
    if (!peer) return;
    peer.pc.close();
    peers.delete(remotePeerId);
    if (window.VoiceChat) {
      VoiceChat.cleanupPeer(remotePeerId);
    }
    console.log(`[WebRTC] Removed peer ${remotePeerId}`);
  }

  function disconnectAll() {
    for (const [peerId] of peers) {
      removePeer(peerId);
    }
  }

  function getConnectedPeerIds() {
    const ids = [];
    for (const [peerId, peer] of peers) {
      if (peer.pc.iceConnectionState === "connected" || peer.pc.iceConnectionState === "completed") {
        ids.push(peerId);
      }
    }
    return ids;
  }

  // Wire up signaling events
  Signaling.on("offer", (msg) => handleOffer(msg.fromPeerId, msg.sdp));
  Signaling.on("answer", (msg) => handleAnswer(msg.fromPeerId, msg.sdp));
  Signaling.on("ice-candidate", (msg) => handleIceCandidate(msg.fromPeerId, msg.candidate));

  return {
    on,
    setMyPeerId,
    getMyPeerId,
    createPeerConnection,
    createOffer,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    sendToPeer,
    broadcast,
    getChannel,
    removePeer,
    disconnectAll,
    getConnectedPeerIds,
  };
})();
