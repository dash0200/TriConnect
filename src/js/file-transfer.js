/* ═══════════════════════════════════════════════════════════
   file-transfer.js — Chunked file transfer over WebRTC
   For Tauri: uses Rust backend for large file I/O
   For browser: uses File API directly
   ═══════════════════════════════════════════════════════════ */

window.FileTransfer = (() => {
  const CHANNEL = "file-transfer";
  const CHUNK_SIZE = 64 * 1024; // 64KB chunks
  const MAX_BUFFER = 1024 * 1024; // 1MB buffer threshold

  // Active transfers: Map<fileId, TransferState>
  const transfers = new Map();
  let transfersContainer = null;

  // Is Tauri available?
  const isTauri = typeof window.__TAURI__ !== "undefined";

  function init() {
    transfersContainer = document.getElementById("file-transfers");

    document.getElementById("btn-send-file").addEventListener("click", pickAndSendFile);

    // Listen for file transfer messages
    WebRTCMesh.on("message", ({ peerId, channel, data }) => {
      if (channel !== CHANNEL) return;

      // Binary data = file chunk
      if (data instanceof ArrayBuffer) {
        handleBinaryChunk(peerId, data);
        return;
      }

      // Text data = control message
      try {
        const msg = JSON.parse(data);
        handleControlMessage(peerId, msg);
      } catch (err) {
        console.warn("[FileTransfer] Invalid control message:", err);
      }
    });

    // Drag & drop on the files panel
    const panel = document.getElementById("panel-files");
    panel.addEventListener("dragover", (e) => {
      e.preventDefault();
      panel.classList.add("drag-over");
    });
    panel.addEventListener("dragleave", () => {
      panel.classList.remove("drag-over");
    });
    panel.addEventListener("drop", (e) => {
      e.preventDefault();
      panel.classList.remove("drag-over");
      if (e.dataTransfer.files.length > 0) {
        sendFile(e.dataTransfer.files[0]);
      }
    });
  }

  function generateFileId() {
    return `f_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  async function pickAndSendFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = () => {
      if (input.files.length > 0) {
        sendFile(input.files[0]);
      }
    };
    input.click();
  }

  async function sendFile(file) {
    const connectedPeers = WebRTCMesh.getConnectedPeerIds();
    if (connectedPeers.length === 0) {
      UI.toast("No connected peers to send to", "warning");
      return;
    }

    const fileId = generateFileId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Create transfer state
    const state = {
      fileId,
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
      chunksSent: 0,
      direction: "upload",
      file, // keep reference
      startTime: Date.now(),
      targetPeers: [...connectedPeers],
      cancelled: false,
    };
    transfers.set(fileId, state);

    // Add UI card
    addTransferCard(state);

    // Send offer to all connected peers
    const offerMsg = JSON.stringify({
      type: "file-offer",
      fileId,
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
      sender: WebRTCMesh.getMyPeerId(),
    });
    WebRTCMesh.broadcast(CHANNEL, offerMsg);

    // Start sending chunks to each peer
    for (const peerId of connectedPeers) {
      sendChunks(fileId, peerId, file);
    }
  }

  async function sendChunks(fileId, peerId, file) {
    const state = transfers.get(fileId);
    if (!state) return;

    for (let i = 0; i < state.totalChunks; i++) {
      if (state.cancelled) return;

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);
      const buffer = await blob.arrayBuffer();

      // Create a header: [4 bytes chunkIndex][rest is data]
      const header = new ArrayBuffer(4);
      new DataView(header).setUint32(0, i, true);

      // Prefix with fileId length + fileId + chunkIndex + data
      const fileIdBytes = new TextEncoder().encode(fileId);
      const packet = new ArrayBuffer(2 + fileIdBytes.length + 4 + buffer.byteLength);
      const view = new DataView(packet);
      view.setUint16(0, fileIdBytes.length, true);
      new Uint8Array(packet, 2, fileIdBytes.length).set(fileIdBytes);
      view.setUint32(2 + fileIdBytes.length, i, true);
      new Uint8Array(packet, 2 + fileIdBytes.length + 4).set(new Uint8Array(buffer));

      // Backpressure: wait if buffer is full
      const ch = WebRTCMesh.getChannel(peerId, CHANNEL);
      if (ch) {
        while (ch.bufferedAmount > MAX_BUFFER) {
          await new Promise((r) => setTimeout(r, 50));
          if (state.cancelled) return;
        }
        ch.send(packet);
      }

      // Update progress (use max across peers for simplicity)
      state.chunksSent = Math.max(state.chunksSent, i + 1);
      updateTransferCard(state);
    }

    // Send completion
    const doneMsg = JSON.stringify({ type: "file-done", fileId });
    WebRTCMesh.sendToPeer(peerId, CHANNEL, doneMsg);

    if (state.chunksSent >= state.totalChunks) {
      state.completed = true;
      updateTransferCard(state);
      UI.toast(`Sent "${state.fileName}" successfully`, "success");
    }
  }

  function handleControlMessage(peerId, msg) {
    switch (msg.type) {
      case "file-offer":
        handleFileOffer(peerId, msg);
        break;
      case "file-done":
        handleFileDone(msg.fileId);
        break;
      case "file-cancel":
        handleFileCancel(msg.fileId);
        break;
    }
  }

  function handleFileOffer(peerId, msg) {
    // Auto-accept: create receive state
    const state = {
      fileId: msg.fileId,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      totalChunks: msg.totalChunks,
      chunksReceived: 0,
      direction: "download",
      receivedChunks: new Array(msg.totalChunks),
      receivedBytes: 0,
      startTime: Date.now(),
      fromPeer: peerId,
      cancelled: false,
    };
    transfers.set(msg.fileId, state);
    addTransferCard(state);
    UI.toast(`Receiving "${msg.fileName}" from Peer ${peerId}`, "info");
  }

  function handleBinaryChunk(peerId, data) {
    // Parse packet: [2 bytes fileId length][fileId][4 bytes chunkIndex][data]
    const view = new DataView(data);
    const fileIdLen = view.getUint16(0, true);
    const fileIdBytes = new Uint8Array(data, 2, fileIdLen);
    const fileId = new TextDecoder().decode(fileIdBytes);
    const chunkIndex = view.getUint32(2 + fileIdLen, true);
    const chunkData = new Uint8Array(data, 2 + fileIdLen + 4);

    const state = transfers.get(fileId);
    if (!state || state.direction !== "download" || state.cancelled) return;

    state.receivedChunks[chunkIndex] = chunkData;
    state.chunksReceived++;
    state.receivedBytes += chunkData.byteLength;
    updateTransferCard(state);
  }

  function handleFileDone(fileId) {
    const state = transfers.get(fileId);
    if (!state || state.direction !== "download") return;

    // Assemble file
    const blob = new Blob(state.receivedChunks.filter(Boolean));
    const url = URL.createObjectURL(blob);

    // Trigger download
    const a = document.createElement("a");
    a.href = url;
    a.download = state.fileName;
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 60000);

    state.completed = true;
    state.receivedChunks = null; // free memory
    updateTransferCard(state);
    UI.toast(`Received "${state.fileName}" — saved!`, "success");
  }

  function handleFileCancel(fileId) {
    const state = transfers.get(fileId);
    if (!state) return;
    state.cancelled = true;
    updateTransferCard(state);
    UI.toast(`Transfer of "${state.fileName}" was cancelled`, "warning");
  }

  function cancelTransfer(fileId) {
    const state = transfers.get(fileId);
    if (!state) return;
    state.cancelled = true;
    updateTransferCard(state);
    WebRTCMesh.broadcast(CHANNEL, JSON.stringify({ type: "file-cancel", fileId }));
  }

  // ── UI rendering ──

  function addTransferCard(state) {
    const emptyEl = transfersContainer.querySelector(".files-empty");
    if (emptyEl) emptyEl.remove();

    const card = document.createElement("div");
    card.className = "file-transfer-card";
    card.id = `transfer-${state.fileId}`;
    card.innerHTML = renderCardHTML(state);
    transfersContainer.prepend(card);

    // Bind cancel button
    const cancelBtn = card.querySelector(".btn-cancel-transfer");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => cancelTransfer(state.fileId));
    }
  }

  function updateTransferCard(state) {
    const card = document.getElementById(`transfer-${state.fileId}`);
    if (!card) return;
    card.innerHTML = renderCardHTML(state);

    const cancelBtn = card.querySelector(".btn-cancel-transfer");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => cancelTransfer(state.fileId));
    }
  }

  function renderCardHTML(state) {
    const icon = UI.getFileIcon(state.fileName);
    const isUpload = state.direction === "upload";
    const arrow = isUpload ? "↑" : "↓";
    const dirLabel = isUpload ? "Sending" : "Receiving";

    const progress = isUpload
      ? state.chunksSent / state.totalChunks
      : state.chunksReceived / state.totalChunks;
    const pct = Math.round(progress * 100);

    const elapsed = (Date.now() - state.startTime) / 1000;
    const bytes = isUpload ? state.chunksSent * CHUNK_SIZE : state.receivedBytes;
    const speed = elapsed > 0 ? bytes / elapsed : 0;
    const remaining = speed > 0 ? (state.fileSize - bytes) / speed * 1000 : 0;

    let statusText;
    if (state.completed) {
      statusText = "✅ Completed";
    } else if (state.cancelled) {
      statusText = "❌ Cancelled";
    } else {
      statusText = `${dirLabel}... ${pct}%`;
    }

    const showProgress = !state.completed && !state.cancelled;

    return `
      <div class="file-info-row">
        <span class="file-name"><span class="file-icon">${icon}</span> ${state.fileName}</span>
        <span class="file-size">${UI.formatBytes(state.fileSize)}</span>
      </div>
      <div class="file-peer">${arrow} ${dirLabel} ${isUpload ? "to all peers" : `from Peer ${state.fromPeer}`}</div>
      ${showProgress ? `
        <div class="file-progress-bar">
          <div class="file-progress-fill" style="width: ${pct}%"></div>
        </div>
        <div class="file-stats">
          <span>${statusText}</span>
          <span>${UI.formatBytes(speed)}/s · ETA ${UI.formatDuration(remaining)}</span>
        </div>
        <div class="file-action-row">
          <button class="btn btn-danger btn-sm btn-cancel-transfer">Cancel</button>
        </div>
      ` : `
        <div class="file-stats">
          <span>${statusText}</span>
          <span>${UI.formatDuration(elapsed * 1000)} elapsed</span>
        </div>
      `}
    `;
  }

  return { init, cancelTransfer };
})();
