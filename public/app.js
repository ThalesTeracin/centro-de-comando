const $ = id => document.getElementById(id);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const md = s => esc(s)
  .replace(/```\w*\n?([\s\S]*?)```/g, '<pre>$1</pre>')
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

let cfg, current = store.get('cc.agent'), busy = null;

// ---------- clock ----------
function tick() {
  const d = new Date();
  $('hm').textContent = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  $('ss').textContent = String(d.getSeconds()).padStart(2, '0');
  $('date').textContent = d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
}
tick(); setInterval(tick, 1000);

// ---------- weather (Open-Meteo, no key) ----------
const WMO = c => c === 0 ? ['☀', 'Céu limpo'] : c <= 3 ? ['⛅', 'Parcialmente nublado'] : c <= 48 ? ['🌫', 'Neblina']
  : c <= 67 ? ['🌧', 'Chuva'] : c <= 77 ? ['❄', 'Neve'] : c <= 82 ? ['🌦', 'Pancadas'] : ['⛈', 'Tempestade'];
async function weather(lat, lon, city) {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`);
    const { current: c } = await r.json();
    const [icon, label] = WMO(c.weather_code);
    $('wIcon').textContent = icon;
    $('wTemp').textContent = Math.round(c.temperature_2m) + '°';
    $('wCity').textContent = city;
    $('weather').title = `${label} · ${c.temperature_2m} °C`;
  } catch { $('wCity').textContent = 'sem clima'; }
}
function startWeather() {
  const w = cfg.weather || {};
  const run = (lat, lon, city) => { weather(lat, lon, city); setInterval(() => weather(lat, lon, city), 15 * 60e3); };
  if (w.lat != null) return run(w.lat, w.lon, w.city || '');
  navigator.geolocation?.getCurrentPosition(p => run(p.coords.latitude.toFixed(2), p.coords.longitude.toFixed(2), 'Local'), () => {});
}

// ---------- agents ----------
function renderAgents() {
  if (!cfg.agents.some(a => a.name === current)) current = cfg.agents[0]?.name;
  $('agents').innerHTML = cfg.agents.map(a =>
    `<a tabindex="0" data-name="${esc(a.name)}" class="${a.name === current ? 'on' : ''}">${esc(a.name)}<small>${esc(a.provider)} · ${esc(a.model)}</small></a>`).join('');
  renderHistory();
}
$('agents').addEventListener('click', e => { const a = e.target.closest('a'); if (a && !busy) { current = a.dataset.name; store.set('cc.agent', current); renderAgents(); } });
$('agents').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.click(); });

const hist = () => store.get('cc.hist.' + current, []);
function renderHistory() {
  $('log').innerHTML = '';
  for (const m of hist()) add(m.role === 'user' ? 'msg user' : 'msg', m.role === 'user' ? md(m.text) : `<span class="who">${esc(current)}</span>${md(m.text)}`);
}
function add(cls, html, parent = $('log')) {
  const el = document.createElement('div');
  el.className = cls; el.innerHTML = html;
  parent.appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
  return el;
}
$('clear').onclick = () => { store.set('cc.hist.' + current, []); renderHistory(); };

// ---------- chat ----------
async function send(text) {
  const h = hist();
  h.push({ role: 'user', text });
  store.set('cc.hist.' + current, h);
  add('msg user', md(text));
  busy = new AbortController();
  $('send').textContent = 'Parar';
  const stack = [$('log')];   // nested containers for delegated agents
  const tools = [];
  let final = '';
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: busy.signal,
      body: JSON.stringify({ agent: current, messages: h }),
    });
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) if (l) onEvent(JSON.parse(l));
    }
  } catch (e) { if (e.name !== 'AbortError') add('msg error', esc(e.message)); }
  if (final) { h.push({ role: 'assistant', text: final }); store.set('cc.hist.' + current, h); }
  busy = null; $('send').textContent = 'Enviar';

  function onEvent(e) {
    const box = stack.at(-1);
    if (e.type === 'start' && e.depth > 0) stack.push(add('sub', `<span class="msg"><span class="who">→ ${esc(e.agent)}</span></span>`, box));
    else if (e.type === 'end' && e.depth > 0) stack.pop();
    else if (e.type === 'text') { add('msg', `<span class="who">${esc(e.agent)}</span>${md(e.text)}`, box); if (e.depth === 0) final = e.text; }
    else if (e.type === 'tool') {
      const d = document.createElement('details'); d.className = 'tool';
      const arg = Object.values(e.input || {}).join(' · ');
      d.innerHTML = `<summary>${esc(e.tool)}  ${esc(arg.slice(0, 140))}</summary><pre>${esc(JSON.stringify(e.input, null, 2))}</pre>`;
      box.appendChild(d); tools.push(d);
    }
    else if (e.type === 'result') {
      const d = tools.findLast(t => !t.dataset.done && t.querySelector('summary').textContent.startsWith(e.tool)) || tools.at(-1);
      if (d) { d.dataset.done = 1; d.insertAdjacentHTML('beforeend', `<pre>${esc(e.output)}</pre>`); if (e.image) { d.insertAdjacentHTML('beforeend', `<img class="shot" alt="Captura de tela" src="data:image/png;base64,${e.image}">`); d.open = true; } if (e.error) d.classList.add('err'); }
    }
    else if (e.type === 'approve') {
      const c = add('approve', `<b>${esc(e.agent)}</b> quer executar <b>${esc(e.tool)}</b><pre>${esc(JSON.stringify(e.input, null, 2))}</pre><div class="row"><button>Aprovar</button><button class="no">Negar</button></div>`, box);
      const [yes, no] = c.querySelectorAll('button');
      const answer = ok => { fetch('/api/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: e.id, ok }) }); c.querySelector('.row').textContent = ok ? '✓ aprovado' : '✕ negado'; };
      yes.onclick = () => answer(true); no.onclick = () => answer(false);
      yes.focus();
    }
    else if (e.type === 'error') add('msg error', esc(e.text), box);
    $('log').scrollTop = $('log').scrollHeight;
  }
}

$('form').onsubmit = e => {
  e.preventDefault();
  if (busy) return busy.abort();
  const t = $('input').value.trim();
  if (!t || !current) return;
  $('input').value = ''; $('input').style.height = '';
  send(t);
};
$('input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); } });
$('input').addEventListener('input', e => { e.target.style.height = ''; e.target.style.height = e.target.scrollHeight + 'px'; });

// ---------- settings ----------
$('openCfg').onclick = async () => {
  $('cfgText').value = JSON.stringify(await (await fetch('/api/config')).json(), null, 2);
  $('cfgMsg').textContent = '';
  $('cfg').showModal();
};
$('saveCfg').onclick = async e => {
  e.preventDefault();
  let c;
  try { c = JSON.parse($('cfgText').value); } catch (err) { $('cfgMsg').textContent = 'JSON inválido: ' + err.message; return; }
  const r = await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) });
  if (!r.ok) { $('cfgMsg').textContent = (await r.json()).error; return; }
  cfg = c; renderAgents(); $('cfg').close();
};

(async () => { cfg = await (await fetch('/api/config')).json(); renderAgents(); startWeather(); })();
