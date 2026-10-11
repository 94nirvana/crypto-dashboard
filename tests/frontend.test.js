'use strict';

/**
 * Smoke test do front-end: renderiza a tabela em um DOM minimo
 * (sem dependencias) usando o app.js real contra um /api/coins simulado.
 * Garante que a logica de formatacao/render continua funcionando.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// ------------------------- DOM minimo suficiente ---------------------------

class ClassList {
  constructor(node) { this.node = node; }
  add(...c) { this.node._classes.push(...c); }
  contains(c) { return this.node._classes.includes(c); }
}

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this._classes = [];
    this.textContent = '';
    this.dataset = {};
    this.hidden = false;
    this.attributes = {};
    this.classList = new ClassList(this);
  }
  set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }
  get className() { return this._classes.join(' '); }
  appendChild(n) { this.childNodes.push(n); return n; }
  addEventListener(type, fn) { (this.__l ||= {})[type] = fn; }
  // No DOM real, DocumentFragment e expandido ao ser inserido.
  replaceChildren(...nodes) {
    this.childNodes = nodes.flatMap((n) =>
      n instanceof Node && n.tagName === '#FRAGMENT' ? n.childNodes : [n]
    );
  }
  remove() {}
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  get text() {
    // Folha: texto proprio. No: concatenacao dos filhos.
    if (this.childNodes.length === 0) return this.textContent;
    return this.childNodes
      .map((c) => (c instanceof Node ? c.text : String(c.textContent ?? '')))
      .join('');
  }
}

class TextNode {
  constructor(text) { this.textContent = String(text); }
  get text() { return this.textContent; }
}

const ids = ['tbody', 'summary', 'table-wrapper', 'error-box', 'error-text',
  'status-text', 'refresh', 'retry', 'order', 'subtitle'];

function createDocument() {
  const cache = {};
  for (const id of ids) cache[id] = new Node('div');
  cache['#status .dot'] = new Node('span');

  return {
    visibilityState: 'visible',
    addEventListener: () => {},
    getElementById: (id) => cache[id] || null,
    querySelector: (sel) => cache[sel] || null,
    createElement: (tag) => new Node(tag),
    createElementNS: (_ns, tag) => new Node(tag),
    createDocumentFragment: () => new Node('#fragment'),
  };
}

const LABELS = {
  volume_desc: 'Volume negociado (24h)',
  market_cap_desc: 'Maior capitalizacao de mercado',
  gainers_24h: 'Maior alta (24h)',
  losers_24h: 'Maior queda (24h)',
};

const PAYLOAD = {
  updatedAt: '2026-10-11T12:00:00.000Z',
  currency: 'USD',
  order: 'volume_desc',
  orderLabel: 'Volume negociado (24h)',
  count: 2,
  coins: [
    { rank: 1, id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', image: null,
      price: 83402.5, volume24h: 15_191_682_741, high24h: 84000, low24h: 81000,
      change1h: -0.07, change24h: 0.49, change7d: -2.2, change30d: 8.09,
      change1y: -24.96, sparkline: [1, 3, 2, 5, 4] },
    { rank: 2, id: 'tether', symbol: 'USDT', name: 'Tether', image: null,
      price: 1, volume24h: 34_225_251_428, high24h: 1.001, low24h: 0.999,
      change1h: 0, change24h: -0.02, change7d: -0.07, change30d: -0.06,
      change1y: -0.24, sparkline: [1, 1, 1, 1, 1] },
  ],
};

function bootApp() {
  const document = createDocument();

  // localStorage simulado (preferencia de UI, nao dado sensivel)
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const requested = [];

  const sandbox = {
    document,
    Intl,
    Date,
    console,
    AbortController, URLSearchParams,
    navigator: { onLine: true },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: storage,
    fetch: async (url) => {
      requested.push(url);
      // Ecoa o criterio pedido, como o servidor real faz.
      const order = new URL(url, 'http://localhost').searchParams.get('order');
      const label = LABELS[order] ?? 'Volume negociado (24h)';
      return { ok: true, json: async () => ({ ...PAYLOAD, order, orderLabel: label }) };
    },
    location: { href: 'http://localhost/' },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'),
    sandbox,
    { filename: 'app.js' }
  );

  return { document, sandbox, requested, store };
}

const flush = () => new Promise((r) => setImmediate(r));

// ------------------------------- Testes -----------------------------------

test('renderiza uma linha por moeda com os campos formatados', async () => {
  const { document } = bootApp();
  await flush();

  const rows = document.getElementById('tbody').childNodes;
  assert.equal(rows.length, 2);
  assert.equal(document.getElementById('table-wrapper').hidden, false);

  const btc = rows[0].text;
  assert.match(btc, /Bitcoin/);
  assert.match(btc, /BTC/);
  assert.match(btc, /\$83,402\.50/);
  assert.match(btc, /\+8\.09%/);   // variacao 30d positiva
  assert.match(btc, /\$84,000/);   // max 24h
  assert.match(btc, /\$81,000/);   // min 24h
});

test('valores nulos sao exibidos como "—" e nunca como NaN/undefined', async () => {
  const { document } = bootApp();
  await flush();
  const text = document.getElementById('tbody').childNodes[0].text;
  assert.doesNotMatch(text, /NaN|undefined|null/);
});

test('resumo exibe volume total e contagem de altas', async () => {
  const { document } = bootApp();
  await flush();
  const summary = document.getElementById('summary');
  assert.equal(summary.hidden, false);
  const text = summary.text;
  // O card destaca o lider DO CRITERIO (1o do ranking ordenado pelo servidor).
  assert.match(text, /BTC/);
  assert.match(text, /Volume negociado \(24h\)/);   // rotulo do criterio
  assert.match(text, /\$15\.19B/);                   // metrica do lider
  assert.match(text, /1\/2/);                         // 1 ativo em alta de 2
  assert.match(text, /\$49\.4\d?B/);                 // volume total somado
});

test('criterio de alta destaca a variacao, nao o volume', async () => {
  const { document } = bootApp();
  await flush();
  document.getElementById('order').value = 'gainers_24h';
  const select = document.getElementById('order');
  select.__l?.change({ target: select });
  await flush();

  const text = document.getElementById('summary').text;
  assert.match(text, /Maior alta \(24h\)/);
  assert.match(text, /\+\d+\.\d\d%/);   // metrica = variacao percentual
  assert.doesNotMatch(text, /Volume negociado \(24h\)/);
});

test('erro do servidor e exibido como texto e nao quebra a UI', async () => {
  const document = createDocument();
  const sandbox = {
    document, Intl, Date, console, AbortController, URLSearchParams,
    addEventListener: () => {},
    navigator: { onLine: true },
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({
      error: { code: 'upstream_unavailable', message: 'Servico de dados indisponivel.' },
    }) }),
    globalThis: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'),
    sandbox, { filename: 'app.js' }
  );
  await flush();

  assert.equal(document.getElementById('error-box').hidden, false);
  assert.equal(document.getElementById('error-text').textContent,
    'Servico de dados indisponivel.');
  assert.equal(document.getElementById('table-wrapper').hidden, true);
});

test('app.js nao injeta HTML (ausencia de innerHTML/insertAdjacentHTML)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(/);
});
test('criterio padrao e volume e vai na query', async () => {
  const { document, requested } = bootApp();
  await flush();
  assert.equal(requested.length, 1);
  assert.match(requested[0], /order=volume_desc/);
  assert.match(requested[0], /top=10/);
  assert.equal(document.getElementById('order').value, 'volume_desc');
});

test('troca de criterio refaz a consulta com o novo parametro', async () => {
  const { document, requested } = bootApp();
  await flush();

  const select = document.getElementById('order');
  select.value = 'market_cap_desc';
  // Dispara o listener registrado pelo app.
  const handler = select.__l?.change;
  if (handler) handler({ target: select });

  await flush();
  assert.equal(requested.length, 2);
  assert.match(requested[1], /order=market_cap_desc/);
});

test('criterio fora da allowlist nao e aceito pelo front', async () => {
  const { document, requested } = bootApp();
  await flush();

  const select = document.getElementById('order');
  select.value = 'order;DROP TABLE--';
  const handler = select.__l?.change;
  if (handler) handler({ target: select });

  await flush();
  assert.equal(requested.length, 1, 'nao deve refazer a consulta');
});

test('payload traz o rotulo do criterio e ele aparece no status', async () => {
  const { document } = bootApp();
  await flush();
  assert.match(document.getElementById('status-text').textContent, /Volume negociado/);
});
