const $ = id => document.getElementById(id);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const YES = /\b(sim|pode|aprovo|aprovado|confirmo|ok|okay|claro|manda)\b/i;
let busy = false, wakeRe = null, wakeRec = null;

setInterval(() => $('clock').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), 1000);
const state = s => { document.body.dataset.s = s; $('state').textContent = s; };
const log = (cls, html) => { const el = document.createElement('div'); el.className = cls; el.innerHTML = html; $('log').appendChild(el); $('log').scrollTop = 1e9; return el; };

// ---------- voice ----------
function speak(text) {
  // Code and markdown are unreadable aloud; show them, speak the rest.
  const plain = text.replace(/```[\s\S]*?```/g, ' código na tela. ').replace(/[*_`#>|]/g, '').slice(0, 700);
  return new Promise(res => {
    if (!window.speechSynthesis || !plain.trim()) return res();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(plain);
    u.lang = 'pt-BR';
    u.voice = speechSynthesis.getVoices().find(v => v.lang === 'pt-BR' && /Natural|Online/.test(v.name))
      || speechSynthesis.getVoices().find(v => v.lang === 'pt-BR') || null;
    u.onend = u.onerror = () => res();
    state('falando');
    speechSynthesis.speak(u);
  });
}

function listen() {
  return new Promise(res => {
    if (!SR) { log('error', 'Reconhecimento de voz indisponível neste navegador. Use o Edge ou digite.'); return res(''); }
    stopWake();
    speechSynthesis.cancel();
    const r = new SR();
    r.lang = 'pt-BR'; r.interimResults = true;
    let final = '';
    r.onresult = e => {
      const t = [...e.results].map(x => x[0].transcript).join('');
      $('heard').textContent = t;
      if (e.results[e.results.length - 1].isFinal) final = t;
    };
    r.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') log('error', 'microfone: ' + esc(e.error)); };
    r.onend = () => { state('parado'); res(final.trim()); };
    state('ouvindo');
    r.start();
  });
}

// Always-on listening for the wake word; "Brow, <comando>" runs at once, "Brow" alone asks for the command.
function wake() {
  if (!SR || !wakeRe || !$('cont').checked || busy || wakeRec) return;
  const r = wakeRec = new SR();
  r.lang = 'pt-BR'; r.continuous = true; r.interimResults = true;
  r.onresult = e => {
    const res = e.results[e.results.length - 1];
    const t = res[0].transcript;
    const m = t.match(wakeRe);
    if (!m) return;
    $('heard').textContent = t;
    if (!res.isFinal) return;
    const cmd = t.slice(m.index + m[0].length).replace(/^[\s,.!?:;]+/, '').trim();
    stopWake();
    if (cmd) run(cmd);
    else speak('Sim?').then(listen).then(run);
  };
  r.onerror = e => { if (e.error === 'not-allowed') { $('cont').checked = false; log('error', 'Microfone bloqueado: permita o acesso ao microfone.'); } };
  r.onend = () => { wakeRec = null; setTimeout(wake, 300); };   // recognizer stops by itself every so often
  r.start();
  state('aguardando');
}
function stopWake() { const r = wakeRec; wakeRec = null; if (r) { r.onend = null; r.abort(); } }

// ---------- chat ----------
async function run(text) {
  if (!text || busy) return wake();
  stopWake();
  busy = true;
  $('heard').textContent = '“' + text + '”';
  const agent = $('agent').value;
  const hist = store.get('cc.voz.hist', []).slice(-20);
  hist.push({ role: 'user', text });
  state('pensando');
  let final = '';
  const asks = [];
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent, messages: hist }) });
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) if (l) onEvent(JSON.parse(l));
    }
  } catch (e) { log('error', esc(e.message)); }
  await Promise.all(asks);
  if (final) { hist.push({ role: 'assistant', text: final }); store.set('cc.voz.hist', hist); await speak(final); }
  state('parado');
  busy = false;
  wake();

  function onEvent(e) {
    if (e.type === 'text') { log('say', esc(e.depth ? `[${e.agent}] ${e.text}` : e.text)); if (!e.depth) final = e.text; }
    else if (e.type === 'tool') log('act', '⚙ ' + esc(`${e.agent}: ${e.tool} ${Object.values(e.input || {}).join(' · ')}`));
    else if (e.type === 'result' && e.error) log('act err', esc(e.output));
    else if (e.type === 'error') log('error', esc(e.text));
    else if (e.type === 'approve') asks.push(approve(e));
  }
}

async function approve(e) {
  const box = log('ask', `<b>${esc(e.agent)}</b> quer executar <b>${esc(e.tool)}</b><pre>${esc(JSON.stringify(e.input, null, 2))}</pre><button>Aprovar</button> <button class="no">Negar</button>`);
  let answered = false;
  const answer = ok => {
    if (answered) return; answered = true;
    fetch('/api/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: e.id, ok }) });
    box.querySelectorAll('button').forEach(b => b.remove());
    box.insertAdjacentText('beforeend', ok ? '✓ aprovado' : '✕ negado');
    state('pensando');
  };
  const [yes, no] = box.querySelectorAll('button');
  yes.onclick = () => answer(true); no.onclick = () => answer(false);
  // Voice approval; buttons keep working if speech fails or is unclear.
  await speak(`Posso executar ${e.tool.replace('_', ' ')}? Diga sim ou não.`);
  if (!answered) { const said = await listen(); if (said && !answered) answer(YES.test(said)); }
}

// ---------- controls ----------
$('orb').onclick = async () => { if (!busy) run(await listen()); };
document.addEventListener('keydown', e => { if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') { e.preventDefault(); $('orb').click(); } });
$('f').onsubmit = e => { e.preventDefault(); const t = $('txt').value.trim(); $('txt').value = ''; run(t); };
$('agent').onchange = () => store.set('cc.voz.agent', $('agent').value);
$('cont').checked = store.get('cc.voz.wake', true);
$('cont').onchange = () => { store.set('cc.voz.wake', $('cont').checked); if ($('cont').checked) wake(); else { stopWake(); state('parado'); } };
speechSynthesis?.getVoices();   // warms up the voice list

(async () => {
  const cfg = await (await fetch('/api/config')).json();
  const saved = store.get('cc.voz.agent', 'Assistente');
  $('agent').innerHTML = cfg.agents.map(a => `<option ${a.name === saved ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const words = cfg.wakeWords?.length ? cfg.wakeWords : ['brow'];
  $('wakeName').textContent = words[0][0].toUpperCase() + words[0].slice(1);
  // Unicode-aware word boundary, so accented variants like "brô" match.
  wakeRe = new RegExp(`(?<!\\p{L})(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?!\\p{L})`, 'iu');
  wake();
})();
