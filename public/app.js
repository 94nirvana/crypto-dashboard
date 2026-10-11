'use strict';

/**
 * Front-end: renderiza o ranking por volume.
 *
 * Seguranca (AppSec):
 *  - Zero uso de innerHTML: todo texto entra via textContent (evita XSS DOM).
 *  - SVGs construidos via createElementNS, sem interpolar strings de markup.
 *  - Erros do servidor exibidos como texto, nunca concatenados em HTML.
 */

const els = {
  tbody: document.getElementById('tbody'),
  summary: document.getElementById('summary'),
  wrapper: document.getElementById('table-wrapper'),
  errorBox: document.getElementById('error-box'),
  errorText: document.getElementById('error-text'),
  statusText: document.getElementById('status-text'),
  subtitle: document.getElementById('subtitle'),
  statusDot: document.querySelector('#status .dot'),
  refresh: document.getElementById('refresh'),
  retry: document.getElementById('retry'),
  order: document.getElementById('order'),
};

const REFRESH_MS = 60_000;
const CRITERIA_KEY = 'crypto-dashboard.order';
let timer = null;
let inFlight = false;
let currentOrder = 'volume_desc';

/**
 * Allowlist local: so valores listados sao enviados.
 * (O servidor tambem valida — validacao em duas camadas, nao uma.)
 */
const ALLOWED_ORDERS = new Set([
  'volume_desc',
  'market_cap_desc',
  'gainers_24h',
  'losers_24h',
]);

/** Metrica de destaque do card "Lider do ranking", por criterio. */
const HIGHLIGHT = {
  volume_desc: 'volume24h',
  market_cap_desc: 'marketCap',
  gainers_24h: 'change24h',
  losers_24h: 'change24h',
};

/** Le a preferencia salva. Nao e dado sensivel, apenas UI. */
function readSavedOrder() {
  try {
    const saved = localStorage.getItem(CRITERIA_KEY);
    return ALLOWED_ORDERS.has(saved) ? saved : 'volume_desc';
  } catch {
    return 'volume_desc'; // localStorage bloqueado (modo privado)
  }
}

function saveOrder(value) {
  try {
    localStorage.setItem(CRITERIA_KEY, value);
  } catch {
    /* preferencia e opcional: falha silenciosa */
  }
}

// ------------------------------ Formatadores ------------------------------

const fmtUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtCompact(value) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/** Preco de cripto varia em varias casas: ajusta pelo magnitude. */
function fmtPrice(value) {
  if (!Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 2 : value >= 1 ? 2 : value >= 0.01 ? 4 : 8;
  return fmtUsd.format(Number(value.toFixed(digits)));
}

const direction = (v) => (!Number.isFinite(v) || v === 0 ? 'flat' : v > 0 ? 'pos' : 'neg');

// ------------------------------ DOM helpers -------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function td(className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  return cell;
}

function setStatus(state, text) {
  els.statusDot.dataset.state = state;
  els.statusText.textContent = text;
}

// ------------------------------ Sparkline ---------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function buildSparkline(values, directionClass) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '104');
  svg.setAttribute('height', '28');
  svg.setAttribute('viewBox', '0 0 104 28');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  if (!values || values.length < 2) return svg;

  const w = 104;
  const h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);

  const points = values
    .map((v, i) => `${(i * step).toFixed(2)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(2)}`)
    .join(' ');

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');

  const color =
    directionClass === 'pos' ? '#3fb950' : directionClass === 'neg' ? '#f85149' : '#8b949e';
  line.setAttribute('stroke', color);

  svg.appendChild(line);
  return svg;
}

// ------------------------------ Renderizacao ------------------------------

function renderRow(coin) {
  const row = document.createElement('tr');

  // Rank
  const rankCell = td('col-rank');
  rankCell.appendChild(el('span', coin.rank <= 3 ? 'rank top' : 'rank', String(coin.rank)));
  row.appendChild(rankCell);

  // Ativo
  const assetCell = td('col-asset');
  const asset = el('div', 'asset');
  if (coin.image) {
    const img = document.createElement('img');
    img.src = coin.image;
    img.alt = '';
    img.loading = 'lazy';
    img.width = 22;
    img.height = 22;
    img.addEventListener('error', () => img.remove(), { once: true });
    asset.appendChild(img);
  }
  const labels = el('div');
  labels.appendChild(el('div', 'asset-name', coin.name));
  labels.appendChild(el('div', 'asset-symbol', coin.symbol));
  asset.appendChild(labels);
  assetCell.appendChild(asset);
  row.appendChild(assetCell);

  // Preco
  const priceCell = td('num');
  priceCell.textContent = fmtPrice(coin.price);
  row.appendChild(priceCell);

  // Variacoes
  const variations = [
    ['change1h', '1h'],
    ['change24h', '24h'],
    ['change7d', '7d'],
    ['change30d', '30d'],
    ['change1y', '1y'],
  ];
  for (const [key] of variations) {
    const cell = td('num');
    cell.appendChild(el('span', `chip ${direction(coin[key])}`, fmtPct(coin[key])));
    row.appendChild(cell);
  }

  // Max / Min 24h
  row.appendChild(Object.assign(td('num'), { textContent: fmtPrice(coin.high24h) }));
  row.appendChild(Object.assign(td('num'), { textContent: fmtPrice(coin.low24h) }));

  // Volume
  const volCell = td('num');
  volCell.appendChild(el('span', 'vol', fmtCompact(coin.volume24h)));
  row.appendChild(volCell);

  // Sparkline
  const sparkCell = td('spark');
  sparkCell.appendChild(buildSparkline(coin.sparkline, direction(coin.change7d)));
  row.appendChild(sparkCell);

  return row;
}

function renderSummary(coins, updatedAt, orderLabel = 'maior volume', order = 'volume_desc') {
  const totalVolume = coins.reduce((acc, c) => acc + (c.volume24h || 0), 0);
  const gainers = coins.filter((c) => Number.isFinite(c.change24h) && c.change24h > 0).length;
  const avgChange = coins.length
    ? coins.reduce((acc, c) => acc + (c.change24h || 0), 0) / coins.length
    : 0;
  // Nao assumir ordenacao: o primeiro do recorte ja vem ordenado pelo
  // criterio pedido ao servidor, e e ele que o card destaca.
  const leader = coins[0] ?? null;
  const metric = HIGHLIGHT[order] ?? 'volume24h';

  const fmtMetric = (coin) => {
    if (!coin) return '';
    if (metric === 'change24h') return fmtPct(coin.change24h);
    if (metric === 'marketCap') return fmtCompact(coin.marketCap);
    return fmtCompact(coin.volume24h);
  };

  const cards = [
    {
      label: 'Volume total 24h',
      value: fmtCompact(totalVolume),
      sub: `${coins.length} ativos`,
    },
    {
      label: 'Lider do ranking',
      value: leader ? leader.symbol : '—',
      sub: leader ? `${orderLabel} · ${fmtMetric(leader)}` : '',
    },
    {
      label: 'Em alta (24h)',
      value: `${gainers}/${coins.length}`,
      sub: `${((gainers / (coins.length || 1)) * 100).toFixed(0)}% do universo`,
    },
    {
      label: 'Variacao media 24h',
      value: fmtPct(avgChange),
      sub: `Atualizado ${updatedAt}`,
      cls: direction(avgChange),
    },
  ];

  const fragment = document.createDocumentFragment();
  for (const card of cards) {
    const node = el('div', 'card');
    node.appendChild(el('div', 'card-label', card.label));
    node.appendChild(el('div', `card-value ${card.cls || ''}`.trim(), card.value));
    if (card.sub) node.appendChild(el('div', 'card-sub', card.sub));
    fragment.appendChild(node);
  }

  els.summary.replaceChildren(fragment);
  els.summary.hidden = false;
}

function render(coins, updatedAt, orderLabel, order) {
  const fragment = document.createDocumentFragment();
  for (const coin of coins) fragment.appendChild(renderRow(coin));

  els.tbody.replaceChildren(fragment);
  renderSummary(coins, updatedAt, orderLabel, order);
  els.wrapper.hidden = false;
}

// -------------------------------- Dados -----------------------------------

async function load() {
  if (inFlight) return;
  inFlight = true;
  els.refresh.dataset.loading = 'true';
  setStatus('loading', 'Carregando dados de mercado...');
  els.errorBox.hidden = true;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const query = new URLSearchParams({ top: '10', order: currentOrder });
    const res = await fetch(`/api/coins?${query.toString()}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const message = body?.error?.message || `Falha na requisicao (HTTP ${res.status}).`;
      throw new Error(message);
    }

    const data = await res.json();
    if (!Array.isArray(data.coins) || data.coins.length === 0) {
      throw new Error('Nenhum dado retornado pela fonte.');
    }

    render(
      data.coins,
      new Date(data.updatedAt).toLocaleTimeString('pt-BR'),
      data.orderLabel,
      data.order
    );
    setStatus(
      'ok',
      `${data.orderLabel} · atualizado ${new Date(data.updatedAt).toLocaleTimeString('pt-BR')}`
    );
    els.subtitle.textContent = `Top 10 · ${data.orderLabel}`;
  } catch (err) {
    const offline = err.name === 'AbortError' || !navigator.onLine;
    els.errorText.textContent = offline
      ? 'Sem conexao ou tempo limite excedido. Verifique a rede e tente novamente.'
      : err.message;
    els.errorBox.hidden = false;
    els.wrapper.hidden = true;
    els.summary.hidden = true;
    setStatus('error', 'Falha ao atualizar dados');
  } finally {
    inFlight = false;
    els.refresh.dataset.loading = 'false';
  }
}

function startAutoRefresh() {
  if (timer) clearInterval(timer);
  timer = setInterval(load, REFRESH_MS);
}

els.order.addEventListener('change', (event) => {
  const value = event.target.value;
  if (!ALLOWED_ORDERS.has(value)) return; // defense in depth
  currentOrder = value;
  saveOrder(value);
  load();
});

els.refresh.addEventListener('click', load);
els.retry.addEventListener('click', load);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

currentOrder = readSavedOrder();
els.order.value = currentOrder;

load();
startAutoRefresh();