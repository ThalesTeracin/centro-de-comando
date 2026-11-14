import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CFG = path.join(ROOT, 'config.json');
const MAX_STEPS = 40;
const MAX_OUT = 20000;
const loadCfg = async () => JSON.parse(await readFile(CFG, 'utf8'));

// ---------- tools ----------
function ps(command) {
  return new Promise(resolve => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    const t = setTimeout(() => { p.kill(); out += '\n[timeout 180s]'; }, 180000);
    p.on('close', code => { clearTimeout(t); resolve(`${out.trim()}\n[exit ${code}]`); });
    p.on('error', e => { clearTimeout(t); resolve('ERRO: ' + e.message); });
  });
}

// Captures all monitors, downscaled to <=1280px wide to save tokens; reports real size so clicks can be mapped back.
async function screenshot() {
  const file = path.join(tmpdir(), `cc-${randomUUID()}.png`);
  const out = await ps(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][W.U]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$w = [Math]::Min(1280, $b.Width); $h = [int]($b.Height * $w / $b.Width)
(New-Object System.Drawing.Bitmap $bmp, $w, $h).Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)
"$($b.Width) $($b.Height) $($b.Left) $($b.Top) $w"`);
  const m = out.match(/(-?\d+) (-?\d+) (-?\d+) (-?\d+) (\d+)/);
  if (!m) throw new Error(out);
  const [, W, H, L, T, w] = m.map(Number);
  const image = (await readFile(file)).toString('base64');
  await unlink(file).catch(() => {});
  const k = (W / w).toFixed(3);
  return { text: `Tela real ${W}x${H} (origem ${L},${T}); imagem reduzida a ${w}px de largura. Coordenada real = coordenada na imagem x ${k} + origem.`, image };
}

let page;
async function browser() {
  if (page && !page.isClosed()) return page;
  const { chromium } = await import('playwright-core');
  // Uses the Edge already installed on Windows: no browser download needed.
  const b = await chromium.launch({ channel: 'msedge', headless: false });
  page = await (await b.newContext()).newPage();
  return page;
}

export const TOOLS = {
  powershell: {
    description: 'Executa um comando PowerShell nesta máquina Windows: instalar (winget), configurar o sistema, gerenciar processos/arquivos, abrir apps, controlar teclado/mouse via .NET. Retorna stdout+stderr.',
    params: { command: 'Comando PowerShell' },
    run: ({ command }) => ps(command),
  },
  screenshot: {
    description: 'Captura a tela do Windows (todos os monitores) e mostra a imagem para você analisar: janelas abertas, erros, estado de apps. Para clicar, converta as coordenadas como indicado e use powershell.',
    params: {},
    run: screenshot,
  },
  read_file: {
    description: 'Lê um arquivo de texto.',
    params: { path: 'Caminho absoluto' },
    run: ({ path: p }) => readFile(p, 'utf8'),
  },
  write_file: {
    description: 'Cria ou sobrescreve um arquivo de texto (cria pastas).',
    params: { path: 'Caminho absoluto', content: 'Conteúdo completo' },
    run: async ({ path: p, content }) => { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, content); return `ok, ${content.length} caracteres`; },
  },
  list_dir: {
    description: 'Lista uma pasta.',
    params: { path: 'Caminho absoluto' },
    run: async ({ path: p }) => (await readdir(p, { withFileTypes: true })).map(d => (d.isDirectory() ? '[pasta] ' : '') + d.name).join('\n') || '(vazia)',
  },
  fetch_url: {
    description: 'Baixa o conteúdo de uma URL (HTML/JSON/texto) sem abrir o navegador.',
    params: { url: 'URL http(s)' },
    run: async ({ url }) => { const r = await fetch(url); return `HTTP ${r.status}\n${await r.text()}`; },
  },
  download_file: {
    description: 'Baixa um arquivo (instalador, zip, imagem, PDF…) de uma URL e salva no caminho indicado.',
    params: { url: 'URL http(s)', path: 'Caminho absoluto de destino, com nome do arquivo' },
    run: async ({ url, path: p }) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await mkdir(path.dirname(p), { recursive: true });
      await pipeline(Readable.fromWeb(r.body), createWriteStream(p));
      return `salvo em ${p} (${r.headers.get('content-length') || '?'} bytes)`;
    },
  },
  browser_open: {
    description: 'Abre uma URL no navegador controlado (Edge visível).',
    params: { url: 'URL' },
    run: async ({ url }) => { const p = await browser(); await p.goto(url, { waitUntil: 'domcontentloaded' }); return `aberto: ${await p.title()}`; },
  },
  browser_read: {
    description: 'Lê o texto da página atual e lista campos, botões e links com seus seletores.',
    params: {},
    run: async () => {
      const p = await browser();
      return p.url() + '\n' + await p.evaluate(() => {
        const sel = el => el.id ? '#' + CSS.escape(el.id) : el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : '';
        const els = [...document.querySelectorAll('input:not([type=hidden]),textarea,select,button,a[href]')].slice(0, 150)
          .map(el => `${el.tagName.toLowerCase()} ${sel(el)} ${el.type || ''} "${(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 60)}"`);
        return document.body.innerText.slice(0, 8000) + '\n\n--- elementos ---\n' + els.join('\n');
      });
    },
  },
  browser_screenshot: {
    description: 'Captura a área visível da página atual do navegador como imagem.',
    params: {},
    run: async () => { const p = await browser(); return { text: `${p.url()} — ${await p.title()}`, image: (await p.screenshot()).toString('base64') }; },
  },
  browser_click: {
    description: 'Clica num elemento. Aceita seletor CSS ou "text=Texto do botão".',
    params: { selector: 'Seletor' },
    run: async ({ selector }) => { const p = await browser(); await p.click(selector, { timeout: 10000 }); await p.waitForLoadState('domcontentloaded'); return 'clicado'; },
  },
  browser_fill: {
    description: 'Preenche um campo de formulário.',
    params: { selector: 'Seletor', value: 'Valor' },
    run: async ({ selector, value }) => { const p = await browser(); await p.fill(selector, value, { timeout: 10000 }); return 'preenchido'; },
  },
  ask_agent: {
    description: 'Envia uma tarefa a outro agente do centro de comando e recebe a resposta final dele.',
    params: { agent: 'Nome do agente', message: 'Tarefa completa com todo o contexto necessário' },
  },
};

const schema = t => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(TOOLS[t].params).map(([k, d]) => [k, { type: 'string', description: d }])),
  required: Object.keys(TOOLS[t].params),
});

export function validInput(tool, input) {
  return !!TOOLS[tool] && input && typeof input === 'object' && Object.keys(TOOLS[tool].params).every(k => typeof input[k] === 'string');
}

const key = prov => prov.apiKey || (prov.apiKeyEnv && process.env[prov.apiKeyEnv]) || undefined;

// ---------- agent loop ----------
async function runAgent(ctx, name, history, depth = 0) {
  const { cfg, emit } = ctx;
  const agent = cfg.agents.find(a => a.name === name);
  if (!agent) throw new Error(`agente "${name}" não existe`);
  const prov = cfg.providers[agent.provider];
  if (!prov) throw new Error(`provedor "${agent.provider}" não configurado`);

  let tools = (agent.tools || []).includes('*') ? Object.keys(TOOLS) : (agent.tools || []).filter(t => TOOLS[t]);
  if (depth >= 3) tools = tools.filter(t => t !== 'ask_agent');
  const team = cfg.agents.filter(a => a.name !== name).map(a => `- ${a.name}: ${a.role || ''}`).join('\n');
  const system = `${agent.system || ''}\n\nVocê é o agente "${name}". Sistema: Windows. Pasta do projeto: ${ROOT}.` +
    (tools.includes('ask_agent') ? `\nOutros agentes disponíveis via ask_agent:\n${team}` : '');

  const exec = async (tool, input) => {
    if (ctx.aborted) throw new Error('cancelado');
    emit({ type: 'tool', agent: name, tool, input });
    try {
      if (!tools.includes(tool)) throw new Error('ferramenta não permitida para este agente');
      if (!validInput(tool, input)) throw new Error('parâmetros inválidos');
      if (cfg.approval?.includes(tool) && !(await ctx.approve(name, tool, input))) return { text: 'O usuário NEGOU esta ação.' };
      const out = tool === 'ask_agent'
        ? await runAgent(ctx, input.agent, [{ role: 'user', text: `[Mensagem do agente ${name}]\n${input.message}` }], depth + 1)
        : await TOOLS[tool].run(input);
      const { text, image } = out && typeof out === 'object' ? out : { text: out };
      const s = String(text).slice(0, MAX_OUT);
      emit({ type: 'result', agent: name, tool, output: s.slice(0, 3000), image });
      return { text: s, image };
    } catch (e) {
      emit({ type: 'result', agent: name, tool, output: 'ERRO: ' + e.message, error: true });
      return { text: 'ERRO: ' + e.message, error: true };
    }
  };

  emit({ type: 'start', agent: name, depth });
  const text = prov.type === 'anthropic'
    ? await loopAnthropic(prov, agent, system, history, tools, exec, t => emit({ type: 'text', agent: name, depth, text: t }), ctx)
    : await loopOpenAI(prov, agent, system, history, tools, exec, t => emit({ type: 'text', agent: name, depth, text: t }), ctx);
  emit({ type: 'end', agent: name, depth });
  return text;
}

async function loopAnthropic(prov, agent, system, history, tools, exec, say, ctx) {
  const client = new Anthropic({ apiKey: key(prov), baseURL: prov.baseURL });
  const messages = history.map(m => ({ role: m.role, content: m.text }));
  const defs = tools.map(t => ({ name: t, description: TOOLS[t].description, input_schema: schema(t) }));
  let last = '';
  for (let i = 0; i < MAX_STEPS && !ctx.aborted; i++) {
    const res = await client.beta.messages.create({
      model: agent.model, max_tokens: 16000, system, messages,
      ...(defs.length && { tools: defs }),
      ...(agent.effort && { output_config: { effort: agent.effort } }),
      // Server-side fallback when a safety classifier declines (Opus 5.5 / Fable 5.1 / Sonnet 5.5).
      ...(agent.fallbacks && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    });
    messages.push({ role: 'assistant', content: res.content });
    const txt = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (txt) { say(txt); last = txt; }
    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason === 'refusal') return last || '(o modelo recusou a solicitação)';
    if (res.stop_reason !== 'tool_use') return last;
    const results = [];
    for (const b of res.content.filter(b => b.type === 'tool_use')) {
      const out = await exec(b.name, b.input);
      // shortcut: every screenshot stays in history for the whole turn; trim old images if long visual tasks get expensive.
      const content = out.image
        ? [{ type: 'text', text: out.text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: out.image } }]
        : out.text;
      results.push({ type: 'tool_result', tool_use_id: b.id, content, ...(out.error && { is_error: true }) });
    }
    messages.push({ role: 'user', content: results });
  }
  return last;
}

async function loopOpenAI(prov, agent, system, history, tools, exec, say, ctx) {
  const client = new OpenAI({ apiKey: key(prov) || 'none', baseURL: prov.baseURL, maxRetries: prov.maxRetries ?? 2 });
  const messages = [{ role: 'system', content: system }, ...history.map(m => ({ role: m.role, content: m.text }))];
  const defs = tools.map(t => ({ type: 'function', function: { name: t, description: TOOLS[t].description, parameters: schema(t) } }));
  let last = '';
  for (let i = 0; i < MAX_STEPS && !ctx.aborted; i++) {
    const res = await client.chat.completions.create({ model: agent.model, messages, ...(defs.length && { tools: defs }) });
    const msg = res.choices[0].message;
    messages.push(msg);
    if (msg.content?.trim()) { say(msg.content.trim()); last = msg.content.trim(); }
    if (!msg.tool_calls?.length) return last;
    const images = [];
    for (const c of msg.tool_calls) {
      let input = null;
      try { input = JSON.parse(c.function.arguments || '{}'); } catch {}
      const out = input ? await exec(c.function.name, input) : { text: 'ERRO: JSON de argumentos inválido' };
      messages.push({ role: 'tool', tool_call_id: c.id, content: out.text });
      if (out.image) images.push(out.image);
    }
    // Chat Completions tool messages are text-only, so images go in a follow-up user message (needs a vision model).
    if (images.length) messages.push({ role: 'user', content: [
      { type: 'text', text: 'Imagem(ns) retornada(s) pelas ferramentas acima:' },
      ...images.map(i => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + i } })),
    ] });
  }
  return last;
}

// ---------- http ----------
const pending = new Map();
const STATIC = {
  '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
  '/voz': ['voz.html', 'text/html'], '/voz.js': ['voz.js', 'text/javascript'],
};

const body = req => new Promise((ok, fail) => { let s = ''; req.on('data', d => s += d); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { fail(e); } }); });
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

export function trusted(req, port) {
  // Blocks other websites (CSRF) and DNS rebinding from reaching this local, machine-controlling API.
  const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!ok.has(req.headers.host)) return false;
  const o = req.headers.origin;
  return !o || ok.has(o.replace(/^https?:\/\//, ''));
}

async function handle(req, res, port) {
  if (!trusted(req, port)) return json(res, 403, { error: 'origem não permitida' });
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [f, type] = STATIC[url.pathname];
    res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
    return res.end(await readFile(path.join(ROOT, 'public', f)));
  }
  if (req.method !== 'GET' && req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'json obrigatório' });

  if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, await loadCfg());
  if (url.pathname === '/api/config' && req.method === 'PUT') {
    const c = await body(req);
    if (!c.providers || !Array.isArray(c.agents)) return json(res, 400, { error: 'config precisa de "providers" e "agents"' });
    await writeFile(CFG, JSON.stringify(c, null, 2));
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/approve' && req.method === 'POST') {
    const { id, ok } = await body(req);
    pending.get(id)?.(!!ok);
    pending.delete(id);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const { agent, messages } = await body(req);
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
    const mine = new Set();
    const ctx = {
      cfg: await loadCfg(),
      aborted: false,
      emit: e => { if (!res.writableEnded) res.write(JSON.stringify(e) + '\n'); },
      approve: (a, tool, input) => new Promise(r => { const id = randomUUID(); mine.add(id); pending.set(id, r); ctx.emit({ type: 'approve', id, agent: a, tool, input }); }),
    };
    res.on('close', () => { ctx.aborted = true; for (const id of mine) { pending.get(id)?.(false); pending.delete(id); } });
    try { await runAgent(ctx, agent, messages); }
    catch (e) { ctx.emit({ type: 'error', text: e.message }); }
    ctx.emit({ type: 'done' });
    return res.end();
  }
  json(res, 404, { error: 'não encontrado' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || (await loadCfg()).port || 7777;
  http.createServer((req, res) => handle(req, res, port).catch(e => { if (!res.headersSent) json(res, 500, { error: e.message }); else res.end(); }))
    .listen(port, '127.0.0.1', () => console.log(`Centro de Comando: http://127.0.0.1:${port}`));
}
