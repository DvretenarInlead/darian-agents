/**
 * The laptop voice HUD, served at GET /assistant as a single self-contained
 * page (no external assets, so the app's egress posture is unchanged).
 *
 * Ears + mouth: recorded audio → our API → ElevenLabs STT, and answer text →
 * our API → ElevenLabs TTS, when the provider is configured (capability probe
 * at /api/assistant/voice); the browser's Web Speech API covers wake-phrase
 * spotting and acts as the full fallback. The access token is entered once and
 * kept in localStorage; browsers gate the microphone behind HTTPS (or
 * localhost).
 *
 * The face: a CSS-only orb driven by a tiny state machine — idle / wake
 * (always-listening) / listen (recording, mic-level reactive via a CSS var) /
 * think (waiting for the answer) / speak (audio playing).
 */
export const ASSISTANT_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helper</title>
<style>
  :root {
    color-scheme: dark;
    --bg0: #05070f; --bg1: #0b1020; --panel: rgba(17, 26, 48, .72);
    --line: rgba(84, 118, 190, .22); --text: #dbe4ff; --dim: #7487b8;
    --cyan: #59e3ff; --blue: #4f7cff; --violet: #9a6bff; --amber: #ffc35c;
    --level: 0; /* live mic level 0..1, set from JS while recording */
  }
  * { box-sizing: border-box; }
  html { height: 100%; }
  body {
    margin: 0; min-height: 100vh; height: 100%; display: flex; flex-direction: column; color: var(--text);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    background:
      radial-gradient(1100px 520px at 50% -12%, #16224077 0%, transparent 60%),
      radial-gradient(900px 600px at 85% 110%, #251a4d55 0%, transparent 55%),
      linear-gradient(180deg, var(--bg1) 0%, var(--bg0) 100%);
    overflow: hidden;
  }

  /* ---------- header ---------- */
  header {
    display: flex; align-items: center; gap: .8rem; padding: .9rem 1.2rem;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, rgba(11,16,32,.9), rgba(11,16,32,.4));
    backdrop-filter: blur(8px);
  }
  .brand { display: flex; align-items: baseline; gap: .6rem; flex: 1; min-width: 0; }
  .brand h1 {
    margin: 0; font-size: .95rem; font-weight: 700; letter-spacing: .34em;
    text-transform: uppercase;
    background: linear-gradient(90deg, var(--cyan), var(--violet));
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .brand span { font-size: .72rem; letter-spacing: .18em; text-transform: uppercase; color: var(--dim); white-space: nowrap; }
  .pill {
    font-size: .7rem; letter-spacing: .08em; color: var(--dim);
    border: 1px solid var(--line); border-radius: 999px; padding: .18rem .6rem;
    display: inline-flex; align-items: center; gap: .35rem; white-space: nowrap;
  }
  .pill b { color: var(--text); font-weight: 600; }
  .pill .dot { width: .45rem; height: .45rem; border-radius: 50%; background: #3a4b76; }
  .pill .dot.on { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
  button, input, select { font: inherit; color: inherit; }
  .iconbtn {
    background: transparent; border: 1px solid var(--line); border-radius: .6rem;
    padding: .35rem .6rem; cursor: pointer; color: var(--dim);
  }
  .iconbtn:hover { color: var(--text); border-color: #3b5aa0; }

  /* ---------- settings popover ---------- */
  #settings {
    position: absolute; top: 3.4rem; right: 1rem; z-index: 30; width: 19rem;
    background: var(--panel); border: 1px solid var(--line); border-radius: 1rem;
    padding: 1rem 1.1rem; backdrop-filter: blur(14px);
    box-shadow: 0 18px 50px rgba(0,0,0,.5);
    display: none;
  }
  #settings.open { display: block; }
  #settings h2 { margin: 0 0 .6rem; font-size: .72rem; letter-spacing: .22em; text-transform: uppercase; color: var(--dim); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: .8rem; padding: .42rem 0; font-size: .88rem; }
  .row + .row { border-top: 1px dashed rgba(84,118,190,.14); }
  .row select, .row input[type=text] {
    background: rgba(8, 13, 28, .8); border: 1px solid var(--line); border-radius: .5rem;
    padding: .28rem .5rem; max-width: 9.5rem;
  }
  .row .linkish { background: none; border: none; color: var(--cyan); cursor: pointer; padding: 0; }

  /* ---------- stage: the face ---------- */
  main { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  #stage { display: flex; flex-direction: column; align-items: center; padding: 1.6rem 0 .4rem; }
  #orbWrap { position: relative; width: 148px; height: 148px; cursor: pointer; }
  #orb, #orb::before, #orb::after, .ring { position: absolute; border-radius: 50%; }
  #orb {
    inset: 18px;
    background:
      radial-gradient(circle at 32% 30%, rgba(255,255,255,.85) 0%, transparent 22%),
      radial-gradient(circle at 50% 55%, var(--blue) 0%, var(--violet) 58%, #1b1040 100%);
    box-shadow:
      0 0 calc(26px + 60px * var(--level)) rgba(89, 227, 255, calc(.28 + .5 * var(--level))),
      inset 0 -14px 30px rgba(0,0,0,.45);
    transform: scale(calc(1 + .22 * var(--level)));
    transition: transform .08s linear, box-shadow .12s linear;
    animation: breathe 5.2s ease-in-out infinite;
  }
  #orb::before {
    content: ''; inset: -6%;
    background: conic-gradient(from 0deg, transparent 0 40%, rgba(89,227,255,.35) 50%, transparent 60% 100%);
    animation: swirl 7s linear infinite; opacity: .0; transition: opacity .4s;
  }
  #orb::after {
    content: ''; inset: 26%;
    background: radial-gradient(circle at 45% 40%, rgba(255,255,255,.5), transparent 60%);
    filter: blur(2px);
  }
  .ring { inset: 0; border: 1px solid rgba(89,227,255,.16); opacity: 0; transition: opacity .5s; }
  .ring.r2 { inset: -14px; border-color: rgba(154,107,255,.12); }

  @keyframes breathe { 50% { transform: scale(calc(1.045 + .22 * var(--level))); } }
  @keyframes swirl { to { transform: rotate(360deg); } }
  @keyframes ringpulse { 0% { transform: scale(.92); opacity: .55; } 100% { transform: scale(1.25); opacity: 0; } }
  @keyframes talk { 0%, 100% { transform: scale(1); } 30% { transform: scale(1.07); } 60% { transform: scale(1.02); } 80% { transform: scale(1.06); } }

  /* state skins */
  body[data-state=wake]   .ring { opacity: 1; }
  body[data-state=listen] #orb {
    background:
      radial-gradient(circle at 32% 30%, rgba(255,255,255,.9) 0%, transparent 22%),
      radial-gradient(circle at 50% 55%, var(--cyan) 0%, var(--blue) 62%, #0b2040 100%);
    animation: none;
  }
  body[data-state=listen] .ring { opacity: 1; animation: ringpulse 1.6s ease-out infinite; }
  body[data-state=listen] .ring.r2 { animation-delay: .5s; }
  body[data-state=think] #orb::before { opacity: 1; }
  body[data-state=think] #orb { animation: breathe 1.6s ease-in-out infinite; }
  body[data-state=speak] #orb {
    background:
      radial-gradient(circle at 32% 30%, rgba(255,255,255,.9) 0%, transparent 22%),
      radial-gradient(circle at 50% 55%, var(--violet) 0%, var(--blue) 60%, #180f38 100%);
    animation: talk 1.1s ease-in-out infinite;
  }

  #stateLabel {
    margin-top: .9rem; font-size: .72rem; letter-spacing: .3em; text-transform: uppercase;
    color: var(--dim); min-height: 1.1em; text-align: center;
  }
  #stateLabel.hot { color: var(--cyan); }

  /* ---------- transcript ---------- */
  #log {
    flex: 1; overflow-y: auto; padding: 1rem 1.4rem 1.2rem; display: flex;
    flex-direction: column; gap: .7rem; scrollbar-width: thin;
    mask-image: linear-gradient(180deg, transparent 0, #000 1.2rem);
  }
  #log > * { max-width: 620px; width: fit-content; margin-inline: auto; }
  .msg {
    padding: .68rem 1rem; border-radius: 1.1rem; white-space: pre-wrap; width: fit-content;
    animation: rise .25s ease-out;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
  .me {
    margin-left: auto !important; margin-right: 0 !important;
    background: linear-gradient(135deg, #24406e, #203058);
    border: 1px solid rgba(120,160,255,.25); border-bottom-right-radius: .3rem;
  }
  .agent {
    margin-right: auto !important; margin-left: 0 !important;
    background: var(--panel); border: 1px solid var(--line); border-bottom-left-radius: .3rem;
    backdrop-filter: blur(6px);
  }
  .sys { color: var(--dim); font-size: .8rem; text-align: center; }

  /* ---------- composer ---------- */
  footer {
    display: flex; gap: .7rem; align-items: center; padding: .9rem 1.2rem 1.2rem;
    border-top: 1px solid var(--line);
    background: linear-gradient(0deg, rgba(11,16,32,.95), rgba(11,16,32,.35));
    backdrop-filter: blur(8px);
  }
  #q {
    flex: 1; background: rgba(8, 13, 28, .85); border: 1px solid var(--line);
    border-radius: 999px; padding: .78rem 1.2rem; outline: none; min-width: 0;
  }
  #q:focus { border-color: #3b5aa0; box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
  #send {
    border: 1px solid var(--line); background: rgba(36,54,92,.6); cursor: pointer;
    border-radius: 999px; padding: .72rem 1.25rem;
  }
  #send:hover { background: rgba(44,66,112,.8); }
  #mic {
    width: 3.5rem; height: 3.5rem; border-radius: 50%; border: 1px solid var(--line);
    cursor: pointer; font-size: 1.25rem; flex: none; position: relative;
    background: radial-gradient(circle at 35% 30%, #2c4270, #17233f);
  }
  #mic:hover { border-color: #3b5aa0; }
  #mic.listening { border-color: transparent; background: radial-gradient(circle at 35% 30%, #ff6b6b, #a11d1d); }
  #mic.listening::after {
    content: ''; position: absolute; inset: -5px; border-radius: 50%;
    border: 2px solid rgba(255,107,107,.5); animation: ringpulse 1.2s ease-out infinite;
  }
  .hidden { display: none !important; }
  @media (max-width: 560px) { .brand span { display: none; } #log > * { max-width: 92%; } }
</style>
</head>
<body data-state="idle">
<header>
  <div class="brand"><h1>Helper</h1><span>personal assistant</span></div>
  <span class="pill" id="voicePill"><span class="dot" id="voiceDot"></span><span id="voiceLabel">browser voice</span></span>
  <span class="pill"><span class="dot" id="wakeDot"></span>wake&nbsp;<b id="wakeLabel">off</b></span>
  <button class="iconbtn" id="gear" title="Settings">⚙</button>
</header>

<div id="settings">
  <h2>Settings</h2>
  <div class="row"><label for="lang">Language</label>
    <select id="lang">
      <option value="en-US">English</option>
      <option value="hr-HR">Hrvatski</option>
    </select>
  </div>
  <div class="row"><label for="speak">Speak replies</label><input type="checkbox" id="speak" checked></div>
  <div class="row"><label for="rate">Voice speed <span class="muted" id="rateVal">1.1×</span></label>
    <input type="range" id="rate" min="0.8" max="1.3" step="0.05" value="1.1" style="width:7rem">
  </div>
  <div class="row" id="wakeWrap"><label for="wake">Wake word</label><input type="checkbox" id="wake"></div>
  <div class="row"><label for="wakePhrase">Phrase</label><input type="text" id="wakePhrase" value="hi helper"></div>
  <div class="row"><span>Access token</span><button class="linkish" id="resetToken">change…</button></div>
</div>

<main>
  <div id="stage">
    <div id="orbWrap" title="Click to talk">
      <div class="ring"></div><div class="ring r2"></div>
      <div id="orb"></div>
    </div>
    <div id="stateLabel">idle</div>
  </div>
  <div id="log"></div>
</main>

<footer>
  <button id="mic" title="Talk (or press Space)">🎤</button>
  <input id="q" placeholder="Ask about your commitments…" autocomplete="off">
  <button id="send">Send</button>
</footer>

<script>
(() => {
  const log = document.getElementById('log');
  const input = document.getElementById('q');
  const micBtn = document.getElementById('mic');
  const orbWrap = document.getElementById('orbWrap');
  const langSel = document.getElementById('lang');
  const speakBox = document.getElementById('speak');
  const stateLabel = document.getElementById('stateLabel');
  const wakeDot = document.getElementById('wakeDot');
  const wakeLabel = document.getElementById('wakeLabel');
  const voiceDot = document.getElementById('voiceDot');
  const voiceLabel = document.getElementById('voiceLabel');

  // ---- settings popover ----
  const settings = document.getElementById('settings');
  document.getElementById('gear').onclick = (e) => { e.stopPropagation(); settings.classList.toggle('open'); };
  document.addEventListener('click', (e) => { if (!settings.contains(e.target)) settings.classList.remove('open'); });

  // ---- face state machine ----
  // base: idle | wake; transient overrides: listen | think | speak
  let baseState = 'idle';
  let override = null;
  const LABELS = { idle: 'idle', wake: 'listening for wake word', listen: 'listening…', think: 'thinking…', speak: 'speaking' };
  function render() {
    const s = override || baseState;
    document.body.dataset.state = s;
    stateLabel.textContent = LABELS[s] || s;
    stateLabel.classList.toggle('hot', s === 'listen' || s === 'speak');
    if (s !== 'listen') setLevel(0);
  }
  function setBase(s) { baseState = s; render(); }
  function setOverride(s) { override = s; render(); }
  function setLevel(v) { document.documentElement.style.setProperty('--level', String(Math.max(0, Math.min(1, v)))); }

  const TOKEN_KEY = 'assistant_token';
  function getToken(forceAsk) {
    let t = localStorage.getItem(TOKEN_KEY);
    if (!t || forceAsk) {
      t = prompt('Access token for the assistant API:') || '';
      if (t) localStorage.setItem(TOKEN_KEY, t.trim());
    }
    return (t || '').trim();
  }
  document.getElementById('resetToken').onclick = () => getToken(true);

  const saved = localStorage.getItem('assistant_lang');
  if (saved) langSel.value = saved;
  langSel.onchange = () => localStorage.setItem('assistant_lang', langSel.value);

  // Voice speed (applies to the provider voice and the browser fallback).
  const rateInput = document.getElementById('rate');
  const rateVal = document.getElementById('rateVal');
  const savedRate = localStorage.getItem('assistant_rate');
  if (savedRate) rateInput.value = savedRate;
  const rate = () => Number(rateInput.value) || 1.1;
  const showRate = () => { rateVal.textContent = rate().toFixed(2).replace(/0$/, '') + '×'; };
  showRate();
  rateInput.oninput = () => { localStorage.setItem('assistant_rate', rateInput.value); showRate(); };

  function add(cls, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    if (cls === 'sys') div.className = 'sys';
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  // Server voice capabilities (ElevenLabs behind our API). Falls back to the
  // browser's built-in voice when the provider isn't configured.
  const caps = { tts: false, stt: false };
  fetch('/api/assistant/voice').then(r => r.ok ? r.json() : null).then(c => {
    if (c) {
      caps.tts = !!c.tts; caps.stt = !!c.stt;
      if (caps.tts) { voiceDot.classList.add('on'); voiceLabel.textContent = 'premium voice'; }
    }
  }).catch(() => {});

  function speakBrowser(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = langSel.value;
      u.rate = rate();
      const voice = speechSynthesis.getVoices().find(v => v.lang === langSel.value)
        || speechSynthesis.getVoices().find(v => v.lang.startsWith(langSel.value.slice(0, 2)));
      if (voice) u.voice = voice;
      u.onend = u.onerror = resolve;
      speechSynthesis.speak(u);
    });
  }

  // Barge-in: tapping the orb while the assistant talks cuts it off.
  let stopSpeaking = null;
  async function speakProvider(text) {
    const res = await fetch('/api/assistant/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getToken(false) },
      body: JSON.stringify({ text, speed: Math.min(rate(), 1.2) }),
    });
    if (!res.ok) throw new Error('tts ' + res.status);
    const url = URL.createObjectURL(await res.blob());
    await new Promise((resolve) => {
      const a = new Audio(url);
      const done = () => { stopSpeaking = null; URL.revokeObjectURL(url); resolve(); };
      stopSpeaking = () => { a.pause(); done(); };
      a.onended = a.onerror = done;
      a.play().catch(done);
    });
  }

  // Resolves when playback finishes. Pauses the ears while the mouth is
  // talking, or it hears itself.
  async function speak(text) {
    if (!speakBox.checked) return;
    pauseListening();
    setOverride('speak');
    try {
      if (caps.tts) await speakProvider(text);
      else await speakBrowser(text);
    } catch {
      await speakBrowser(text); // provider hiccup → still say it
    } finally {
      setOverride(null);
      resumeListening();
    }
  }

  // Recent turns (client-held, re-sanitized server-side) so follow-up
  // questions like "and which of those is urgent?" work naturally.
  const history = [];
  function remember(role, content) {
    history.push({ role, content: String(content).slice(0, 1000) });
    while (history.length > 12) history.shift();
  }

  async function ask(question) {
    const q = question.trim();
    if (!q) return;
    add('me', q);
    input.value = '';
    setOverride('think');
    const pending = add('agent', '…');
    try {
      const res = await fetch('/api/assistant/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getToken(false) },
        body: JSON.stringify({ question: q, history }),
      });
      if (res.status === 401) {
        pending.textContent = 'Unauthorized — open settings and change the access token.';
        return;
      }
      if (res.status === 429) {
        pending.textContent = 'Slow down a moment — rate limit reached.';
        return;
      }
      if (!res.ok) {
        pending.textContent = 'Request failed (' + res.status + ').';
        return;
      }
      const data = await res.json();
      pending.textContent = data.answer;
      remember('user', q);
      remember('assistant', data.answer);
      setOverride(null);
      await speak(data.answer);
    } catch (err) {
      pending.textContent = 'Network error: ' + err;
    } finally {
      if (override === 'think') setOverride(null);
    }
  }

  document.getElementById('send').onclick = () => ask(input.value);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(input.value); });

  // ---- Ears ----
  // Two tiers: recorded audio → our server → ElevenLabs STT (when configured),
  // with the browser's Web Speech API for wake-phrase spotting and as fallback.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const wakeBox = document.getElementById('wake');
  const wakeInput = document.getElementById('wakePhrase');

  // No-ops overridden below when SR is available; speak() calls them either way.
  let pauseListening = () => {};
  let resumeListening = () => {};

  // Record one spoken question and transcribe it server-side. Auto-stops after
  // ~1.3s of silence once speech has started (or 15s hard cap). Returns the
  // transcript, or null on failure/empty.
  let activeRecording = null; // () => void — stops the in-flight recording
  async function recordQuestion() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      add('sys', 'Microphone access denied.');
      return null;
    }
    const mime = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    micBtn.classList.add('listening');
    setOverride('listen');
    let stopped = false;
    const stop = () => {
      if (stopped) return; stopped = true;
      activeRecording = null;
      try { recorder.stop(); } catch {}
      stream.getTracks().forEach(t => t.stop());
      ctx.close().catch(() => {});
      micBtn.classList.remove('listening');
      if (override === 'listen') setOverride(null);
    };
    activeRecording = stop;

    const started = performance.now();
    let spokeAt = 0, silentAt = 0;
    (function tick() {
      if (stopped) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
      const rms = Math.sqrt(sum / buf.length);
      setLevel(rms * 6); // drive the orb with the live mic level
      const now = performance.now();
      if (rms > 0.02) { spokeAt = spokeAt || now; silentAt = 0; }
      else if (spokeAt) { silentAt = silentAt || now; if (now - silentAt > 900) return stop(); }
      if (now - started > 15000) return stop();
      requestAnimationFrame(tick);
    })();

    await new Promise((resolve) => { recorder.onstop = resolve; recorder.start(); });
    stop();
    if (!chunks.length) return null;
    const blob = new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] });
    try {
      const res = await fetch('/api/assistant/stt', {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm', authorization: 'Bearer ' + getToken(false) },
        body: blob,
      });
      if (!res.ok) { add('sys', 'Transcription failed (' + res.status + ').'); return null; }
      const data = await res.json();
      return (data.text || '').trim() || null;
    } catch (err) {
      add('sys', 'Transcription error: ' + err);
      return null;
    }
  }

  async function captureAndAsk() {
    pauseListening();
    try {
      const text = await recordQuestion();
      if (text) { input.value = text; await ask(text); }
    } finally {
      resumeListening();
    }
  }

  function micTap() {
    // Barge-in: if the assistant is talking, a tap silences it first.
    if (stopSpeaking) { stopSpeaking(); return; }
    if ('speechSynthesis' in window && speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
    micBtn.onclick && micBtn.onclick();
  }
  orbWrap.onclick = micTap;
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && document.activeElement !== input && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault(); micTap();
    }
  });

  if (!SR) {
    // No Web Speech API (non-Chromium): wake word needs it, but push-to-talk
    // still works through the server's ears when configured.
    document.getElementById('wakeWrap').classList.add('hidden');
    micBtn.onclick = () => {
      if (!caps.stt) { add('sys', 'Speech recognition is not available in this browser — type your questions instead.'); return; }
      if (activeRecording) activeRecording(); else captureAndAsk();
    };
  } else {
    const savedWake = localStorage.getItem('assistant_wake_phrase');
    if (savedWake) wakeInput.value = savedWake;
    wakeInput.onchange = () => localStorage.setItem('assistant_wake_phrase', wakeInput.value);

    // --- Push-to-talk (mic button): one utterance = one question. ---
    let rec = null;
    micBtn.onclick = () => {
      // Provider ears configured → record + server-side transcription.
      if (caps.stt) {
        if (activeRecording) { activeRecording(); return; } // click again = stop early
        captureAndAsk();
        return;
      }
      if (rec) { rec.stop(); return; }
      stopWakeLoop(); // the two modes share the one microphone
      rec = new SR();
      rec.lang = langSel.value;
      rec.interimResults = true;
      rec.onstart = () => { micBtn.classList.add('listening'); setOverride('listen'); };
      rec.onresult = (e) => {
        const text = Array.from(e.results).map(r => r[0].transcript).join(' ');
        input.value = text;
        if (e.results[e.results.length - 1].isFinal) ask(text);
      };
      rec.onerror = (e) => { if (e.error !== 'aborted') add('sys', 'Mic error: ' + e.error); };
      rec.onend = () => {
        micBtn.classList.remove('listening');
        if (override === 'listen') setOverride(null);
        rec = null;
        if (wakeBox.checked) startWakeLoop();
      };
      rec.start();
    };

    // --- Wake word: always listening, summoned by the phrase (e.g. "hi helper"). ---
    let wakeRec = null;
    let wakeActive = false;   // user wants the loop running
    let wakePaused = false;   // temporarily off while the assistant speaks
    let awaitingQuestion = false;
    let awaitTimer = null;

    const normalize = (s) => s.toLowerCase().replace(/[^\\p{L}\\p{N} ]/gu, ' ').replace(/ +/g, ' ').trim();

    function handleUtterance(raw) {
      const text = raw.trim();
      if (!text) return;
      const phrase = normalize(wakeInput.value) || 'hi helper';
      const heard = normalize(text);
      const at = heard.indexOf(phrase);
      if (at !== -1) {
        // Whatever follows the wake phrase in the same breath is the question.
        const after = heard.slice(at + phrase.length).trim();
        if (after.length > 2) {
          ask(after);
        } else if (caps.stt) {
          // Provider ears: acknowledge, then record the question properly.
          (async () => {
            await speak(langSel.value.startsWith('hr') ? 'Da?' : 'Yes?');
            await captureAndAsk();
          })();
        } else {
          awaitingQuestion = true;
          speak(langSel.value.startsWith('hr') ? 'Da?' : 'Yes?');
          clearTimeout(awaitTimer);
          awaitTimer = setTimeout(() => { awaitingQuestion = false; }, 12000);
        }
      } else if (awaitingQuestion) {
        awaitingQuestion = false;
        clearTimeout(awaitTimer);
        ask(text);
      }
      // Anything else is ambient speech — ignore it.
    }

    function startWakeLoop() {
      if (wakeRec || rec || !wakeBox.checked) return;
      wakeActive = true;
      wakeRec = new SR();
      wakeRec.lang = langSel.value;
      wakeRec.continuous = true;
      wakeRec.interimResults = false;
      wakeRec.onstart = () => { setBase('wake'); wakeDot.classList.add('on'); wakeLabel.textContent = 'on'; };
      wakeRec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) handleUtterance(e.results[i][0].transcript);
        }
      };
      wakeRec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          wakeBox.checked = false; wakeActive = false;
          add('sys', 'Mic error: ' + e.error);
        }
      };
      wakeRec.onend = () => {
        wakeRec = null;
        // Chrome ends recognition periodically — restart to stay always-on.
        if (wakeActive && !wakePaused && wakeBox.checked) setTimeout(startWakeLoop, 250);
        else if (!wakeActive) { setBase('idle'); wakeDot.classList.remove('on'); wakeLabel.textContent = 'off'; }
      };
      wakeRec.start();
    }

    function stopWakeLoop() {
      wakeActive = false;
      if (wakeRec) { const r = wakeRec; wakeRec = null; r.stop(); }
      setBase('idle'); wakeDot.classList.remove('on'); wakeLabel.textContent = 'off';
    }

    pauseListening = () => { if (wakeActive) { wakePaused = true; if (wakeRec) { const r = wakeRec; wakeRec = null; r.stop(); } } };
    resumeListening = () => { if (wakePaused) { wakePaused = false; if (wakeBox.checked) startWakeLoop(); } };

    wakeBox.onchange = () => {
      if (wakeBox.checked) {
        startWakeLoop();
        add('sys', 'Wake word on — say “' + wakeInput.value + '” to summon me.');
      } else {
        stopWakeLoop();
      }
    };
    langSel.addEventListener('change', () => { if (wakeActive) { stopWakeLoop(); wakeBox.checked && startWakeLoop(); } });
  }

  add('sys', 'Tap the orb (or press Space) and ask — or enable the wake word in settings and just say “hi helper”.');
})();
</script>
</body>
</html>
`;
