/**
 * The laptop voice HUD, served at GET /assistant as a single self-contained
 * page (no external assets, so the app's egress posture is unchanged).
 *
 * Ears + mouth live entirely in the browser: SpeechRecognition (Web Speech API)
 * for speech-to-text and speechSynthesis for the reply, so no audio ever
 * reaches our servers — only the final transcript is POSTed to
 * /api/assistant/ask. The access token is entered once and kept in
 * localStorage; browsers gate the microphone behind HTTPS (or localhost).
 * Recognition needs a Chromium-based browser; the text box always works.
 */
export const ASSISTANT_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assistant</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column;
    background: radial-gradient(1200px 600px at 50% -10%, #17233b 0%, #0b1020 55%, #070b16 100%);
    color: #dbe4ff; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: center; gap: .75rem; padding: 1rem 1.25rem;
    border-bottom: 1px solid #1d2a45;
  }
  header h1 { font-size: 1rem; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; margin: 0; flex: 1; }
  header .dot { width: .6rem; height: .6rem; border-radius: 50%; background: #3a4b76; }
  header .dot.live { background: #4ade80; box-shadow: 0 0 8px #4ade80; }
  select, input, button { font: inherit; }
  select {
    background: #101a30; color: inherit; border: 1px solid #24365c; border-radius: .5rem; padding: .3rem .5rem;
  }
  #wakePhrase {
    background: #101a30; color: inherit; border: 1px solid #24365c; border-radius: .5rem;
    padding: .2rem .4rem; width: 6.5rem;
  }
  #log { flex: 1; overflow-y: auto; padding: 1.25rem; display: flex; flex-direction: column; gap: .75rem; }
  .msg { max-width: 46rem; padding: .65rem .9rem; border-radius: .9rem; white-space: pre-wrap; }
  .me { align-self: flex-end; background: #22345c; border-bottom-right-radius: .25rem; }
  .agent { align-self: flex-start; background: #121c33; border: 1px solid #1e2c4d; border-bottom-left-radius: .25rem; }
  .sys { align-self: center; color: #7487b8; font-size: .85rem; }
  footer { padding: 1rem 1.25rem 1.5rem; display: flex; gap: .75rem; align-items: center; }
  #q {
    flex: 1; background: #0f1830; color: inherit; border: 1px solid #24365c;
    border-radius: 999px; padding: .7rem 1.1rem; outline: none;
  }
  #q:focus { border-color: #3b5aa0; }
  button {
    cursor: pointer; border: none; border-radius: 999px; padding: .7rem 1.2rem;
    background: #24365c; color: #dbe4ff;
  }
  button:hover { background: #2c4270; }
  #mic { width: 3.4rem; height: 3.4rem; font-size: 1.3rem; padding: 0; }
  #mic.listening { background: #b91c1c; animation: pulse 1.2s infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 12px rgba(185,28,28,.18); } }
  .hidden { display: none; }
</style>
</head>
<body>
<header>
  <span class="dot" id="statusDot"></span>
  <h1>Personal Assistant</h1>
  <label class="sys">voice
    <select id="lang">
      <option value="en-US">English</option>
      <option value="hr-HR">Hrvatski</option>
    </select>
  </label>
  <label class="sys"><input type="checkbox" id="speak" checked> speak replies</label>
  <label class="sys" id="wakeWrap"><input type="checkbox" id="wake"> wake word
    <input type="text" id="wakePhrase" value="hi helper" size="9" title="Say this phrase to summon the assistant">
  </label>
  <button id="resetToken" title="Change access token">token</button>
</header>

<main id="log"></main>

<footer>
  <button id="mic" title="Hold conversation — click to talk">🎤</button>
  <input id="q" placeholder="Ask about your commitments… (Enter to send)" autocomplete="off">
  <button id="send">Send</button>
</footer>

<script>
(() => {
  const log = document.getElementById('log');
  const input = document.getElementById('q');
  const micBtn = document.getElementById('mic');
  const langSel = document.getElementById('lang');
  const speakBox = document.getElementById('speak');
  const dot = document.getElementById('statusDot');

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

  function add(cls, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function speak(text) {
    if (!speakBox.checked || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langSel.value;
    const voice = speechSynthesis.getVoices().find(v => v.lang === langSel.value)
      || speechSynthesis.getVoices().find(v => v.lang.startsWith(langSel.value.slice(0, 2)));
    if (voice) u.voice = voice;
    // Pause the ears while the mouth is talking, or it hears itself.
    pauseListening();
    u.onend = u.onerror = () => resumeListening();
    speechSynthesis.speak(u);
  }

  async function ask(question) {
    const q = question.trim();
    if (!q) return;
    add('me', q);
    input.value = '';
    const pending = add('agent', '…');
    try {
      const res = await fetch('/api/assistant/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getToken(false) },
        body: JSON.stringify({ question: q }),
      });
      if (res.status === 401) {
        pending.textContent = 'Unauthorized — click "token" and enter a valid access token.';
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
      speak(data.answer);
    } catch (err) {
      pending.textContent = 'Network error: ' + err;
    }
  }

  document.getElementById('send').onclick = () => ask(input.value);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(input.value); });

  // ---- Ears: Web Speech API (Chromium). Falls back to typing elsewhere. ----
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const wakeBox = document.getElementById('wake');
  const wakeInput = document.getElementById('wakePhrase');

  // No-ops overridden below when SR is available; speak() calls them either way.
  let pauseListening = () => {};
  let resumeListening = () => {};

  if (!SR) {
    micBtn.classList.add('hidden');
    document.getElementById('wakeWrap').classList.add('hidden');
    add('sys', 'Speech recognition is not available in this browser — type your questions instead.');
  } else {
    const savedWake = localStorage.getItem('assistant_wake_phrase');
    if (savedWake) wakeInput.value = savedWake;
    wakeInput.onchange = () => localStorage.setItem('assistant_wake_phrase', wakeInput.value);

    // --- Push-to-talk (mic button): one utterance = one question. ---
    let rec = null;
    micBtn.onclick = () => {
      if (rec) { rec.stop(); return; }
      stopWakeLoop(); // the two modes share the one microphone
      rec = new SR();
      rec.lang = langSel.value;
      rec.interimResults = true;
      rec.onstart = () => { micBtn.classList.add('listening'); dot.classList.add('live'); };
      rec.onresult = (e) => {
        const text = Array.from(e.results).map(r => r[0].transcript).join(' ');
        input.value = text;
        if (e.results[e.results.length - 1].isFinal) ask(text);
      };
      rec.onerror = (e) => { if (e.error !== 'aborted') add('sys', 'Mic error: ' + e.error); };
      rec.onend = () => {
        micBtn.classList.remove('listening'); dot.classList.remove('live'); rec = null;
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
        } else {
          awaitingQuestion = true;
          add('sys', 'Listening… ask your question.');
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
      wakeRec.onstart = () => dot.classList.add('live');
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
        dot.classList.remove('live');
        // Chrome ends recognition periodically — restart to stay always-on.
        if (wakeActive && !wakePaused && wakeBox.checked) setTimeout(startWakeLoop, 250);
      };
      wakeRec.start();
    }

    function stopWakeLoop() {
      wakeActive = false;
      if (wakeRec) { const r = wakeRec; wakeRec = null; r.stop(); }
      dot.classList.remove('live');
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

  add('sys', 'Click the mic and ask, or enable “wake word” and just say “hi helper — what did I commit to this week?” / “Što mi je danas prioritet?”');
})();
</script>
</body>
</html>
`;
