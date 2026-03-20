/* ═══════════════════════════════════════════════════════════
   ui.js — Toast notifications, modals & UI helpers
   ═══════════════════════════════════════════════════════════ */

window.UI = (() => {
  const toastContainer = document.getElementById("toast-container");

  function toast(message, type = "info", duration = 4000) {
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.textContent = message;
    toastContainer.appendChild(el);

    setTimeout(() => {
      el.classList.add("removing");
      el.addEventListener("animationend", () => el.remove());
    }, duration);
  }

  function showStatus(elementId, message, type = "info") {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = `status-message ${type}`;
    el.classList.remove("hidden");
  }

  function hideStatus(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.classList.add("hidden");
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "--:--";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function formatDuration(ms) {
    if (!isFinite(ms) || ms < 0) return "calculating...";
    const totalSec = Math.ceil(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function getFileIcon(filename) {
    const ext = filename.split(".").pop().toLowerCase();
    const icons = {
      pdf: "📄", doc: "📄", docx: "📄", txt: "📄",
      jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", svg: "🖼️", webp: "🖼️",
      mp4: "🎬", mkv: "🎬", avi: "🎬", mov: "🎬", webm: "🎬",
      mp3: "🎵", wav: "🎵", flac: "🎵", ogg: "🎵",
      zip: "🗜️", rar: "🗜️", tar: "🗜️", gz: "🗜️", "7z": "🗜️",
      js: "💻", py: "💻", rs: "💻", java: "💻", html: "💻", css: "💻",
      exe: "⚙️", dmg: "⚙️", iso: "💿",
    };
    return icons[ext] || "📎";
  }

  return { toast, showStatus, hideStatus, formatBytes, formatTime, formatDuration, getFileIcon };
})();
