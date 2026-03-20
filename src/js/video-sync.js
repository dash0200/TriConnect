/* ═══════════════════════════════════════════════════════════
   video-sync.js — YouTube synchronized viewing
   Uses YouTube IFrame Player API
   ═══════════════════════════════════════════════════════════ */

window.VideoSync = (() => {
  const CHANNEL = "video-sync";
  const DRIFT_THRESHOLD = 0.8; // seconds — correct if drift exceeds this
  const HEARTBEAT_INTERVAL = 2000; // ms

  let player = null;
  let playerReady = false;
  let currentVideoId = null;
  let isRemoteAction = false; // flag to ignore events triggered by remote sync
  let heartbeatTimer = null;
  let lastActionBy = null; // peerId of last user who performed an action

  // Buffering tracking
  let localBuffering = false;
  let peerBuffering = new Set();

  function init() {
    document.getElementById("btn-load-video").addEventListener("click", () => {
      const urlInput = document.getElementById("video-url-input");
      const url = urlInput.value.trim();
      if (!url) return;
      const videoId = extractVideoId(url);
      if (!videoId) {
        UI.toast("Invalid YouTube URL", "warning");
        return;
      }
      loadVideo(videoId, true);
    });

    // Listen for video sync messages
    WebRTCMesh.on("message", ({ peerId, channel, data }) => {
      if (channel !== CHANNEL) return;
      try {
        const msg = JSON.parse(data);
        handleSyncMessage(peerId, msg);
      } catch (err) {
        console.warn("[VideoSync] Invalid message:", err);
      }
    });

    // Load YouTube IFrame API
    loadYouTubeAPI();
  }

  function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) {
      // API already loaded
      return;
    }
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  }

  // Called by YouTube API when ready
  window.onYouTubeIframeAPIReady = () => {
    console.log("[VideoSync] YouTube IFrame API ready");
    // Player will be created when a video is loaded
  };

  function createPlayer(videoId) {
    const container = document.getElementById("youtube-player");
    container.innerHTML = ""; // clear placeholder

    // Create a div for the player
    const playerDiv = document.createElement("div");
    playerDiv.id = "yt-player-element";
    container.appendChild(playerDiv);

    player = new YT.Player("yt-player-element", {
      videoId: videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 0,
        controls: 1,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3, // no annotations
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
      },
    });
  }

  function onPlayerReady() {
    playerReady = true;
    console.log("[VideoSync] Player ready");
    updateSyncStatus("ready");
  }

  function onPlayerStateChange(event) {
    if (isRemoteAction) return; // ignore events triggered by remote sync

    const state = event.data;

    switch (state) {
      case YT.PlayerState.PLAYING:
        localBuffering = false;
        broadcastAction("play", player.getCurrentTime());
        startHeartbeat();
        updateSyncStatus("synced");
        break;

      case YT.PlayerState.PAUSED:
        broadcastAction("pause", player.getCurrentTime());
        stopHeartbeat();
        updateSyncStatus("paused");
        break;

      case YT.PlayerState.BUFFERING:
        localBuffering = true;
        broadcastBuffering(true);
        updateSyncStatus("buffering");
        break;

      case YT.PlayerState.ENDED:
        broadcastAction("pause", player.getDuration());
        stopHeartbeat();
        updateSyncStatus("ended");
        break;
    }
  }

  function loadVideo(videoId, broadcastIt = false) {
    currentVideoId = videoId;

    if (!window.YT || !window.YT.Player) {
      // API not loaded yet, wait
      setTimeout(() => loadVideo(videoId, broadcastIt), 500);
      return;
    }

    if (!player || !playerReady) {
      createPlayer(videoId);
    } else {
      player.loadVideoById(videoId);
    }

    if (broadcastIt) {
      const msg = JSON.stringify({
        type: "video-action",
        action: "load",
        videoId,
        time: 0,
        sender: WebRTCMesh.getMyPeerId(),
      });
      WebRTCMesh.broadcast(CHANNEL, msg);
    }

    updateSyncStatus("loading");
    UI.toast("Loading video...", "info");
  }

  function broadcastAction(action, time) {
    lastActionBy = WebRTCMesh.getMyPeerId();
    const msg = JSON.stringify({
      type: "video-action",
      action,
      time,
      videoId: currentVideoId,
      sender: WebRTCMesh.getMyPeerId(),
    });
    WebRTCMesh.broadcast(CHANNEL, msg);
  }

  function broadcastBuffering(isBuffering) {
    const msg = JSON.stringify({
      type: isBuffering ? "video-buffering" : "video-ready",
      sender: WebRTCMesh.getMyPeerId(),
    });
    WebRTCMesh.broadcast(CHANNEL, msg);
  }

  function handleSyncMessage(peerId, msg) {
    switch (msg.type) {
      case "video-action":
        handleRemoteAction(peerId, msg);
        break;
      case "video-heartbeat":
        handleHeartbeat(peerId, msg);
        break;
      case "video-buffering":
        peerBuffering.add(peerId);
        if (player && playerReady) {
          isRemoteAction = true;
          player.pauseVideo();
          setTimeout(() => (isRemoteAction = false), 200);
        }
        updateSyncStatus("peer-buffering");
        break;
      case "video-ready":
        peerBuffering.delete(peerId);
        if (peerBuffering.size === 0 && !localBuffering) {
          updateSyncStatus("synced");
        }
        break;
    }
  }

  function handleRemoteAction(peerId, msg) {
    isRemoteAction = true;

    switch (msg.action) {
      case "load":
        if (msg.videoId !== currentVideoId) {
          loadVideo(msg.videoId, false);
        }
        break;

      case "play":
        if (!player || !playerReady) break;
        player.seekTo(msg.time, true);
        player.playVideo();
        startHeartbeat();
        updateSyncStatus("synced");
        break;

      case "pause":
        if (!player || !playerReady) break;
        player.seekTo(msg.time, true);
        player.pauseVideo();
        stopHeartbeat();
        updateSyncStatus("paused");
        break;

      case "seek":
        if (!player || !playerReady) break;
        player.seekTo(msg.time, true);
        break;
    }

    // Clear the remote flag after a short delay
    setTimeout(() => {
      isRemoteAction = false;
    }, 300);
  }

  function handleHeartbeat(peerId, msg) {
    if (!player || !playerReady) return;
    if (player.getPlayerState() !== YT.PlayerState.PLAYING) return;

    const localTime = player.getCurrentTime();
    const drift = Math.abs(localTime - msg.time);

    if (drift > DRIFT_THRESHOLD) {
      console.log(`[VideoSync] Drift correction: local=${localTime.toFixed(2)}, remote=${msg.time.toFixed(2)}, drift=${drift.toFixed(2)}s`);
      isRemoteAction = true;
      player.seekTo(msg.time, true);
      setTimeout(() => (isRemoteAction = false), 200);
      updateSyncStatus("correcting");
      setTimeout(() => updateSyncStatus("synced"), 1000);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastActionBy = lastActionBy || WebRTCMesh.getMyPeerId();

    heartbeatTimer = setInterval(() => {
      if (!player || !playerReady) return;
      if (player.getPlayerState() !== YT.PlayerState.PLAYING) return;

      // Only the last person who performed an action sends heartbeats
      if (lastActionBy !== WebRTCMesh.getMyPeerId()) return;

      const msg = JSON.stringify({
        type: "video-heartbeat",
        time: player.getCurrentTime(),
        state: "playing",
        sender: WebRTCMesh.getMyPeerId(),
      });
      WebRTCMesh.broadcast(CHANNEL, msg);
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function updateSyncStatus(status) {
    const el = document.getElementById("video-sync-status");
    const dot = el.querySelector(".sync-dot");

    const statusMap = {
      ready: { text: "Player ready", dotClass: "" },
      synced: { text: "Synced ✓", dotClass: "synced" },
      paused: { text: "Paused", dotClass: "" },
      loading: { text: "Loading video...", dotClass: "" },
      buffering: { text: "Buffering...", dotClass: "desynced" },
      "peer-buffering": { text: "Waiting for peer to buffer...", dotClass: "desynced" },
      correcting: { text: "Correcting drift...", dotClass: "desynced" },
      ended: { text: "Video ended", dotClass: "" },
    };

    const s = statusMap[status] || { text: status, dotClass: "" };
    el.childNodes[el.childNodes.length - 1].textContent = " " + s.text;
    dot.className = "sync-dot " + s.dotClass;
  }

  function extractVideoId(url) {
    // Handle various YouTube URL formats
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/, // bare video ID
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  return { init };
})();
