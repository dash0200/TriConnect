/* ═══════════════════════════════════════════════════════════
   file-transfer.js — Chunked file transfer over WebRTC
   Uses Rust backend for zero-copy streaming, hashing, encryption, and compression.
   ═══════════════════════════════════════════════════════════ */

window.FileTransfer = (() => {
  const CHANNEL = "file-transfer";
  const CHUNK_SIZE = 64 * 1024; // 64KB chunks
  const MAX_BUFFER = 1024 * 1024; // 1MB buffer threshold

  // Active transfers: Map<fileId, TransferState>
  const transfers = new Map();
  let transfersContainer = null;

  const isTauri = typeof window.__TAURI__ !== "undefined";

  function init() {
    transfersContainer = document.getElementById("chat-messages");

    document.getElementById("btn-send-file").addEventListener("click", pickAndSendFile);

    // Listen for file transfer messages
    WebRTCMesh.on("message", async ({ peerId, channel, data }) => {
      if (channel !== CHANNEL) return;

      // Binary data = file chunk (encrypted or plaintext)
      if (data instanceof ArrayBuffer) {
        await handleBinaryChunk(peerId, data);
        return;
      }

      // Text data = control message (but maybe encrypted)
      let msgText = null;
      if (typeof data === "string") {
        msgText = data;
      }

      if (msgText) {
        try {
          const msg = JSON.parse(msgText);
          await handleControlMessage(peerId, msg);
        } catch (err) {
          console.warn("[FileTransfer] Invalid control message:", err);
        }
      }
    });

    // Drag & drop on the chat panel
    const panel = document.getElementById("panel-chat");
    panel.addEventListener("dragover", (e) => {
      e.preventDefault();
      panel.classList.add("drag-over");
    });
    panel.addEventListener("dragleave", () => {
      panel.classList.remove("drag-over");
    });
    panel.addEventListener("drop", async (e) => {
      e.preventDefault();
      panel.classList.remove("drag-over");
      if (!isTauri) {
        UI.toast("File transfer requires the desktop app", "error");
        return;
      }
      
      if (e.dataTransfer.files.length > 0) {
        // Since we need the ABSOLUTE path for Rust, we can't use generic Web drops easily.
        // Tauri dialog is the safe way. However, if paths are exposed somehow we could use it.
        // For security, just open the picker.
        pickAndSendFile();
      }
    });
  }

  function generateFileId() {
    return `f_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  async function pickAndSendFile() {
    if (!isTauri) {
      UI.toast("Sending files requires the desktop app", "error");
      return;
    }

    try {
      const selected = await window.__TAURI__.dialog.open({
        multiple: false,
        title: "Select File to Send"
      });

      if (selected) {
        sendFile(selected);
      }
    } catch (err) {
      console.error("[File] Dialog failed:", err);
    }
  }

  async function sendFile(filePath) {
    const connectedPeers = WebRTCMesh.getConnectedPeerIds();
    if (connectedPeers.length === 0) {
      UI.toast("No connected peers to send to", "warning");
      return;
    }

    try {
      // Get metadata & hash via Rust
      UI.toast("Hashing file...", "info");
      const metadata = await window.__TAURI__.core.invoke("get_file_metadata", { path: filePath });
      const hash = await window.__TAURI__.core.invoke("hash_file", { path: filePath });

      const fileId = generateFileId();
      const totalChunks = Math.ceil(metadata.size / CHUNK_SIZE);

      // Create transfer state
      const state = {
        fileId,
        fileName: metadata.name,
        fileSize: metadata.size,
        fileHash: hash,
        filePath,
        totalChunks,
        chunksSent: 0,
        direction: "upload",
        startTime: Date.now(),
        targetPeers: [...connectedPeers],
        cancelled: false,
      };
      transfers.set(fileId, state);
      addTransferCard(state);

      // Start sending to each peer independently
      // (Since encryption + compression might be peer-specific if E2E keys differ)
      for (const peerId of connectedPeers) {
        const secret = window.AppCrypto.getSharedSecret(peerId);
        const encrypted = !!secret;
        const compressed = true;

        // Send offer to THIS peer
        const offerMsg = {
          type: "file-offer",
          fileId,
          fileName: metadata.name,
          fileSize: metadata.size,
          fileHash: hash,
          totalChunks,
          sender: WebRTCMesh.getMyPeerId(),
          encrypted,
          compressed
        };
        sendControlMessage(peerId, offerMsg, secret);
        
        // Start streaming chunks
        sendChunks(fileId, peerId, filePath, secret, compressed);
      }
    } catch (err) {
      UI.toast(`Failed to read file: ${err}`, "error");
      console.error(err);
    }
  }

  async function sendControlMessage(peerId, msgObj, secret) {
    const msgStr = JSON.stringify(msgObj);
    if (secret && isTauri) {
      // Encrypt control messages, but wrap in JSON so receiver knows it's an encrypted control msg
      try {
        const plaintext = Array.from(new TextEncoder().encode(msgStr));
        const ciphertextVec = await window.__TAURI__.core.invoke("encrypt", {
          sharedSecretB64: secret,
          plaintext: plaintext
        });
        
        // Send as stringified payload so we distinguish from binary chunks
        const wrapper = JSON.stringify({
          type: "encrypted-control",
          data: Array.from(ciphertextVec) // Array for JSON transport
        });
        WebRTCMesh.sendToPeer(peerId, CHANNEL, wrapper);
      } catch (e) {
        console.error("Failed to encrypt control message:", e);
      }
    } else {
      WebRTCMesh.sendToPeer(peerId, CHANNEL, msgStr);
    }
  }

  async function sendChunks(fileId, peerId, filePath, secret, useCompression) {
    const state = transfers.get(fileId);
    if (!state) return;

    for (let i = 0; i < state.totalChunks; i++) {
      if (state.cancelled) return;

      const offset = i * CHUNK_SIZE;
      let size = CHUNK_SIZE;
      if (offset + size > state.fileSize) {
        size = state.fileSize - offset;
      }

      try {
        // 1. Read chunk via Rust
        let chunkDataVec = await window.__TAURI__.core.invoke("read_file_chunk", {
          path: filePath,
          offset: offset,
          size: size
        });

        // 2. Compress via Rust
        if (useCompression) {
          chunkDataVec = await window.__TAURI__.core.invoke("compress_data", {
            data: chunkDataVec,
            level: 3
          });
        }

        // 3. Assemble packet: [2 bytes fileId length][fileId][4 bytes chunkIndex][data]
        const fileIdBytes = new TextEncoder().encode(fileId);
        const headerPacket = new Uint8Array(2 + fileIdBytes.length + 4 + chunkDataVec.length);
        const view = new DataView(headerPacket.buffer);
        
        view.setUint16(0, fileIdBytes.length, true);
        headerPacket.set(fileIdBytes, 2);
        view.setUint32(2 + fileIdBytes.length, i, true);
        headerPacket.set(new Uint8Array(chunkDataVec), 2 + fileIdBytes.length + 4);

        // 4. Encrypt packet via Rust
        let finalPacketBytes = Array.from(headerPacket);
        if (secret) {
          finalPacketBytes = await window.__TAURI__.core.invoke("encrypt", {
            sharedSecretB64: secret,
            plaintext: finalPacketBytes
          });
        }
        
        const packetBuffer = new Uint8Array(finalPacketBytes).buffer;

        // 5. Backpressure control
        const ch = WebRTCMesh.getChannel(peerId, CHANNEL);
        if (ch) {
          while (ch.bufferedAmount > MAX_BUFFER) {
            await new Promise((r) => setTimeout(r, 50));
            if (state.cancelled) return;
          }
          ch.send(packetBuffer);
        }

        // Update progress (use max across peers for simplicity)
        state.chunksSent = Math.max(state.chunksSent, i + 1);
        updateTransferCard(state);
      } catch (err) {
        console.error(`[File] Send chunk failed:`, err);
        return;
      }
    }

    // Send completion
    sendControlMessage(peerId, { type: "file-done", fileId }, secret);

    if (state.chunksSent >= state.totalChunks && !state.completed) {
      state.completed = true;
      updateTransferCard(state);
      UI.toast(`Sent "${state.fileName}" successfully`, "success");
    }
  }

  async function handleControlMessage(peerId, msg) {
    // Decrypt if it's an encrypted control wrapper
    if (msg.type === "encrypted-control") {
      const secret = window.AppCrypto.getSharedSecret(peerId);
      if (!secret || !isTauri) return;
      
      try {
        const plaintextBytes = await window.__TAURI__.core.invoke("decrypt", {
          sharedSecretB64: secret,
          ciphertext: msg.data
        });
        const innerMsgText = new TextDecoder().decode(new Uint8Array(plaintextBytes));
        msg = JSON.parse(innerMsgText);
      } catch (e) {
        console.error("Failed to decrypt control message:", e);
        return;
      }
    }

    switch (msg.type) {
      case "file-offer":
        await handleFileOffer(peerId, msg);
        break;
      case "file-done":
        await handleFileDone(msg.fileId);
        break;
      case "file-cancel":
        await handleFileCancel(msg.fileId);
        break;
    }
  }

  async function handleFileOffer(peerId, msg) {
    if (!isTauri) {
      UI.toast("Receiving files requires the desktop app", "error");
      return;
    }

    try {
      // Ask Rust to prepare temp file
      const tempPath = await window.__TAURI__.core.invoke("prepare_receive_file", {
        fileId: msg.fileId,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
      });

      const state = {
        fileId: msg.fileId,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        fileHash: msg.fileHash,
        totalChunks: msg.totalChunks,
        chunksReceived: 0,
        direction: "download",
        tempPath: tempPath,
        receivedBytes: 0,
        startTime: Date.now(),
        fromPeer: peerId,
        cancelled: false,
        encrypted: msg.encrypted,
        compressed: msg.compressed,
      };
      
      transfers.set(msg.fileId, state);
      addTransferCard(state);
      
      if (window.AppCrypto.sendNotification) {
        window.AppCrypto.sendNotification("Incoming File", `Receiving ${msg.fileName}`);
      }
    } catch (err) {
      console.error("[File] Prepare receive failed:", err);
      UI.toast("Failed to prepare file receive", "error");
    }
  }

  async function handleBinaryChunk(peerId, dataBuffer) {
    // dataBuffer is ArrayBuffer
    let dataVec = Array.from(new Uint8Array(dataBuffer));
    
    // We only know if it's encrypted by trying to decrypt, or assuming based on secret
    const secret = window.AppCrypto.getSharedSecret(peerId);
    
    if (secret && isTauri) {
      try {
        dataVec = await window.__TAURI__.core.invoke("decrypt", {
          sharedSecretB64: secret,
          ciphertext: dataVec
        });
      } catch (err) {
        console.warn("[File] Decrypt chunk failed. Might be plaintext.", err);
      }
    }

    // Now parse packet: [2 bytes fileId length][fileId][4 bytes chunkIndex][data]
    const headerBytes = new Uint8Array(dataVec);
    const view = new DataView(headerBytes.buffer);
    
    // Check if we have at least 2 bytes
    if (headerBytes.length < 2) return;
    
    const fileIdLen = view.getUint16(0, true);
    if (headerBytes.length < 2 + fileIdLen + 4) return;
    
    const fileIdBytes = new Uint8Array(headerBytes.buffer, 2, fileIdLen);
    const fileId = new TextDecoder().decode(fileIdBytes);
    const chunkIndex = view.getUint32(2 + fileIdLen, true);
    
    let chunkDataVec = Array.from(new Uint8Array(headerBytes.buffer, 2 + fileIdLen + 4));

    const state = transfers.get(fileId);
    if (!state || state.direction !== "download" || state.cancelled) return;

    // Decompress if needed
    if (state.compressed && isTauri) {
      try {
        chunkDataVec = await window.__TAURI__.core.invoke("decompress_data", {
          data: chunkDataVec
        });
      } catch (err) {
        console.error("[File] Decompression failed:", err);
        return;
      }
    }

    // Write chunk to temp file via Rust
    try {
      const offset = chunkIndex * CHUNK_SIZE;
      await window.__TAURI__.core.invoke("append_chunk", {
        tempPath: state.tempPath,
        offset: offset,
        data: chunkDataVec
      });

      state.chunksReceived++;
      state.receivedBytes += chunkDataVec.length;
      updateTransferCard(state);
    } catch (err) {
      console.error("[File] Write chunk failed:", err);
    }
  }

  async function handleFileDone(fileId) {
    const state = transfers.get(fileId);
    if (!state || state.direction !== "download" || state.cancelled) return;

    try {
      // 1. Ask user where to save
      UI.toast(`Select save location for "${state.fileName}"`, "info");
      const savePath = await window.__TAURI__.dialog.save({
        defaultPath: state.fileName,
        title: "Save Received File"
      });

      if (!savePath) {
        // User cancelled save dialog
        UI.toast("File save cancelled", "warning");
        await window.__TAURI__.core.invoke("cancel_receive", { fileId });
        state.cancelled = true;
        updateTransferCard(state);
        return;
      }

      // 2. Finalize file move
      await window.__TAURI__.core.invoke("finalize_file", {
        fileId: fileId,
        tempPath: state.tempPath,
        savePath: savePath
      });

      // 3. Verify hash
      UI.toast("Verifying file integrity...", "info");
      const finalHash = await window.__TAURI__.core.invoke("hash_file", {
        path: savePath
      });

      if (finalHash === state.fileHash) {
        state.hashVerified = true;
        UI.toast(`Saved and verified "${state.fileName}"`, "success");
        if (window.AppCrypto.sendNotification) {
          window.AppCrypto.sendNotification("Download Complete", `Saved ${state.fileName}`);
        }
      } else {
        state.hashVerified = false;
        UI.toast(`Integrity check failed for "${state.fileName}"!`, "error");
      }

      state.completed = true;
      updateTransferCard(state);

    } catch (err) {
      console.error("[File] Finalize failed:", err);
      UI.toast("Failed to save file", "error");
    }
  }

  async function handleFileCancel(fileId) {
    const state = transfers.get(fileId);
    if (!state) return;
    state.cancelled = true;
    updateTransferCard(state);
    UI.toast(`Transfer of "${state.fileName}" was cancelled`, "warning");
    
    if (state.direction === "download" && state.tempPath && isTauri) {
      try {
        await window.__TAURI__.core.invoke("cancel_receive", { fileId });
      } catch (err) {
        console.error("Cleanup failed", err);
      }
    }
  }

  async function cancelTransfer(fileId) {
    const state = transfers.get(fileId);
    if (!state) return;
    state.cancelled = true;
    updateTransferCard(state);
    
    const secret = window.AppCrypto.getSharedSecret(state.fromPeer || state.targetPeers[0]);
    sendControlMessage(state.fromPeer || state.targetPeers[0], { type: "file-cancel", fileId }, secret);

    if (state.direction === "download" && state.tempPath && isTauri) {
      try {
        await window.__TAURI__.core.invoke("cancel_receive", { fileId });
      } catch (err) {
        console.error("Cleanup failed", err);
      }
    }
  }

  // ── UI rendering ──

  function addTransferCard(state) {
    // Determine sender name/color
    const isUpload = state.direction === "upload";
    const PEER_COLORS = ["var(--peer-0)", "var(--peer-1)", "var(--peer-2)"];
    const PEER_NAMES = ["You", "Peer 1", "Peer 2"];

    const senderIndex = isUpload ? WebRTCMesh.getMyPeerId() : state.fromPeer;
    const senderName = isUpload ? "You" : (PEER_NAMES[senderIndex] || `Peer ${senderIndex}`);
    const senderColor = PEER_COLORS[senderIndex] || "var(--text-secondary)";
    const timeStr = new Date(state.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const card = document.createElement("div");
    card.className = `chat-msg ${isUpload ? "self" : "peer"}`;
    card.id = `transfer-wrapper-${state.fileId}`;
    
    card.innerHTML = `
      <span class="msg-sender" style="color: ${senderColor}">${senderName} sent a file</span>
      <div class="msg-bubble file-transfer-bubble" id="transfer-${state.fileId}">
        ${renderCardHTML(state)}
      </div>
      <span class="msg-time">${timeStr}</span>
    `;

    const emptyEl = transfersContainer.querySelector(".chat-empty");
    if (emptyEl) emptyEl.remove();

    transfersContainer.appendChild(card);
    transfersContainer.scrollTop = transfersContainer.scrollHeight;

    setTimeout(() => {
      const cancelBtn = card.querySelector(".btn-cancel-transfer");
      if (cancelBtn) {
        cancelBtn.addEventListener("click", () => cancelTransfer(state.fileId));
      }
    }, 0);
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
      if (state.direction === "download") {
        statusText = state.hashVerified ? "✅ Verified & Saved" : "❌ Integrity Failed";
      } else {
        statusText = "✅ Sent";
      }
    } else if (state.cancelled) {
      statusText = "❌ Cancelled";
    } else {
      statusText = `${dirLabel}... ${pct}%`;
    }

    const showProgress = !state.completed && !state.cancelled;
    
    // Compression ratio estimate
    let compressionInfo = "";
    if (state.direction === "download" && state.compressed && state.receivedBytes > 0 && state.chunksReceived > 0) {
       const uncompressedBytesAtThisPoint = state.chunksReceived * CHUNK_SIZE;
       const ratio = Math.round((1 - (state.receivedBytes / uncompressedBytesAtThisPoint)) * 100);
       if (ratio > 0 && ratio < 100) {
         compressionInfo = ` | Zstd: ~${ratio}% saved`;
       }
    }

    return `
      <div class="file-info-row">
        <span class="file-name"><span class="file-icon">${icon}</span> ${state.fileName}</span>
        <span class="file-size">${UI.formatBytes(state.fileSize)}</span>
      </div>
      <div class="file-peer" style="display:flex; justify-content:space-between">
        <span>${arrow} ${dirLabel} ${isUpload ? "to peers" : `from Peer ${state.fromPeer}`}</span>
        <span>${state.encrypted ? "🔒" : "🔓"}</span>
      </div>
      ${showProgress ? `
        <div class="file-progress-bar">
          <div class="file-progress-fill" style="width: ${pct}%"></div>
        </div>
        <div class="file-stats">
          <span>${statusText}</span>
          <span>${UI.formatBytes(speed)}/s · ETA ${UI.formatDuration(remaining)}${compressionInfo}</span>
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

  return { init, cancelTransfer, sendFile };
})();
