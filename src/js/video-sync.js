/* ═══════════════════════════════════════════════════════════
   video-sync.js — Synchronized viewing
   Supports YouTube IFrame API and HTML5 <video>
   ═══════════════════════════════════════════════════════════ */

window.VideoSync = (() => {
  const CHANNEL = "video-sync";

  const STATE_PLAYING = 1;
  const STATE_PAUSED = 2;
  const STATE_BUFFERING = 3;
  const STATE_ENDED = 0;

  let playerWrapper = null;
  let currentVideoId = null;   // For YT it's the 11-char ID, for HTML5 it's the URL
  let currentVideoType = null; // "youtube" | "html5"
  
  let isRemoteAction = false; 
  let lastActionBy = null; 

  let localBuffering = false;
  let peerBuffering = new Set();
  let wasPlayingBeforeBuffer = false;

  function init() {
    document.getElementById("btn-load-video").addEventListener("click", () => {
      const urlInput = document.getElementById("video-url-input");
      const url = urlInput.value.trim();
      if (!url) return;
      const parsed = parseVideoUrl(url);
      if (!parsed) {
        UI.toast("Invalid video URL", "warning");
        return;
      }
      loadVideo(parsed.type, parsed.idOrSrc, true, 0, true);
    });

    WebRTCMesh.on("message", ({ peerId, channel, data }) => {
      if (channel !== CHANNEL) return;
      try {
        const msg = JSON.parse(data);
        handleSyncMessage(peerId, msg);
      } catch (err) {
        console.warn("[VideoSync] Invalid message:", err);
      }
    });

    // When a new peer connects, send them our current state!
    WebRTCMesh.on("peer-connected", ({ peerId }) => {
      if (playerWrapper && currentVideoId) {
         // Determine if we are currently playing
         const isPlaying = playerWrapper.getState() === STATE_PLAYING;
         const msg = JSON.stringify({
            type: "video-action",
            action: "load",
            videoType: currentVideoType,
            videoId: currentVideoId,
            time: playerWrapper.getCurrentTime(),
            forcePlay: isPlaying,
            sender: WebRTCMesh.getMyPeerId(),
         });
         // Send directly to the newly connected peer so they catch up
         setTimeout(() => {
           WebRTCMesh.sendToPeer(peerId, CHANNEL, msg);
         }, 500); // give them a tiny bit of time to setup
      }
    });

    loadYouTubeAPI();
  }

  function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) return;
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  }

  window.onYouTubeIframeAPIReady = () => {
    console.log("[VideoSync] YouTube IFrame API ready");
  };

  function parseVideoUrl(url) {
    const ytPatterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const pattern of ytPatterns) {
      const match = url.match(pattern);
      if (match) return { type: "youtube", idOrSrc: match[1] };
    }
    // If it's a URL ending in common video extensions, or just any http URL
    if (url.startsWith("http")) {
      return { type: "html5", idOrSrc: url };
    }
    return null;
  }

  // ── Unified Player Creation ──

  function createPlayer(type, idOrSrc, initialTime, forcePlay) {
    if (playerWrapper) {
      playerWrapper.destroy();
      playerWrapper = null;
    }

    const container = document.getElementById("youtube-player");
    container.innerHTML = "";

    if (type === "youtube") {
      createYouTubePlayer(container, idOrSrc, initialTime, forcePlay);
    } else if (type === "html5") {
      createHtml5Player(container, idOrSrc, initialTime, forcePlay);
    }
  }

  function createYouTubePlayer(container, videoId, initialTime, forcePlay) {
    const playerDiv = document.createElement("div");
    playerDiv.id = "yt-player-element";
    container.appendChild(playerDiv);

    let ytPlayer;
    let isReady = false;

    ytPlayer = new YT.Player("yt-player-element", {
      videoId: videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: forcePlay ? 1 : 0,
        start: Math.floor(initialTime || 0),
        controls: 1,
        modestbranding: 1,
        rel: 0,
      },
      events: {
        onReady: () => {
          isReady = true;
          updateSyncStatus("ready");
          if (forcePlay) ytPlayer.playVideo();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.UNSTARTED) return;
          const mappedState = 
             e.data === YT.PlayerState.PLAYING ? STATE_PLAYING :
             e.data === YT.PlayerState.PAUSED ? STATE_PAUSED :
             e.data === YT.PlayerState.BUFFERING ? STATE_BUFFERING :
             e.data === YT.PlayerState.ENDED ? STATE_ENDED : null;
          
          if (mappedState !== null) handleInternalStateChange(mappedState);
        }
      }
    });

    playerWrapper = {
      isReady: () => isReady,
      play: () => ytPlayer.playVideo && ytPlayer.playVideo(),
      pause: () => ytPlayer.pauseVideo && ytPlayer.pauseVideo(),
      seekTo: (time) => ytPlayer.seekTo && ytPlayer.seekTo(time, true),
      getCurrentTime: () => (ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0),
      getDuration: () => (ytPlayer.getDuration ? ytPlayer.getDuration() : 0),
      getState: () => {
        if (!ytPlayer.getPlayerState) return STATE_PAUSED;
        const s = ytPlayer.getPlayerState();
        return s === YT.PlayerState.PLAYING ? STATE_PLAYING :
               s === YT.PlayerState.BUFFERING ? STATE_BUFFERING : STATE_PAUSED;
      },
      destroy: () => ytPlayer.destroy && ytPlayer.destroy(),
    };
  }

  function createHtml5Player(container, src, initialTime, forcePlay) {
    const videoObj = document.createElement("video");
    videoObj.src = src;
    videoObj.controls = true;
    videoObj.style.maxWidth = "100%";
    videoObj.style.maxHeight = "100%";
    videoObj.style.objectFit = "contain";
    videoObj.style.backgroundColor = "black";
    if (initialTime) videoObj.currentTime = initialTime;
    
    container.appendChild(videoObj);

    let isReady = false;

    videoObj.addEventListener("loadedmetadata", () => {
      isReady = true;
      updateSyncStatus("ready");
      if (forcePlay) videoObj.play().catch(e => console.warn("Auto-play blocked", e));
    });

    videoObj.addEventListener("play", () => handleInternalStateChange(STATE_PLAYING));
    videoObj.addEventListener("pause", () => handleInternalStateChange(STATE_PAUSED));
    videoObj.addEventListener("waiting", () => handleInternalStateChange(STATE_BUFFERING));
    videoObj.addEventListener("playing", () => handleInternalStateChange(STATE_PLAYING));
    videoObj.addEventListener("ended", () => handleInternalStateChange(STATE_ENDED));
    videoObj.addEventListener("seeked", () => {
      if (!isRemoteAction) broadcastAction("seek", videoObj.currentTime);
    });

    playerWrapper = {
      isReady: () => isReady,
      play: () => videoObj.play().catch(()=>{}),
      pause: () => videoObj.pause(),
      seekTo: (time) => { videoObj.currentTime = time; },
      getCurrentTime: () => videoObj.currentTime,
      getDuration: () => videoObj.duration || 0,
      getState: () => {
        if (videoObj.readyState < 3 && videoObj.networkState === 2) return STATE_BUFFERING;
        return videoObj.paused ? STATE_PAUSED : STATE_PLAYING;
      },
      destroy: () => {
        videoObj.pause();
        videoObj.removeAttribute('src');
        videoObj.load();
        videoObj.remove();
      }
    };
  }

  // ── State handling ──

  function handleInternalStateChange(state) {
    if (isRemoteAction) return;

    switch (state) {
      case STATE_PLAYING:
        localBuffering = false;
        wasPlayingBeforeBuffer = true;
        broadcastAction("play", playerWrapper.getCurrentTime());
        updateSyncStatus("synced");
        break;

      case STATE_PAUSED:
        if (!peerBuffering.size) {
            wasPlayingBeforeBuffer = false;
        }
        broadcastAction("pause", playerWrapper.getCurrentTime());
        updateSyncStatus("paused");
        break;

      case STATE_BUFFERING:
        if (playerWrapper.getState() === STATE_PLAYING) {
            wasPlayingBeforeBuffer = true;
        }
        localBuffering = true;
        broadcastBuffering(true);
        updateSyncStatus("buffering");
        break;

      case STATE_ENDED:
        broadcastAction("pause", playerWrapper.getDuration());
        updateSyncStatus("ended");
        break;
    }
  }

  function loadVideo(type, idOrSrc, broadcastIt = false, time = 0, forcePlay = true) {
    if (type === "youtube" && (!window.YT || !window.YT.Player)) {
      setTimeout(() => loadVideo(type, idOrSrc, broadcastIt, time, forcePlay), 500);
      return;
    }

    currentVideoType = type;
    currentVideoId = idOrSrc;

    // Always recreate the player on new load to avoid stale state bugs (black screen fix)
    createPlayer(type, idOrSrc, time, forcePlay);

    if (broadcastIt) {
      const msg = JSON.stringify({
        type: "video-action",
        action: "load",
        videoType: type,
        videoId: idOrSrc,
        time: time,
        forcePlay: forcePlay,
        sender: WebRTCMesh.getMyPeerId(),
      });
      WebRTCMesh.broadcast(CHANNEL, msg);
    }

    updateSyncStatus("loading");
    UI.toast("Loading video...", "info");
  }

  function broadcastAction(action, time) {
    if (!playerWrapper) return;
    lastActionBy = WebRTCMesh.getMyPeerId();
    const msg = JSON.stringify({
      type: "video-action",
      action,
      time,
      videoId: currentVideoId,
      videoType: currentVideoType,
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
      case "video-buffering":
        peerBuffering.add(peerId);
        if (playerWrapper && playerWrapper.isReady()) {
          isRemoteAction = true;
          playerWrapper.pause();
          setTimeout(() => (isRemoteAction = false), 200);
        }
        updateSyncStatus("peer-buffering");
        break;
      case "video-ready":
        peerBuffering.delete(peerId);
        if (peerBuffering.size === 0 && !localBuffering) {
          if (wasPlayingBeforeBuffer && playerWrapper && playerWrapper.isReady()) {
            isRemoteAction = true;
            playerWrapper.play();
            setTimeout(() => (isRemoteAction = false), 200);
          }
          updateSyncStatus("synced");
        }
        break;
    }
  }

  function handleRemoteAction(peerId, msg) {
    isRemoteAction = true;

    switch (msg.action) {
      case "load":
        // Fix black screen by always accepting remote URL with fresh player
        if (msg.videoId !== currentVideoId || !playerWrapper) {
          loadVideo(msg.videoType, msg.videoId, false, msg.time, msg.forcePlay);
        } else {
          // If it's already loaded but they are syncing us, just seek
          if (playerWrapper && playerWrapper.isReady()) {
               playerWrapper.seekTo(msg.time);
               if (msg.forcePlay) playerWrapper.play();
          }
        }
        break;

      case "play":
        if (!playerWrapper || !playerWrapper.isReady()) break;
        playerWrapper.seekTo(msg.time);
        playerWrapper.play();
        updateSyncStatus("synced");
        break;

      case "pause":
        if (!playerWrapper || !playerWrapper.isReady()) break;
        playerWrapper.seekTo(msg.time);
        playerWrapper.pause();
        updateSyncStatus("paused");
        break;

      case "seek":
        if (!playerWrapper || !playerWrapper.isReady()) break;
        playerWrapper.seekTo(msg.time);
        break;
    }

    setTimeout(() => {
      isRemoteAction = false;
    }, 300);
  }

  function updateSyncStatus(status) {
    const el = document.getElementById("video-sync-status");
    if (!el) return;
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
    if (dot) dot.className = "sync-dot " + s.dotClass;
  }

  return { init };
})();
