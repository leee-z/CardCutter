(() => {
  const CC_SETTINGS = window.__cc_settings || {};
  if (!CC_SETTINGS.getSetting) {
    CC_SETTINGS.getSetting = (key, fallback) => new Promise(resolve => {
      try {
        chrome.storage.sync.get({ [key]: fallback }, (res) => resolve(res[key]));
      } catch (_) {
        resolve(fallback);
      }
    });
  }
  if (!CC_SETTINGS.setSetting) {
    CC_SETTINGS.setSetting = (key, value) => {
      try {
        chrome.storage.sync.set({ [key]: value });
      } catch (_) {
        // ignore
      }
    };
  }
  window.__cc_settings = CC_SETTINGS;
  if (typeof window.getSetting !== "function") {
    window.getSetting = CC_SETTINGS.getSetting;
  }

  if (window.__cc_loaded) return;
  window.__cc_loaded = true;

  const STATE = {
    start: null,
    end: null,
    subtitle: "",
    recording: false,
    recorder: null,
    chunks: [],
    lastCue: null,
    visible: false,
    built: false,
    biliSubtitleCache: null,
    lastBuffer: null,
    lastRecordStart: null,
    lastRecordEnd: null,
    lastSubtitle: "",
    trimStart: 0,
    trimEnd: 0,
    trimVisible: false,
    previewContext: null
    ,
    waveZoom: 1,
    waveOffset: 0,
    draggingTrim: null,
    segmentPlayback: null
  };

  const UI_IDS = {
    root: "cc-root",
    start: "cc-start",
    end: "cc-end",
    subtitle: "cc-subtitle",
    status: "cc-status",
    btnStart: "cc-btn-start",
    btnEnd: "cc-btn-end",
    btnCue: "cc-btn-cue",
    btnPlay: "cc-btn-play",
    btnExport: "cc-btn-export",
    btnNudgeStartMinus: "cc-btn-nudge-start-minus",
    btnNudgeStartPlus: "cc-btn-nudge-start-plus",
    btnNudgeEndMinus: "cc-btn-nudge-end-minus",
    btnNudgeEndPlus: "cc-btn-nudge-end-plus",
    muteToggle: "cc-mute-toggle",
    format: "cc-format",
    bitrate: "cc-bitrate",
    channel: "cc-channel",
    trimPanel: "cc-trim",
    trimStart: "cc-trim-start",
    trimEnd: "cc-trim-end",
    trimPreview: "cc-trim-preview",
    trimExport: "cc-trim-export",
    trimClose: "cc-trim-close",
    trimInfo: "cc-trim-info",
    trimWave: "cc-trim-wave",
    trimWaveStart: "cc-trim-wave-start",
    trimWaveEnd: "cc-trim-wave-end",
    trimZoom: "cc-trim-zoom",
    trimOffset: "cc-trim-offset"
  };

  function $(id) {
    return document.getElementById(id);
  }

  function formatTime(sec) {
    if (sec == null || Number.isNaN(sec)) return "";
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const r = (s % 60).toFixed(2).padStart(5, "0");
    return `${m}:${r}`;
  }

  function parseTime(text) {
    if (!text) return null;
    const parts = text.trim().split(":");
    if (parts.length === 1) return parseFloat(parts[0]);
    if (parts.length === 2) {
      const m = parseFloat(parts[0]);
      const s = parseFloat(parts[1]);
      if (Number.isNaN(m) || Number.isNaN(s)) return null;
      return m * 60 + s;
    }
    if (parts.length === 3) {
      const h = parseFloat(parts[0]);
      const m = parseFloat(parts[1]);
      const s = parseFloat(parts[2]);
      if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
      return h * 3600 + m * 60 + s;
    }
    return null;
  }

  function setTimeInput(id, value) {
    const el = $(id);
    if (!el) return;
    el.value = formatTime(value);
  }

  function nudgeTime(id, delta) {
    const el = $(id);
    if (!el) return;
    const t = parseTime(el.value);
    if (t == null) return setStatus("Invalid time", "error");
    const next = Math.max(0, t + delta);
    el.value = formatTime(next);
    setStatus(`Time adjusted: ${formatTime(next)}`);
  }

  function setStatus(msg, type = "") {
    const el = $(UI_IDS.status);
    if (!el) return;
    el.textContent = msg;
    el.dataset.type = type;
  }

  const getSetting = CC_SETTINGS.getSetting;
  const setSetting = CC_SETTINGS.setSetting;

  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i += 1) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function downmixToMono(audioBuffer) {
    if (!audioBuffer) return null;
    if (audioBuffer.numberOfChannels === 1) return audioBuffer;
    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const monoBuffer = new AudioBuffer({ length, numberOfChannels: 1, sampleRate });
    const out = monoBuffer.getChannelData(0);
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.getChannelData(1);
    for (let i = 0; i < length; i += 1) {
      out[i] = (ch0[i] + ch1[i]) * 0.5;
    }
    return monoBuffer;
  }

  function sliceAudioBuffer(audioBuffer, startSec, endSec) {
    const s = Math.max(0, startSec);
    const e = Math.max(s, endSec);
    const sampleRate = audioBuffer.sampleRate;
    const startFrame = Math.floor(s * sampleRate);
    const endFrame = Math.min(audioBuffer.length, Math.floor(e * sampleRate));
    const frameCount = Math.max(0, endFrame - startFrame);
    const channels = audioBuffer.numberOfChannels;
    const trimmed = new AudioBuffer({ length: frameCount, numberOfChannels: channels, sampleRate });
    for (let ch = 0; ch < channels; ch += 1) {
      const src = audioBuffer.getChannelData(ch).subarray(startFrame, endFrame);
      trimmed.getChannelData(ch).set(src);
    }
    return trimmed;
  }

  function encodeMp3FromAudioBuffer(audioBuffer, options = {}) {
    if (!window.lamejs || !window.lamejs.Mp3Encoder) {
      throw new Error("lamejs not loaded");
    }
    const bitrate = Number(options.bitrateKbps || 128);
    const wantMono = options.channelMode === "mono";
    const sourceBuffer = wantMono ? downmixToMono(audioBuffer) : audioBuffer;
    const sampleRate = sourceBuffer.sampleRate;
    const channels = Math.min(2, sourceBuffer.numberOfChannels);
    const encoder = new window.lamejs.Mp3Encoder(channels, sampleRate, bitrate);
    const left = sourceBuffer.getChannelData(0);
    const right = channels === 2 ? sourceBuffer.getChannelData(1) : null;
    const blockSize = 1152;
    const mp3Data = [];

    for (let i = 0; i < left.length; i += blockSize) {
      const leftChunk = floatTo16BitPCM(left.subarray(i, i + blockSize));
      let mp3buf;
      if (channels === 2 && right) {
        const rightChunk = floatTo16BitPCM(right.subarray(i, i + blockSize));
        mp3buf = encoder.encodeBuffer(leftChunk, rightChunk);
      } else {
        mp3buf = encoder.encodeBuffer(leftChunk);
      }
      if (mp3buf.length > 0) mp3Data.push(new Int8Array(mp3buf));
    }

    const endBuf = encoder.flush();
    if (endBuf.length > 0) mp3Data.push(new Int8Array(endBuf));
    return new Blob(mp3Data, { type: "audio/mpeg" });
  }

  async function encodeAacFromAudioBuffer(audioBuffer, options = {}) {
    const bitrate = Number(options.bitrateKbps || 128) * 1000;
    const wantMono = options.channelMode === "mono";
    const bufferToUse = wantMono ? downmixToMono(audioBuffer) : audioBuffer;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();
    const source = ctx.createBufferSource();
    source.buffer = bufferToUse;
    source.connect(dest);
    const candidates = [
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/aac"
    ];
    const mimeType = candidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
    if (!mimeType) {
      if (ctx && ctx.close) ctx.close();
      throw new Error("AAC not supported");
    }
    const recorder = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: bitrate });
    const chunks = [];
    const done = new Promise((resolve, reject) => {
      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onerror = () => reject(new Error("AAC recorder error"));
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    });
    recorder.start();
    source.start(0);
    source.onended = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
    const blob = await done;
    if (ctx && ctx.close) ctx.close();
    return blob;
  }

  async function playAudioBufferSegment(audioBuffer, startSec, endSec) {
    if (!audioBuffer) return;
    const s = Math.max(0, startSec);
    const e = Math.max(s, endSec);
    if (STATE.previewContext) {
      try {
        STATE.previewContext.source.stop();
      } catch (_) {
        // ignore
      }
      try {
        STATE.previewContext.ctx.close();
      } catch (_) {
        // ignore
      }
      STATE.previewContext = null;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    STATE.previewContext = { ctx, source };
    source.start(0, s, Math.max(0.01, e - s));
    await new Promise(resolve => {
      source.onended = resolve;
    });
    if (ctx && ctx.close) ctx.close();
    STATE.previewContext = null;
  }

  function getExportSettings() {
    const format = $(UI_IDS.format)?.value || "mp3";
    const bitrate = Number($(UI_IDS.bitrate)?.value || 128);
    const channelMode = $(UI_IDS.channel)?.value || "stereo";
    return { format, bitrate, channelMode };
  }

  function setTrimPanelVisible(visible) {
    const panel = $(UI_IDS.trimPanel);
    if (!panel) return;
    STATE.trimVisible = visible;
    panel.style.display = visible ? "block" : "none";
  }

  function updateTrimInfo() {
    const info = $(UI_IDS.trimInfo);
    if (!info || !STATE.lastBuffer) return;
    const dur = STATE.lastBuffer.duration || 0;
    info.textContent = `Recorded ${dur.toFixed(2)}s`;
  }

  function clampTrimRange(start, end, duration) {
    let s = Math.max(0, start);
    let e = Math.max(s + 0.01, end);
    if (duration > 0 && e > duration) e = duration;
    if (duration > 0 && s > duration - 0.01) s = Math.max(0, duration - 0.01);
    if (e <= s) e = Math.min(duration, s + 0.01);
    return { start: s, end: e };
  }

  function chooseTickStep(windowDur) {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const target = windowDur / 6;
    for (const step of steps) {
      if (step >= target) return step;
    }
    return 600;
  }

  function renderWaveform(audioBuffer) {
    const canvas = $(UI_IDS.trimWave);
    if (!canvas || !audioBuffer) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cssWidth = canvas.clientWidth || 280;
    const cssHeight = canvas.clientHeight || 80;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    const width = cssWidth;
    const height = cssHeight;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, 0, width, height);

    const data = audioBuffer.getChannelData(0);
    const dur = audioBuffer.duration || 0;
    const zoom = Math.max(1, Number(STATE.waveZoom || 1));
    const windowDur = Math.max(0.01, dur / zoom);
    const maxOffset = Math.max(0, dur - windowDur);
    const offset = Math.min(maxOffset, Math.max(0, Number(STATE.waveOffset || 0)));
    STATE.waveOffset = offset;
    const startFrame = Math.floor(offset * audioBuffer.sampleRate);
    const endFrame = Math.min(audioBuffer.length, Math.floor((offset + windowDur) * audioBuffer.sampleRate));
    const windowLen = Math.max(1, endFrame - startFrame);
    const step = Math.max(1, Math.floor(windowLen / width));
    const amp = height / 2;
    ctx.strokeStyle = "rgba(143,227,255,0.9)";
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const start = startFrame + x * step;
      let min = 1.0;
      let max = -1.0;
      for (let i = 0; i < step; i += 1) {
        const v = data[start + i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      ctx.moveTo(x + 0.5, (1 + min) * amp);
      ctx.lineTo(x + 0.5, (1 + max) * amp);
    }
    ctx.stroke();

    // overlay trim window
    if (dur > 0) {
      const s = (STATE.trimStart - offset) / windowDur;
      const e = (STATE.trimEnd - offset) / windowDur;
      const clampedS = Math.max(0, Math.min(1, s));
      const clampedE = Math.max(0, Math.min(1, e));
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, width * clampedS, height);
      ctx.fillRect(width * clampedE, 0, width * (1 - clampedE), height);
      ctx.fillStyle = "rgba(255,210,122,0.85)";
      ctx.fillRect(width * clampedS - 1, 0, 2, height);
      ctx.fillRect(width * clampedE - 1, 0, 2, height);
    }

    // time ticks
    if (dur > 0) {
      const stepSec = chooseTickStep(windowDur);
      const firstTick = Math.ceil(offset / stepSec) * stepSec;
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = "10px sans-serif";
      ctx.textBaseline = "top";
      for (let t = firstTick; t <= offset + windowDur + 0.0001; t += stepSec) {
        const x = ((t - offset) / windowDur) * width;
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
        const label = formatTime(t);
        ctx.fillText(label, Math.min(width - 30, x + 2), 2);
      }
    }
  }

  function getWaveWindow() {
    const dur = STATE.lastBuffer ? (STATE.lastBuffer.duration || 0) : 0;
    const zoom = Math.max(1, Number(STATE.waveZoom || 1));
    const windowDur = Math.max(0.01, dur / zoom);
    const maxOffset = Math.max(0, dur - windowDur);
    const offset = Math.min(maxOffset, Math.max(0, Number(STATE.waveOffset || 0)));
    return { dur, zoom, windowDur, maxOffset, offset };
  }

  function updateWavePanRange() {
    const pan = $(UI_IDS.trimOffset);
    if (!pan) return;
    const { maxOffset, offset } = getWaveWindow();
    pan.max = maxOffset.toFixed(2);
    pan.value = offset.toFixed(2);
  }

  function timeFromCanvasX(clientX) {
    const canvas = $(UI_IDS.trimWave);
    if (!canvas || !STATE.lastBuffer) return 0;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const { offset, windowDur } = getWaveWindow();
    return offset + (x / rect.width) * windowDur;
  }

  function syncTrimControlsFromState() {
    const startInput = $(UI_IDS.trimStart);
    const endInput = $(UI_IDS.trimEnd);
    const startRange = $(UI_IDS.trimWaveStart);
    const endRange = $(UI_IDS.trimWaveEnd);
    if (startInput) startInput.value = STATE.trimStart.toFixed(2);
    if (endInput) endInput.value = STATE.trimEnd.toFixed(2);
    if (startRange) startRange.value = STATE.trimStart.toFixed(2);
    if (endRange) endRange.value = STATE.trimEnd.toFixed(2);
    renderWaveform(STATE.lastBuffer);
  }

  function applyTrimFromInputs(startVal, endVal) {
    if (!STATE.lastBuffer) return;
    const dur = STATE.lastBuffer.duration || 0;
    const next = clampTrimRange(startVal, endVal, dur);
    STATE.trimStart = next.start;
    STATE.trimEnd = next.end;
    syncTrimControlsFromState();
  }

  function stopSegmentPlayback(video) {
    if (STATE.segmentPlayback) {
      video.removeEventListener("timeupdate", STATE.segmentPlayback.onTime);
      clearTimeout(STATE.segmentPlayback.timeoutId);
      STATE.segmentPlayback = null;
    }
    if (!video.paused) video.pause();
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    if (vids.length === 0) return null;
    return vids.find(v => v.readyState >= 1) || vids[0];
  }

  function getActiveCueAt(video, time) {
    if (!video) return null;
    const tracks = Array.from(video.textTracks || []).filter(t => t.mode !== "disabled");
    for (const track of tracks) {
      const cues = track.cues || [];
      for (let i = 0; i < cues.length; i += 1) {
        const cue = cues[i];
        if (time >= cue.startTime && time <= cue.endTime) {
          return cue;
        }
      }
    }
    return null;
  }

  function collectTextTrackCuesInRange(video, start, end) {
    if (!video || !video.textTracks) return [];
    const tracks = Array.from(video.textTracks || []);
    const showing = tracks.filter(t => t.mode === "showing");
    const usable = showing.length ? showing : tracks.filter(t => t.mode !== "disabled");
    if (!usable.length) return [];
    const chosen = usable[0];
    const results = [];
    const cues = chosen.cues || [];
    for (let i = 0; i < cues.length; i += 1) {
      const cue = cues[i];
      const s = cue.startTime ?? 0;
      const e = cue.endTime ?? 0;
      if (e >= start && s <= end) {
        const raw = cueTextToLine(cue.text || "");
        const line = normalizeCaptionText(raw);
        if (!line) continue;
        const prev = results.length ? results[results.length - 1] : null;
        if (prev && prev.text === line && s - prev.end <= 0.4) {
          prev.end = Math.max(prev.end, e);
          continue;
        }
        if (prev) {
          const merged = mergeOverlappingText(prev.text, line, 2);
          if (merged) {
            prev.text = merged;
            prev.end = Math.max(prev.end, e);
            continue;
          }
        }
        results.push({ start: s, end: e, text: line });
      }
    }
    return results;
  }

  function getBiliSubtitleText() {
    const selectors = [
      ".bpx-player-subtitle-text span",
      ".bpx-player-subtitle-text",
      ".bpx-player-subtitle-content span",
      ".bpx-player-subtitle-content",
      ".bpx-player-video-subtitle",
      ".bilibili-player-subtitle .bilibili-player-subtitle-text",
      ".subtitle .subtitle-text",
      ".subtitle-text"
    ];
    const parts = [];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (!nodes || nodes.length === 0) continue;
      nodes.forEach(n => {
        if (!isVisible(n)) return;
        const t = n.textContent ? n.textContent.trim() : "";
        if (t) parts.push(t);
      });
      if (parts.length) break;
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function collapseRepeatedTokens(text) {
    if (!text) return "";
    const tokens = text.split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < tokens.length; ) {
      let collapsed = false;
      const maxLen = Math.min(12, Math.floor((tokens.length - i) / 2));
      for (let len = maxLen; len >= 2; len -= 1) {
        let same = true;
        for (let j = 0; j < len; j += 1) {
          if (tokens[i + j] !== tokens[i + len + j]) {
            same = false;
            break;
          }
        }
        if (!same) continue;
        out.push(...tokens.slice(i, i + len));
        i += len;
        while (i + len <= tokens.length) {
          let repeat = true;
          for (let j = 0; j < len; j += 1) {
            if (tokens[i + j] !== tokens[i - len + j]) {
              repeat = false;
              break;
            }
          }
          if (!repeat) break;
          i += len;
        }
        collapsed = true;
        break;
      }
      if (!collapsed) {
        out.push(tokens[i]);
        i += 1;
      }
    }
    return out.join(" ").trim();
  }

  function getYouTubeSubtitleText() {
    const video = findVideo();
    if (video && video.textTracks && video.textTracks.length) {
      ensureTracksEnabled(video);
      const cue = getActiveCueAt(video, video.currentTime);
      if (cue && cue.text) {
        return cueTextToLine(cue.text);
      }
    }

    const containerSelectors = [
      ".caption-window",
      ".ytp-caption-window-container",
      ".ytp-caption-window"
    ];
    const containers = [];
    containerSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(n => {
        if (isVisible(n)) containers.push(n);
      });
    });

    const isMostlyVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const op = parseFloat(style.opacity || "1");
      if (Number.isNaN(op) || op < 0.2) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const pickBestContainer = (list) => {
      if (!list.length) return null;
      let best = null;
      let bestScore = -Infinity;
      const viewportBottom = window.innerHeight || 0;
      const video = findVideo();
      const videoRect = video ? video.getBoundingClientRect() : null;
      list.forEach(el => {
        if (!isMostlyVisible(el)) return;
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        let intersection = 0;
        if (videoRect) {
          const left = Math.max(rect.left, videoRect.left);
          const right = Math.min(rect.right, videoRect.right);
          const top = Math.max(rect.top, videoRect.top);
          const bottom = Math.min(rect.bottom, videoRect.bottom);
          if (right > left && bottom > top) {
            intersection = (right - left) * (bottom - top);
          }
        }
        const bottomBias = rect.bottom / Math.max(1, viewportBottom);
        const segments = el.querySelectorAll(".ytp-caption-segment").length;
        const score = intersection * 2 + bottomBias * 1000 + area + segments * 10;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      });
      return best;
    };

    const collectFromContainer = (container) => {
      const nodes = Array.from(container.querySelectorAll(".ytp-caption-segment"));
      const entries = [];
      nodes.forEach(n => {
        if (!isMostlyVisible(n)) return;
        const t = n.textContent ? n.textContent.trim() : "";
        if (!t) return;
        const rect = n.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const row = Math.round(rect.top);
        const col = Math.round(rect.left);
        const key = `${t}|${row}|${col}`;
        entries.push({ text: t, key, row, col });
      });
      if (entries.length) {
        const seen = new Set();
        const deduped = entries.filter(e => {
          if (seen.has(e.key)) return false;
          seen.add(e.key);
          return true;
        });
        deduped.sort((a, b) => (a.row - b.row) || (a.col - b.col));
        const rows = new Map();
        deduped.forEach(e => {
          if (!rows.has(e.row)) rows.set(e.row, []);
          rows.get(e.row).push(e);
        });
        const lines = Array.from(rows.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([_, list]) => list.sort((a, b) => a.col - b.col).map(i => i.text).join(" "));
        const text = lines.join(" ").replace(/\s+/g, " ").trim();
        return collapseRepeatedTokens(text);
      }
      const fallback = container.textContent ? container.textContent.trim() : "";
      return collapseRepeatedTokens(fallback.replace(/\s+/g, " ").trim());
    };

    const pickBestByScore = (list) => {
      if (!list.length) return null;
      let best = null;
      let bestScore = -Infinity;
      const viewportBottom = window.innerHeight || 0;
      list.forEach(el => {
        if (!isMostlyVisible(el)) return;
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        const bottomBias = rect.bottom / Math.max(1, viewportBottom);
        const segments = el.querySelectorAll(".ytp-caption-segment").length;
        const score = bottomBias * 1000 + segments * 10 - area * 0.01;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      });
      return best;
    };

    const captionWindows = Array.from(document.querySelectorAll(".caption-window")).filter(isMostlyVisible);
    if (captionWindows.length) {
      const bestWindow = pickBestByScore(captionWindows) || captionWindows[0];
      const text = collectFromContainer(bestWindow);
      if (text) return text;
    }

    if (containers.length) {
      const bestContainer = pickBestContainer(containers) || containers[0];
      const text = collectFromContainer(bestContainer);
      if (text) return text;
    }

    const parts = [];
    const seen = new Set();
    document.querySelectorAll(".ytp-caption-segment").forEach(n => {
      if (!isVisible(n)) return;
      const t = n.textContent ? n.textContent.trim() : "";
      if (!t) return;
      const rect = n.getBoundingClientRect();
      const key = `${t}|${Math.round(rect.top)}|${Math.round(rect.left)}`;
      if (seen.has(key)) return;
      seen.add(key);
      parts.push({ text: t, top: rect.top, left: rect.left });
    });
    parts.sort((a, b) => (a.top - b.top) || (a.left - b.left));
    const text = parts.map(p => p.text).join(" ").replace(/\s+/g, " ").trim();
    return collapseRepeatedTokens(text);
  }

  function cueTextToLine(text) {
    if (!text) return "";
    const t = String(text).replace(/\n+/g, " ");
    return t.replace(/\s+/g, " ").trim();
  }

  function normalizeCaptionText(text) {
    if (!text) return "";
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return "";
    if (/^字幕( 字幕)*$/.test(t)) return "";
    const tokens = t.split(" ").filter(Boolean);
    const cleaned = [];
    let last = "";
    for (const tok of tokens) {
      if (tok === "字幕" || tok.toLowerCase() === "caption") continue;
      if (tok === last) continue;
      cleaned.push(tok);
      last = tok;
    }
    const out = cleaned.join(" ").trim();
    if (/^字幕( 字幕)*$/.test(out)) return "";
    return out;
  }

  function mergeOverlappingText(prev, next, minTokens = 2) {
    if (!prev || !next) return "";
    const a = prev.split(" ").filter(Boolean);
    const b = next.split(" ").filter(Boolean);
    if (!a.length || !b.length) return "";
    const max = Math.min(a.length, b.length);
    for (let len = max; len >= minTokens; len -= 1) {
      let match = true;
      for (let j = 0; j < len; j += 1) {
        if (a[a.length - len + j] !== b[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        return a.concat(b.slice(len)).join(" ").trim();
      }
    }
    return "";
  }

  function getCaptionTextFromContainer(container) {
    if (!container) return "";
    const nodes = container.querySelectorAll("[class*='subtitle'], [class*='caption']");
    const parts = [];
    nodes.forEach(n => {
      if (!isVisible(n)) return;
      const t = n.textContent ? n.textContent.trim() : "";
      if (t && t.length < 200) parts.push(t);
    });
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function sanitizeFilename(text) {
    if (!text) return "";
    const cleaned = text
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      .replace(/[. ]+$/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "";
    const upper = cleaned.toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(upper)) {
      return `${cleaned}_`;
    }
    return cleaned;
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function normalizeUrl(url) {
    if (!url) return "";
    if (url.startsWith("//")) return `https:${url}`;
    return url;
  }

  async function loadBiliSubtitles() {
    if (STATE.biliSubtitleCache) return STATE.biliSubtitleCache;
    const playinfo = window.__playinfo__ || window.__INITIAL_STATE__?.playinfo;
    const list =
      playinfo?.data?.subtitle?.subtitle ||
      window.__INITIAL_STATE__?.videoData?.subtitle?.list ||
      [];
    if (!Array.isArray(list) || list.length === 0) return null;

    const pick =
      list.find(s => /zh/i.test(s.lan)) ||
      list.find(s => /en/i.test(s.lan)) ||
      list[0];
    const url = normalizeUrl(pick?.url);
    if (!url) return null;

    try {
      let resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) {
        resp = await fetch(url, { credentials: "omit" });
      }
      if (!resp.ok) return null;
      const json = await resp.json();
      const body = json?.body;
      if (!Array.isArray(body)) return null;
      const cues = body.map(item => ({
        start: item.from ?? item.start ?? 0,
        end: item.to ?? item.end ?? 0,
        text: item.content || item.text || ""
      }));
      STATE.biliSubtitleCache = cues;
      return cues;
    } catch (_) {
      return null;
    }
  }

  function findCueFromList(list, time) {
    if (!Array.isArray(list)) return null;
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      if (time >= c.start && time <= c.end) return c;
    }
    return null;
  }

  function collectCuesInRange(list, start, end) {
    if (!Array.isArray(list)) return [];
    return list.filter(c => {
      const s = c.start ?? 0;
      const e = c.end ?? 0;
      return e >= start && s <= end;
    });
  }

  async function collectOnScreenSubtitlesInRange(video, start, end) {
    const playerContainer =
      document.querySelector(".bpx-player-container") ||
      document.querySelector("#bilibili-player") ||
      document.querySelector(".bilibili-player") ||
      document.querySelector("#movie_player");
    const getText = () => {
      const t = getBiliSubtitleText() || getYouTubeSubtitleText() || getCaptionTextFromContainer(playerContainer);
      return normalizeCaptionText(t);
    };

    const preState = {
      time: video.currentTime,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      playbackRate: video.playbackRate
    };
    const shouldMute = $(UI_IDS.muteToggle)?.checked !== false;
    if (shouldMute) {
      video.muted = true;
      video.volume = 0;
    }
    video.playbackRate = 1.0;
    video.currentTime = start;
    await video.play();

    const lines = [];
    let currentText = "";
    let currentSince = performance.now();
    let lastEmitted = "";
    const minStableMs = 200;

    const emitIfStable = (text, now) => {
      if (!text) return;
      const dur = now - currentSince;
      if (dur < minStableMs) return;
      if (text === lastEmitted) return;
      const prev = lines.length ? lines[lines.length - 1] : "";
      if (prev && text.startsWith(prev)) {
        lines[lines.length - 1] = text;
      } else if (prev) {
        const merged = mergeOverlappingText(prev, text, 2);
        if (merged) {
          lines[lines.length - 1] = merged;
        } else if (!prev.startsWith(text)) {
          lines.push(text);
        }
      } else {
        lines.push(text);
      }
      lastEmitted = text;
    };

    const sample = () => {
      const now = performance.now();
      const t = getText();
      if (!t) {
        emitIfStable(currentText, now);
        currentText = "";
        currentSince = now;
        return;
      }
      if (t !== currentText) {
        emitIfStable(currentText, now);
        currentText = t;
        currentSince = now;
        return;
      }
    };

    const sampleTimer = setInterval(sample, 120);
    const stopAt = end;
    const result = await new Promise(resolve => {
      const onTime = () => {
        if (video.currentTime >= stopAt) {
          video.removeEventListener("timeupdate", onTime);
          resolve(null);
        }
      };
      video.addEventListener("timeupdate", onTime);
      setTimeout(() => {
        video.removeEventListener("timeupdate", onTime);
        resolve(null);
      }, Math.max(0, (end - start) * 1000) + 2000);
    });
    void result;
    clearInterval(sampleTimer);
    emitIfStable(currentText, performance.now());
    video.pause();
    video.currentTime = preState.time;
    video.muted = preState.muted;
    video.volume = preState.volume;
    video.playbackRate = preState.playbackRate;
    // Keep paused after subtitle collection to avoid surprising playback.
    return lines;
  }

  function ensureTracksEnabled(video) {
    if (!video || !video.textTracks) return;
    Array.from(video.textTracks).forEach(t => {
      if (t.mode === "disabled") t.mode = "hidden";
    });
  }

  function buildUI() {
    if ($(UI_IDS.root)) return;
    const root = document.createElement("div");
    root.id = UI_IDS.root;
    root.innerHTML = `
      <div class="cc-header">
        <div class="cc-title">CardCutter</div>
        <div class="cc-subtitle">Clip audio + CC</div>
      </div>
      <div class="cc-row">
        <label>Start</label>
        <input id="${UI_IDS.start}" type="text" placeholder="0:00.00" />
        <button id="${UI_IDS.btnStart}">Set Start</button>
      </div>
      <div class="cc-row">
        <label>End</label>
        <input id="${UI_IDS.end}" type="text" placeholder="0:05.00" />
        <button id="${UI_IDS.btnEnd}">Set End</button>
      </div>
      <div class="cc-row cc-nudge">
        <label>Nudge</label>
        <div class="cc-nudge-wrap">
          <div class="cc-nudge-group">
            <span>Start</span>
            <button id="${UI_IDS.btnNudgeStartMinus}" data-delta="-0.1">-0.1s</button>
            <button id="${UI_IDS.btnNudgeStartPlus}" data-delta="0.1">+0.1s</button>
          </div>
          <div class="cc-nudge-group">
            <span>End</span>
            <button id="${UI_IDS.btnNudgeEndMinus}" data-delta="-0.1">-0.1s</button>
            <button id="${UI_IDS.btnNudgeEndPlus}" data-delta="0.1">+0.1s</button>
          </div>
        </div>
      </div>
      <div class="cc-row">
        <label>Subtitle</label>
        <textarea id="${UI_IDS.subtitle}" rows="3" placeholder="Use current CC or edit"></textarea>
      </div>
      <div class="cc-row cc-actions">
        <button id="${UI_IDS.btnCue}">Use Current CC</button>
        <button id="${UI_IDS.btnPlay}">Play Segment</button>
        <button id="${UI_IDS.btnExport}">Record</button>
      </div>
      <div class="cc-row cc-options">
        <label>Record</label>
        <label class="cc-checkbox">
          <input id="${UI_IDS.muteToggle}" type="checkbox" />
          Mute while recording
        </label>
      </div>
      <div class="cc-row cc-export">
        <label>Format</label>
        <select id="${UI_IDS.format}">
          <option value="mp3">MP3</option>
          <option value="aac">AAC (m4a)</option>
        </select>
        <select id="${UI_IDS.bitrate}">
          <option value="64">64 kbps</option>
          <option value="96">96 kbps</option>
          <option value="128" selected>128 kbps</option>
          <option value="192">192 kbps</option>
        </select>
      </div>
      <div class="cc-row cc-export">
        <label>Channel</label>
        <select id="${UI_IDS.channel}">
          <option value="stereo">Stereo</option>
          <option value="mono">Mono</option>
        </select>
        <div class="cc-note">Export settings</div>
      </div>
      <div id="${UI_IDS.trimPanel}" class="cc-trim">
        <div class="cc-trim-title">Trim Audio</div>
        <canvas id="${UI_IDS.trimWave}" width="280" height="80"></canvas>
        <div class="cc-wave-controls">
          <label>Zoom</label>
          <input id="${UI_IDS.trimZoom}" type="range" min="1" max="8" step="0.5" value="1" />
          <label>Pan</label>
          <input id="${UI_IDS.trimOffset}" type="range" min="0" max="0" step="0.1" value="0" />
        </div>
        <div class="cc-wave-sliders">
          <input id="${UI_IDS.trimWaveStart}" type="range" min="0" max="0" step="0.01" value="0" />
          <input id="${UI_IDS.trimWaveEnd}" type="range" min="0" max="0" step="0.01" value="0" />
        </div>
        <div class="cc-row cc-trim-row">
          <label>Start</label>
          <input id="${UI_IDS.trimStart}" type="text" placeholder="0.00" />
          <span>s</span>
        </div>
        <div class="cc-row cc-trim-row">
          <label>End</label>
          <input id="${UI_IDS.trimEnd}" type="text" placeholder="0.00" />
          <span>s</span>
        </div>
        <div class="cc-row cc-trim-actions">
          <button id="${UI_IDS.trimPreview}">Preview</button>
          <button id="${UI_IDS.trimExport}">Export Clip</button>
          <button id="${UI_IDS.trimClose}">Close</button>
        </div>
        <div id="${UI_IDS.trimInfo}" class="cc-trim-info"></div>
      </div>
      <div id="${UI_IDS.status}" class="cc-status">Ready</div>
    `;
    document.body.appendChild(root);
    STATE.built = true;
    root.style.display = STATE.visible ? "block" : "none";
    setTrimPanelVisible(false);

    $(UI_IDS.btnStart).addEventListener("click", () => {
      const video = findVideo();
      if (!video) return setStatus("No video found", "error");
      STATE.start = video.currentTime;
      setTimeInput(UI_IDS.start, STATE.start);
      setStatus(`Start set: ${formatTime(STATE.start)}`);
    });

    $(UI_IDS.btnEnd).addEventListener("click", () => {
      const video = findVideo();
      if (!video) return setStatus("No video found", "error");
      STATE.end = video.currentTime;
      setTimeInput(UI_IDS.end, STATE.end);
      setStatus(`End set: ${formatTime(STATE.end)}`);
    });

    $(UI_IDS.btnCue).addEventListener("click", async () => {
      const video = findVideo();
      if (!video) return setStatus("No video found", "error");
      const startInput = parseTime($(UI_IDS.start).value);
      const endInput = parseTime($(UI_IDS.end).value);
      const hasRange = startInput != null && endInput != null && endInput > startInput;
      const rangeInputProvided = $(UI_IDS.start).value.trim() || $(UI_IDS.end).value.trim();
      if (rangeInputProvided && !hasRange) {
        return setStatus("Invalid start/end", "error");
      }
      ensureTracksEnabled(video);
      const cue = getActiveCueAt(video, video.currentTime);
      if (!hasRange && cue) {
        STATE.lastCue = cue;
        STATE.start = cue.startTime;
        STATE.end = cue.endTime;
        STATE.subtitle = cue.text || "";
        setTimeInput(UI_IDS.start, STATE.start);
        setTimeInput(UI_IDS.end, STATE.end);
        $(UI_IDS.subtitle).value = STATE.subtitle;
        setStatus("Loaded current CC cue");
        return;
      }

      const now = video.currentTime;
      const biliList = await loadBiliSubtitles();
      if (hasRange && biliList && biliList.length) {
        const inRange = collectCuesInRange(biliList, startInput, endInput);
        if (inRange.length) {
          STATE.subtitle = inRange.map(c => c.text).join(" ").replace(/\s+/g, " ").trim();
          $(UI_IDS.subtitle).value = STATE.subtitle;
          setStatus("Loaded subtitles in range");
          return;
        }
      }

      if (hasRange) {
        let trackCues = collectTextTrackCuesInRange(video, startInput, endInput);
        if (!trackCues.length) {
          ensureTracksEnabled(video);
          await wait(300);
          trackCues = collectTextTrackCuesInRange(video, startInput, endInput);
        }
        if (trackCues.length) {
          STATE.subtitle = trackCues.map(c => c.text).join(" ").replace(/\s+/g, " ").trim();
          $(UI_IDS.subtitle).value = STATE.subtitle;
          setStatus("Loaded subtitles in range");
          return;
        }
      }

      if (!hasRange && biliList && biliList.length) {
        const biliCue = findCueFromList(biliList, now);
        if (biliCue && biliCue.text) {
          STATE.subtitle = biliCue.text;
          STATE.start = biliCue.start;
          STATE.end = biliCue.end;
          setTimeInput(UI_IDS.start, STATE.start);
          setTimeInput(UI_IDS.end, STATE.end);
          $(UI_IDS.subtitle).value = STATE.subtitle;
          setStatus("Loaded Bilibili subtitle cue");
          return;
        }
      }

      const biliText = getBiliSubtitleText();
      const ytText = getYouTubeSubtitleText();
      const playerContainer =
        document.querySelector(".bpx-player-container") ||
        document.querySelector("#bilibili-player") ||
        document.querySelector(".bilibili-player") ||
        document.querySelector("#movie_player");
      const containerText = getCaptionTextFromContainer(playerContainer);
      const fallbackText = normalizeCaptionText(biliText || ytText || containerText);
      if (!hasRange) {
        if (!fallbackText) return setStatus("No subtitles found. Please enable CC/字幕开关.", "warn");
        STATE.subtitle = fallbackText;
        $(UI_IDS.subtitle).value = STATE.subtitle;
        STATE.start = Math.max(0, now);
        STATE.end = Math.max(STATE.start + 2.0, now + 2.0);
        setTimeInput(UI_IDS.start, STATE.start);
        setTimeInput(UI_IDS.end, STATE.end);
        setStatus("Loaded on-screen subtitle text");
      } else {
        setStatus("Collecting subtitles from on-screen text...", "busy");
        const lines = await collectOnScreenSubtitlesInRange(video, startInput, endInput);
        if (lines && lines.length) {
          STATE.subtitle = lines.join(" ").replace(/\s+/g, " ").trim();
          $(UI_IDS.subtitle).value = STATE.subtitle;
          setStatus("Loaded subtitles in range");
        } else if (fallbackText) {
          STATE.subtitle = fallbackText;
          $(UI_IDS.subtitle).value = STATE.subtitle;
          setStatus("Range set, but only current on-screen text found", "warn");
        } else {
          setStatus("No subtitles found. Please enable CC/字幕开关.", "warn");
        }
      }
    });

    $(UI_IDS.btnNudgeStartMinus).addEventListener("click", () => nudgeTime(UI_IDS.start, -0.1));
    $(UI_IDS.btnNudgeStartPlus).addEventListener("click", () => nudgeTime(UI_IDS.start, 0.1));
    $(UI_IDS.btnNudgeEndMinus).addEventListener("click", () => nudgeTime(UI_IDS.end, -0.1));
    $(UI_IDS.btnNudgeEndPlus).addEventListener("click", () => nudgeTime(UI_IDS.end, 0.1));

    $(UI_IDS.btnPlay).addEventListener("click", async () => {
      const video = findVideo();
      if (!video) return setStatus("No video found", "error");
      const start = parseTime($(UI_IDS.start).value);
      const end = parseTime($(UI_IDS.end).value);
      if (start == null || end == null || end <= start) {
        return setStatus("Invalid start/end", "error");
      }
      stopSegmentPlayback(video);
      video.currentTime = start;
      await video.play();
      setStatus("Playing segment...");
      const stopAt = end;
      const onTime = () => {
        if (video.currentTime >= stopAt) {
          video.pause();
          video.removeEventListener("timeupdate", onTime);
          if (STATE.segmentPlayback) {
            clearTimeout(STATE.segmentPlayback.timeoutId);
            STATE.segmentPlayback = null;
          }
          setStatus("Segment playback done");
        }
      };
      video.addEventListener("timeupdate", onTime);
      const timeoutId = setTimeout(() => {
        video.removeEventListener("timeupdate", onTime);
        if (!video.paused) video.pause();
        STATE.segmentPlayback = null;
        setStatus("Segment playback done");
      }, Math.max(0, (end - start) * 1000) + 1500);
      STATE.segmentPlayback = { onTime, timeoutId };
    });

    $(UI_IDS.btnExport).addEventListener("click", async () => {
      const video = findVideo();
      if (!video) return setStatus("No video found", "error");
      const start = parseTime($(UI_IDS.start).value);
      const end = parseTime($(UI_IDS.end).value);
      const subtitle = $(UI_IDS.subtitle).value.trim();
      if (!subtitle) return setStatus("Subtitle required", "error");
      if (start == null || end == null || end <= start) {
        return setStatus("Invalid start/end", "error");
      }
      if (STATE.recording) return setStatus("Already recording", "error");

      const stream = video.captureStream ? video.captureStream() : null;
      if (!stream) return setStatus("captureStream not supported", "error");

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) return setStatus("No audio tracks", "error");

      const mimeCandidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"];
      const mimeType = mimeCandidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
      if (!mimeType) return setStatus("No supported audio recorder type", "error");

      const recorder = new MediaRecorder(new MediaStream(audioTracks), { mimeType });
      STATE.recording = true;
      STATE.chunks = [];

      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) STATE.chunks.push(e.data);
      };

      recorder.onstop = async () => {
        STATE.recording = false;
        try {
          const blob = new Blob(STATE.chunks, { type: mimeType || "audio/webm" });
          const arrayBuffer = await blob.arrayBuffer();
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
          if (ctx && ctx.close) ctx.close();
          STATE.lastBuffer = audioBuffer;
          STATE.lastRecordStart = recordStart;
          STATE.lastRecordEnd = recordEnd;
          STATE.lastSubtitle = subtitle;
          STATE.trimStart = Math.max(0, start - recordStart);
          STATE.trimEnd = Math.max(STATE.trimStart + 0.01, end - recordStart);
          const dur = STATE.lastBuffer.duration || 0;
          const rangeStart = $(UI_IDS.trimWaveStart);
          const rangeEnd = $(UI_IDS.trimWaveEnd);
          if (rangeStart) {
            rangeStart.max = dur.toFixed(2);
          }
          if (rangeEnd) {
            rangeEnd.max = dur.toFixed(2);
          }
          STATE.waveZoom = 1;
          STATE.waveOffset = 0;
          const zoomEl = $(UI_IDS.trimZoom);
          if (zoomEl) zoomEl.value = "1";
          updateWavePanRange();
          syncTrimControlsFromState();
          updateTrimInfo();
          setTrimPanelVisible(true);
          setStatus("Recording done. Trim and export.", "busy");
        } catch (err) {
          const fallbackBlob = new Blob(STATE.chunks, { type: mimeType || "audio/webm" });
          const ext = mimeType.includes("ogg") ? "ogg" : "webm";
          const safeName = sanitizeFilename(subtitle) || "clip";
          const filename = `${safeName}.${ext}`;
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result;
            chrome.runtime.sendMessage({ type: "download", dataUrl, filename });
          };
          reader.readAsDataURL(fallbackBlob);
          setStatus(`MP3 encode failed, exported ${filename}`, "warn");
        }
      };

      const preState = {
        time: video.currentTime,
        paused: video.paused,
        muted: video.muted,
        volume: video.volume,
        playbackRate: video.playbackRate
      };
      const shouldMute = $(UI_IDS.muteToggle)?.checked === true;
      const pad = 1.0;
      const recordStart = Math.max(0, start - pad);
      const recordEnd = Math.max(recordStart + 0.01, end + pad);

      setStatus("Recording...", "busy");
      if (shouldMute) {
        video.muted = true;
        video.volume = 0;
      }
      video.playbackRate = 1.0;
      video.currentTime = recordStart;
      await video.play();
      recorder.start();

      const stopAt = recordEnd;
      const onTime = () => {
        if (video.currentTime >= stopAt) {
          video.removeEventListener("timeupdate", onTime);
          recorder.stop();
          video.pause();
          video.currentTime = preState.time;
          video.muted = preState.muted;
          video.volume = preState.volume;
          video.playbackRate = preState.playbackRate;
          if (!preState.paused) video.play();
        }
      };
      video.addEventListener("timeupdate", onTime);

      setTimeout(() => {
        if (STATE.recording) {
          video.removeEventListener("timeupdate", onTime);
          recorder.stop();
          video.pause();
          video.currentTime = preState.time;
          video.muted = preState.muted;
          video.volume = preState.volume;
          video.playbackRate = preState.playbackRate;
          if (!preState.paused) video.play();
        }
      }, Math.max(0, (recordEnd - recordStart) * 1000) + 2000);
    });

    $(UI_IDS.subtitle).addEventListener("input", e => {
      STATE.subtitle = e.target.value;
    });

    $(UI_IDS.muteToggle).addEventListener("change", e => {
      setSetting("muteRecording", e.target.checked === true);
    });

    $(UI_IDS.format).addEventListener("change", e => {
      setSetting("exportFormat", e.target.value);
    });
    $(UI_IDS.bitrate).addEventListener("change", e => {
      setSetting("exportBitrate", Number(e.target.value));
    });
    $(UI_IDS.channel).addEventListener("change", e => {
      setSetting("exportChannel", e.target.value);
    });

    $(UI_IDS.trimPreview).addEventListener("click", async () => {
      if (!STATE.lastBuffer) return setStatus("No recorded audio", "error");
      const s = parseTime($(UI_IDS.trimStart).value);
      const e = parseTime($(UI_IDS.trimEnd).value);
      if (s == null || e == null || e <= s) return setStatus("Invalid trim range", "error");
      setStatus("Previewing trim...", "busy");
      await playAudioBufferSegment(STATE.lastBuffer, s, e);
      setStatus("Preview done");
    });

    $(UI_IDS.trimExport).addEventListener("click", async () => {
      if (!STATE.lastBuffer) return setStatus("No recorded audio", "error");
      const s = parseTime($(UI_IDS.trimStart).value);
      const e = parseTime($(UI_IDS.trimEnd).value);
      if (s == null || e == null || e <= s) return setStatus("Invalid trim range", "error");
      const subtitle = $(UI_IDS.subtitle).value.trim();
      if (!subtitle) return setStatus("Subtitle required", "error");
      STATE.lastSubtitle = subtitle;
      const settings = getExportSettings();
      const trimmed = sliceAudioBuffer(STATE.lastBuffer, s, e);
      try {
        setStatus(`Encoding ${settings.format.toUpperCase()}...`, "busy");
        let outBlob;
        let ext = "mp3";
        if (settings.format === "aac") {
          outBlob = await encodeAacFromAudioBuffer(trimmed, settings);
          ext = "m4a";
        } else {
          outBlob = encodeMp3FromAudioBuffer(trimmed, settings);
          ext = "mp3";
        }
        const safeName = sanitizeFilename(STATE.lastSubtitle) || "clip";
        const filename = `${safeName}.${ext}`;
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result;
          chrome.runtime.sendMessage({ type: "download", dataUrl, filename });
        };
        reader.readAsDataURL(outBlob);
        if (STATE.lastRecordStart != null) {
          const newStart = STATE.lastRecordStart + s;
          const newEnd = STATE.lastRecordStart + e;
          setTimeInput(UI_IDS.start, newStart);
          setTimeInput(UI_IDS.end, newEnd);
        }
        setStatus(`Exported ${filename}`);
      } catch (err) {
        setStatus("Export failed", "error");
      }
    });

    $(UI_IDS.trimClose).addEventListener("click", () => {
      setTrimPanelVisible(false);
      setStatus("Trim closed");
    });

    $(UI_IDS.trimStart).addEventListener("change", e => {
      const s = parseTime(e.target.value);
      const endVal = parseTime($(UI_IDS.trimEnd).value);
      if (s == null || endVal == null) return setStatus("Invalid trim range", "error");
      applyTrimFromInputs(s, endVal);
    });

    $(UI_IDS.trimEnd).addEventListener("change", e => {
      const startVal = parseTime($(UI_IDS.trimStart).value);
      const eVal = parseTime(e.target.value);
      if (startVal == null || eVal == null) return setStatus("Invalid trim range", "error");
      applyTrimFromInputs(startVal, eVal);
    });

    $(UI_IDS.trimWaveStart).addEventListener("input", e => {
      const s = Number(e.target.value);
      const endVal = Number($(UI_IDS.trimWaveEnd).value);
      applyTrimFromInputs(s, endVal);
    });

    $(UI_IDS.trimWaveEnd).addEventListener("input", e => {
      const startVal = Number($(UI_IDS.trimWaveStart).value);
      const eVal = Number(e.target.value);
      applyTrimFromInputs(startVal, eVal);
    });

    $(UI_IDS.trimZoom).addEventListener("input", e => {
      STATE.waveZoom = Number(e.target.value) || 1;
      updateWavePanRange();
      renderWaveform(STATE.lastBuffer);
    });

    $(UI_IDS.trimOffset).addEventListener("input", e => {
      STATE.waveOffset = Number(e.target.value) || 0;
      renderWaveform(STATE.lastBuffer);
    });

    $(UI_IDS.trimWave).addEventListener("mousedown", e => {
      if (!STATE.lastBuffer) return;
      e.preventDefault();
      const t = timeFromCanvasX(e.clientX);
      const distStart = Math.abs(t - STATE.trimStart);
      const distEnd = Math.abs(t - STATE.trimEnd);
      STATE.draggingTrim = distStart <= distEnd ? "start" : "end";
      if (STATE.draggingTrim === "start") {
        applyTrimFromInputs(t, STATE.trimEnd);
      } else {
        applyTrimFromInputs(STATE.trimStart, t);
      }
    });

    window.addEventListener("mousemove", e => {
      if (!STATE.draggingTrim) return;
      const t = timeFromCanvasX(e.clientX);
      if (STATE.draggingTrim === "start") {
        applyTrimFromInputs(t, STATE.trimEnd);
      } else {
        applyTrimFromInputs(STATE.trimStart, t);
      }
    });

    window.addEventListener("mouseup", () => {
      STATE.draggingTrim = null;
    });
  }

  function init() {
    const video = findVideo();
    if (!video) {
      setTimeout(init, 1000);
      return;
    }
    buildUI();
    setStatus("Ready");
    getSetting("muteRecording", false).then((val) => {
      const toggle = $(UI_IDS.muteToggle);
      if (toggle) toggle.checked = Boolean(val);
    });
    getSetting("exportFormat", "mp3").then((val) => {
      const el = $(UI_IDS.format);
      if (el) el.value = val;
    });
    getSetting("exportBitrate", 128).then((val) => {
      const el = $(UI_IDS.bitrate);
      if (el) el.value = String(val);
    });
    getSetting("exportChannel", "stereo").then((val) => {
      const el = $(UI_IDS.channel);
      if (el) el.value = val;
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "toggle-ui") return;
    if (!STATE.built) buildUI();
    const root = $(UI_IDS.root);
    if (!root) return;
    STATE.visible = !STATE.visible;
    root.style.display = STATE.visible ? "block" : "none";
  });

  init();
})();
