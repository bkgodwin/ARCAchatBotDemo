// -------------------------
// DOM
// -------------------------
const chatLog = document.getElementById("chatLog");

const btnHealth = document.getElementById("btnHealth");
const healthOut = document.getElementById("healthOut");

const systemPromptEl = document.getElementById("systemPrompt");
const personalityNameEl = document.getElementById("personalityName");
const btnSavePersonality = document.getElementById("btnSavePersonality");
const btnRefreshPersonalities = document.getElementById("btnRefreshPersonalities");
const personalitySelect = document.getElementById("personalitySelect");
const btnLoadPersonality = document.getElementById("btnLoadPersonality");
const personalityMsg = document.getElementById("personalityMsg");

const textInput = document.getElementById("textInput");
const btnSend = document.getElementById("btnSend");

const btnMicToggle = document.getElementById("btnMicToggle");
const alwaysListen = document.getElementById("alwaysListen");
const micState = document.getElementById("micState");

const ttsRate = document.getElementById("ttsRate");
const ttsRateVal = document.getElementById("ttsRateVal");
const voiceSelect = document.getElementById("voiceSelect");
const btnStopSpeak = document.getElementById("btnStopSpeak");
const speakState = document.getElementById("speakState");

const sttMode = document.getElementById("sttMode");
const sttNote = document.getElementById("sttNote");
const micSelect = document.getElementById("micSelect");
const btnRefreshMics = document.getElementById("btnRefreshMics");
const compatMsg = document.getElementById("compatMsg");

// -------------------------
// Helpers
// -------------------------
function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;

  const meta = document.createElement("div");
  meta.className = "bmeta";
  meta.textContent = role === "user" ? "You" : "EagleAI";

  const body = document.createElement("div");
  body.textContent = text;

  div.appendChild(meta);
  div.appendChild(body);

  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function showTypingIndicator() {
  const div = document.createElement("div");
  div.id = "typing-indicator";
  div.className = "typing-indicator";
  
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("div");
    dot.className = "dot";
    div.appendChild(dot);
  }
  
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function hideTypingIndicator() {
  const indicator = document.getElementById("typing-indicator");
  if (indicator) {
    indicator.remove();
  }
}

function setStatus(el, msg) {
  el.textContent = msg || "";
}

async function postJSON(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    const err = data.error || `HTTP ${r.status}`;
    throw new Error(err);
  }
  return data;
}

async function postFormData(url, formData) {
  const r = await fetch(url, { method: "POST", body: formData });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    const err = data.error || `HTTP ${r.status}`;
    throw new Error(err);
  }
  return data;
}

function clampStr(s, maxLen = 1200) {
  const t = (s || "").trim();
  return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
}

// -------------------------
// TTS (client-side)
// -------------------------
let currentUtterance = null;
let isSpeaking = false;

function populateVoices() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  voiceSelect.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  }
}

function getSelectedVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const name = voiceSelect.value;
  return voices.find(v => v.name === name) || null;
}

function stopSpeaking() {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  isSpeaking = false;
  currentUtterance = null;
  setStatus(speakState, "");
}

function speakText(text) {
  if (!window.speechSynthesis) {
    setStatus(speakState, "TTS not supported in this browser.");
    return Promise.resolve();
  }

  stopSpeaking();

  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    currentUtterance = u;
    u.rate = parseFloat(ttsRate.value || "1.0");

    const v = getSelectedVoice();
    if (v) u.voice = v;

    u.onstart = () => {
      isSpeaking = true;
      setStatus(speakState, "Speaking… mic paused.");
      stopAnyListening(true);
    };

    u.onend = () => {
      isSpeaking = false;
      currentUtterance = null;
      setStatus(speakState, "");
      if (alwaysListen.checked) startListening(true);
      resolve();
    };

    u.onerror = () => {
      isSpeaking = false;
      currentUtterance = null;
      setStatus(speakState, "Speech error.");
      if (alwaysListen.checked) startListening(true);
      resolve();
    };

    window.speechSynthesis.speak(u);
  });
}

// -------------------------
// Browser SpeechRecognition (STT)
// -------------------------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListeningBrowser = false;
let lastTranscriptAt = 0;

function initBrowserRecognition() {
  if (!SpeechRecognition) return;

  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.continuous = true;

  recognition.onstart = () => {
    isListeningBrowser = true;
    btnMicToggle.textContent = "Stop Mic";
    setStatus(micState, sttMode.value === "browser" ? "Listening (browser STT)…" : "Listening…");
  };

  recognition.onend = () => {
    isListeningBrowser = false;
    if (!isAnyListening()) {
      btnMicToggle.textContent = "Start Mic";
      setStatus(micState, "");
    }
    if (alwaysListen.checked && sttMode.value === "browser" && !isSpeaking) {
      setTimeout(() => {
        try { recognition.start(); } catch {}
      }, 350);
    }
  };

  recognition.onerror = (e) => {
    setStatus(micState, `Mic error: ${e.error || "unknown"}`);
  };

  recognition.onresult = async (event) => {
    const res = event.results?.[event.results.length - 1];
    const transcript = res?.[0]?.transcript?.trim();
    if (!transcript) return;

    const now = Date.now();
    if (now - lastTranscriptAt < 500) return;
    lastTranscriptAt = now;

    if (alwaysListen.checked) {
      await sendMessage(transcript);
    } else {
      textInput.value = transcript;
      textInput.focus();
    }
  };
}

function startBrowserRecognition(keepButtonState = false) {
  if (!recognition || isSpeaking) return;
  try { recognition.start(); } catch {}
  if (!keepButtonState) btnMicToggle.textContent = "Stop Mic";
}

function stopBrowserRecognition(keepButtonState = false) {
  if (!recognition) return;
  try { recognition.stop(); } catch {}
  if (!keepButtonState) btnMicToggle.textContent = "Start Mic";
}

// -------------------------
// Server STT via MediaRecorder (mic selection supported)
// -------------------------
let mediaStream = null;
let mediaRecorder = null;
let chunks = [];
let isListeningServer = false;
let serverLoopTimer = null;

async function getSelectedDeviceStream() {
  const deviceId = micSelect.value;
  const constraints = {
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    video: false
  };
  return await navigator.mediaDevices.getUserMedia(constraints);
}

function stopMediaStream() {
  try {
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
    }
  } catch {}
  mediaStream = null;
}

async function startServerListening(keepButtonState = false) {
  if (isSpeaking) return;

  // Request a stream tied to the selected mic
  try {
    mediaStream = await getSelectedDeviceStream();
  } catch (e) {
    setStatus(micState, `Mic permission/device error: ${e.message}`);
    return;
  }

  isListeningServer = true;
  if (!keepButtonState) btnMicToggle.textContent = "Stop Mic";
  setStatus(micState, "Listening (server STT)…");

  // Segment recording loop: record N seconds, transcribe, repeat if alwaysListen
  const segmentMs = 3500;

  async function recordOnce() {
    if (!isListeningServer || isSpeaking) return;

    chunks = [];
    try {
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm" });
    } catch {
      // Fallback if mimeType unsupported
      mediaRecorder = new MediaRecorder(mediaStream);
    }

    const done = new Promise((resolve) => {
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.onstop = () => resolve();
    });

    mediaRecorder.start();
    await new Promise(r => setTimeout(r, segmentMs));
    try { mediaRecorder.stop(); } catch {}

    await done;

    // Send to server for transcription
    const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
    const fd = new FormData();
    fd.append("audio", blob, "speech.webm");

    try {
      const data = await postFormData("/api/stt", fd);
      const text = (data.text || "").trim();
      if (text) {
        if (alwaysListen.checked) {
          await sendMessage(text);
        } else {
          textInput.value = text;
          textInput.focus();
        }
      }
    } catch (e) {
      // Show one error then stop (prevents spam)
      hideTypingIndicator();
      addBubble("bot", `STT Error: ${e.message}`);
      stopServerListening(true);
      return;
    }

    // Continue loop if always listening
    if (alwaysListen.checked && isListeningServer && !isSpeaking) {
      serverLoopTimer = setTimeout(recordOnce, 200);
    }
  }

  recordOnce();
}

function stopServerListening(keepButtonState = false) {
  isListeningServer = false;
  if (serverLoopTimer) {
    clearTimeout(serverLoopTimer);
    serverLoopTimer = null;
  }
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  } catch {}
  mediaRecorder = null;
  stopMediaStream();

  if (!keepButtonState) btnMicToggle.textContent = "Start Mic";
  if (!isAnyListening()) setStatus(micState, "");
}

function isAnyListening() {
  return isListeningBrowser || isListeningServer;
}

function stopAnyListening(keepButtonState = false) {
  stopBrowserRecognition(true);
  stopServerListening(true);

  if (!keepButtonState) btnMicToggle.textContent = "Start Mic";
  if (!keepButtonState) setStatus(micState, "");
}

function startListening(keepButtonState = false) {
  if (isSpeaking) return;
  if (sttMode.value === "server") {
    startServerListening(keepButtonState);
  } else {
    startBrowserRecognition(keepButtonState);
  }
}

// -------------------------
// Microphone device list
// -------------------------
async function refreshMicDevices() {
  micSelect.innerHTML = "";
  if (!navigator.mediaDevices?.enumerateDevices) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(device enumeration not supported)";
    micSelect.appendChild(opt);
    return;
  }

  // On many browsers, labels are blank until getUserMedia permission granted.
  // We'll request minimal permission if needed.
  try {
    // If no permission yet, this will trigger it (audio only)
    const testStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    testStream.getTracks().forEach(t => t.stop());
  } catch {
    // ignore; still may enumerate, but labels may be blank
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === "audioinput");

  if (mics.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no microphones found)";
    micSelect.appendChild(opt);
    return;
  }

  for (const d of mics) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone (${d.deviceId.slice(0, 6)}…)`;
    micSelect.appendChild(opt);
  }
}

// -------------------------
// Chat flow
// -------------------------
async function sendMessage(text) {
  const msg = (text || "").trim();
  if (!msg) return;

  addBubble("user", msg);

  if (isAnyListening()) stopAnyListening(true);

  btnSend.disabled = true;
  textInput.value = "";

  // Show typing indicator while waiting for response
  showTypingIndicator();

  try {
    const system_prompt = systemPromptEl.value || "";
    const data = await postJSON("/api/chat", { system_prompt, user_message: msg });
    const assistant = data.assistant || "";
    
    // Hide typing indicator before showing response
    hideTypingIndicator();
    
    addBubble("bot", assistant);
    await speakText(assistant);
  } catch (e) {
    hideTypingIndicator();
    addBubble("bot", `Error: ${e.message}`);
    if (alwaysListen.checked && !isSpeaking) startListening(true);
  } finally {
    btnSend.disabled = false;
    textInput.focus();
  }
}

// -------------------------
// Personalities
// -------------------------
async function refreshPersonalities() {
  personalityMsg.textContent = "";
  const r = await fetch("/api/personalities");
  const data = await r.json().catch(() => ({}));
  if (!data.ok) {
    personalityMsg.textContent = data.error || "Failed to load personalities.";
    return;
  }
  personalitySelect.innerHTML = "";
  for (const it of data.items || []) {
    const opt = document.createElement("option");
    opt.value = it.name;
    opt.textContent = it.name;
    personalitySelect.appendChild(opt);
  }
  if ((data.items || []).length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(none saved yet)";
    personalitySelect.appendChild(opt);
  }
}

async function savePersonality() {
  const name = (personalityNameEl.value || "").trim();
  const system_prompt = systemPromptEl.value || "";
  if (!name) {
    personalityMsg.textContent = "Enter a personality name first.";
    return;
  }
  try {
    await postJSON("/api/personalities/save", { name, system_prompt });
    personalityMsg.textContent = `Saved '${name}'.`;
    await refreshPersonalities();
    personalitySelect.value = name;
  } catch (e) {
    personalityMsg.textContent = `Save failed: ${e.message}`;
  }
}

async function loadPersonality() {
  const name = (personalitySelect.value || "").trim();
  if (!name) return;
  try {
    const data = await postJSON("/api/personalities/load", { name });
    systemPromptEl.value = data.item.system_prompt || "";
    personalityNameEl.value = data.item.name || name;
    personalityMsg.textContent = `Loaded '${name}'.`;
  } catch (e) {
    personalityMsg.textContent = `Load failed: ${e.message}`;
  }
}

// -------------------------
// UI wiring
// -------------------------
btnSend.addEventListener("click", () => sendMessage(textInput.value));
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendMessage(textInput.value);
  }
});

btnMicToggle.addEventListener("click", () => {
  if (isSpeaking) return;

  if (isAnyListening()) {
    alwaysListen.checked = false;
    stopAnyListening();
  } else {
    startListening();
  }
});

alwaysListen.addEventListener("change", () => {
  if (alwaysListen.checked && !isSpeaking) startListening(true);
});

sttMode.addEventListener("change", () => {
  // Switching modes stops current listening
  if (isAnyListening()) stopAnyListening(true);

  if (sttMode.value === "server") {
    sttNote.textContent = "Using selected mic via MediaRecorder → /api/stt";
  } else {
    sttNote.textContent = "Uses default mic (browser STT)";
  }
});

btnRefreshMics.addEventListener("click", refreshMicDevices);

ttsRate.addEventListener("input", () => {
  ttsRateVal.textContent = Number(ttsRate.value).toFixed(2);
});

btnStopSpeak.addEventListener("click", () => {
  stopSpeaking();
  if (alwaysListen.checked) startListening(true);
});

btnSavePersonality.addEventListener("click", savePersonality);
btnRefreshPersonalities.addEventListener("click", refreshPersonalities);
btnLoadPersonality.addEventListener("click", loadPersonality);

btnHealth.addEventListener("click", async () => {
  setStatus(healthOut, "Checking…");
  try {
    const r = await fetch("/api/health");
    const data = await r.json();
    if (data.ok) {
      setStatus(healthOut, `OK • ${data.ollama_host} • model=${data.ollama_model} • endpoint=${data.chat_endpoint} • server STT=${data.server_stt_enabled}`);
    } else {
      setStatus(healthOut, "Health check failed.");
    }
  } catch (e) {
    setStatus(healthOut, `Health error: ${e.message}`);
  }
});

// -------------------------
// Boot
// -------------------------
ttsRateVal.textContent = Number(ttsRate.value).toFixed(2);

if (window.speechSynthesis) {
  populateVoices();
  window.speechSynthesis.onvoiceschanged = populateVoices;
}

if (!SpeechRecognition) {
  compatMsg.textContent = "Browser STT not available (SpeechRecognition missing). Use Server STT mode.";
}

initBrowserRecognition();
refreshPersonalities();
refreshMicDevices();

sttNote.textContent = sttMode.value === "server"
  ? "Using selected mic via MediaRecorder → /api/stt"
  : "Uses default mic (browser STT)";
