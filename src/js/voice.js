/* ═══════════════════════════════════════════════════════════
   voice.js — Local microphone capture and playback
   ═══════════════════════════════════════════════════════════ */

window.VoiceChat = (() => {
  let localStream = null;
  let isMuted = false;

  const btnMicToggle = document.getElementById("btn-mic-toggle");

  async function init() {
    try {
      console.log("[Voice] Requesting microphone access...");
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("[Voice] Microphone access granted.");
      setupUI();
    } catch (err) {
      console.warn("[Voice] Microphone access denied or not available:", err);
      if (btnMicToggle) {
        btnMicToggle.style.display = "none";
      }
    }
  }

  function setupUI() {
    if (!btnMicToggle) return;
    btnMicToggle.style.display = "inline-flex"; // show the button
    btnMicToggle.addEventListener("click", toggleMute);
    updateUI();
  }

  function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    
    // Enable/disable the first audio track
    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length > 0) {
      audioTracks[0].enabled = !isMuted;
    }
    
    updateUI();
    console.log(`[Voice] Microphone ${isMuted ? 'muted' : 'unmuted'}`);
  }

  function updateUI() {
    if (!btnMicToggle) return;
    if (isMuted) {
      btnMicToggle.classList.add("muted");
      btnMicToggle.classList.remove("btn-ghost");
      btnMicToggle.classList.add("btn-secondary");
      btnMicToggle.innerHTML = "🔇";
      btnMicToggle.title = "Unmute Microphone";
    } else {
      btnMicToggle.classList.remove("muted");
      btnMicToggle.classList.remove("btn-secondary");
      btnMicToggle.classList.add("btn-ghost");
      btnMicToggle.innerHTML = "🎤";
      btnMicToggle.title = "Mute Microphone";
    }
  }

  function getStream() {
    return localStream;
  }

  function handleIncomingTrack(remotePeerId, event) {
    console.log(`[Voice] Received audio track from peer ${remotePeerId}`);
    
    let audioEl = document.getElementById(`audio-peer-${remotePeerId}`);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `audio-peer-${remotePeerId}`;
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
    }
    
    // The event stream contains the incoming media stream
    if (event.streams && event.streams[0]) {
      audioEl.srcObject = event.streams[0];
    } else {
      const inboundStream = new MediaStream([event.track]);
      audioEl.srcObject = inboundStream;
    }
  }

  function cleanupPeer(remotePeerId) {
    const audioEl = document.getElementById(`audio-peer-${remotePeerId}`);
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
    }
  }

  return { init, getStream, handleIncomingTrack, cleanupPeer };
})();
