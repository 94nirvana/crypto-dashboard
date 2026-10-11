'use strict';

/**
 * Servidor HTTP sem dependencias externas (Node >= 18).
 *
 * Decisoes de arquitetura (ver ARQUITETO_SOFTWARE_APPSEC.md):
 *  - Zero dependencias de terceiros: reduz superficie de supply chain.
 *  - Static files servidos por allowlist de extensao + resolucao canonica
 *    (previne path traversal).
 *  - CSP estrita sem 'unsafe-inline'/'unsafe-eval'; scripts e CSS externos.
 *  - Rate limiting por IP com janela deslizante simples (in-memory).
 *  - Cache em memoria com TTL para nao acabar com a cota da API upstream.
 *  - Timeout explicito + retry com backoff exponencial e jitter.
 *  - Erros nunca vazam stack trace ou detalhe interno ao cliente.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CONFIG = Object.freeze({
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1',
  publicDir: path.join(__dirname, 'public'),
  upstream: process.env.UPSTREAM_URL || 'https://api.coingecko.com/api/v3',
  cacheTtlMs: 60_000,
  upstreamTimeoutMs: 8_000,
  maxRetries: 2,
  rateLimit: { windowMs: 60_000, max: 60 },
  maxTop: 50,
  // Universo consultado para criterios que exigem ordenacao local.
  universeSize: 250,
});

/**
 * Allowlist de criterios de ordenacao. Nunca interpolar valor vindo do
 * cliente direto na query upstream: escolher apenas uma entrada conhecida.
 *
 * A CoinGecko aceita apenas um conjunto fechado de valores em `order`
 * (market_cap_desc|market_cap_asc|volume_desc|volume_asc|id) e IGNORA
 * silenciosamente qualquer outro, devolvendo market_cap_desc. Por isso os
 * criterios de alta/queda sao ordenados localmente sobre um universo maior.
 */
// Apenas o que a CoinGecko aceita. `*_asc` nao e exposto ao usuario: ordenar
// pelo menor volume/capitalizacao retornatokens sem liquidez e sem utilidade.
const UPSTREAM_ORDERS = Object.freeze([
  'market_cap_desc',
  'volume_desc',
]);

const CRITERIA = Object.freeze({
  volume_desc: {
    label: 'Volume negociado (24h)',
    order: 'volume_desc',
    perPage: CONFIG.maxTop,
  },
  market_cap_desc: {
    label: 'Maior capitalizacao de mercado',
    order: 'market_cap_desc',
    perPage: CONFIG.maxTop,
  },
  gainers_24h: {
    label: 'Maior alta (24h)',
    // Universe maior + ordenacao local: o upstream nao sabe ordenar por variacao.
    order: 'market_cap_desc',
    perPage: CONFIG.universeSize,
    sortBy: 'change24h',
    dir: 'desc',
  },
  losers_24h: {
    label: 'Maior queda (24h)',
    order: 'market_cap_desc',
    perPage: CONFIG.universeSize,
    sortBy: 'change24h',
    dir: 'asc',
  },
});

const DEFAULT_CRITERIA = 'volume_desc';

const COINGECKO_IMAGE_HOSTS = new Set([
  'assets.coingecko.com',
  'coin-images.coingecko.com',
]);

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
});

// ---------------------------------------------------------------------------
// Infraestrutura: log estruturado (correlacao por requestId, sem PII/secrets)
// ---------------------------------------------------------------------------

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...meta,
  };
  // stdout em processo: nunca logar para o cliente.
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

const randomId = () => require('node:crypto').randomUUID();

// ---------------------------------------------------------------------------
// Rate limiting (janela deslizante simples)
// ---------------------------------------------------------------------------

const buckets = new Map();

function rateLimit(req, res, limit) {
  const now = Date.now();
  const key = req.socket.remoteAddress || 'unknown';
  const hits = (buckets.get(key) || []).filter((t) => now - t < limit.windowMs);

  if (hits.length >= limit.max) {
    const retryAfter = Math.ceil((limit.windowMs - (now - hits[0])) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('X-RateLimit-Limit', String(limit.max));
    res.setHeader('X-RateLimit-Remaining', '0');
    return false;
  }

  hits.push(now);
  buckets.set(key, hits);

  // Limpeza periodica de buckets ociosos para nao crescer indefinidamente.
  if (buckets.size > 5_000) {
    for (const [k, v] of buckets) {
      if (!v.some((t) => now - t < limit.windowMs)) buckets.delete(k);
    }
  }

  res.setHeader('X-RateLimit-Limit', String(limit.max));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit.max - hits.length)));
  return true;
}

// ---------------------------------------------------------------------------
// Cliente upstream: timeout, retry idempotente, normalizacao do payload
// ---------------------------------------------------------------------------

/** Cache por criterio de ordenacao: Map<orderUpstream, {data, expiresAt}>. */
const cache = new Map();

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'user-agent': 'crypto-dashboard/1.0',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchMarkets(criterion) {
  // defense in depth: so ordem documentada chega a query
  if (!UPSTREAM_ORDERS.includes(criterion.order)) {
    throw new Error(`ordem upstream nao suportada: ${criterion.order}`);
  }

  const url =
    `${CONFIG.upstream}/coins/markets` +
    `?vs_currency=usd&order=${criterion.order}&per_page=${criterion.perPage}` +
    '&page=1&sparkline=true&price_change_percentage=1h%2C24h%2C7d%2C30d%2C1y';

  let lastError;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, CONFIG.upstreamTimeoutMs);
      if (res.status === 429) {
        throw Object.assign(new Error('upstream rate limited'), { retryable: true });
      }
      if (!res.ok) {
        throw Object.assign(new Error(`upstream status ${res.status}`), { retryable: false });
      }
      const coins = normalize(await res.json(), criterion.perPage);

      if (!criterion.sortBy) return coins;

      // Ordenacao local estavel; valores ausentes vao para o fim.
      const dir = criterion.dir === 'asc' ? 1 : -1;
      return coins
        .map((coin, i) => ({ coin, i }))
        .sort((a, b) => {
          const av = a.coin[criterion.sortBy];
          const bv = b.coin[criterion.sortBy];
          if (!Number.isFinite(av) && !Number.isFinite(bv)) return a.i - b.i;
          if (!Number.isFinite(av)) return 1;
          if (!Number.isFinite(bv)) return -1;
          return av === bv ? a.i - b.i : (av - bv) * dir;
        })
        .map((entry) => entry.coin);
    } catch (err) {
      lastError = err;
      const retryable = err.retryable !== false;
      if (!retryable || attempt === CONFIG.maxRetries) break;
      // Backoff exponencial com jitter para evitar retry stampede.
      const backoff = 2 ** attempt * 250 + Math.floor(Math.random() * 200);
      await sleep(backoff);
    }
  }
  throw lastError;
}

/** Normaliza e valida o payload do upstream (nao confiar na resposta externa). */
function normalize(payload, top) {
  if (!Array.isArray(payload)) throw new Error('upstream payload invalido');

  return payload.slice(0, top).map((coin, index) => ({
    rank: index + 1,
    id: String(coin.id),
    symbol: String(coin.symbol || '').toUpperCase().slice(0, 12),
    name: String(coin.name || '').slice(0, 64),
    image: safeCoinImage(coin.image),
    price: num(coin.current_price, 2),
    volume24h: num(coin.total_volume, 0),
    marketCap: num(coin.market_cap, 0),
    high24h: num(coin.high_24h, 2),
    low24h: num(coin.low_24h, 2),
    change1h: num(coin.price_change_percentage_1h_in_currency, 2),
    change24h: num(coin.price_change_percentage_24h_in_currency, 2),
    change7d: num(coin.price_change_percentage_7d_in_currency, 2),
    change30d: num(coin.price_change_percentage_30d_in_currency, 2),
    change1y: num(coin.price_change_percentage_1y_in_currency, 2),
    sparkline: Array.isArray(coin.sparkline_in_7d?.price)
      ? coin.sparkline_in_7d.price.filter((v) => Number.isFinite(v)).slice(-168)
      : [],
  }));
}

function safeCoinImage(value) {
  if (typeof value !== 'string') return null;

  try {
    const image = new URL(value);
    if (
      image.protocol !== 'https:' ||
      !COINGECKO_IMAGE_HOSTS.has(image.hostname) ||
      image.username ||
      image.password ||
      image.port
    ) {
      return null;
    }
    return image.href;
  } catch {
    return null;
  }
}

function num(value, decimals) {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

async function getMarkets(criterionKey, top) {
  // Cache do universo completo (maxTop) por criterio, cortado por `top`.
  // Keying por `top` exigiria varias chamadas upstream para o mesmo snapshot.
  const key = criterionKey;
  const entry = cache.get(key);
  const fresh = Boolean(entry && entry.expiresAt > Date.now());

  if (!fresh) {
    const data = await fetchMarkets(CRITERIA[criterionKey]);
    cache.set(key, { data, expiresAt: Date.now() + CONFIG.cacheTtlMs });
  }

  const { data } = cache.get(key);
  const sliced = data.slice(0, Math.min(top, data.length));
  // Rank reflete a posicao no ranking exibido (nao no universo inteiro).
  return { coins: sliced.map((c, i) => ({ ...c, rank: i + 1 })), cached: fresh };
}

// ---------------------------------------------------------------------------
// Respostas HTTP
// ---------------------------------------------------------------------------

function applySecurityHeaders(res, nonce) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' https://assets.coingecko.com https://coin-images.coingecko.com data:",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  void nonce;
}

function sendJson(res, status, body, requestId) {
  const payload = JSON.stringify(body);
  applySecurityHeaders(res);
  res.setHeader('Content-Type', MIME['.json']);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Request-Id', requestId);
  res.writeHead(status);
  res.end(payload);
}

function sendError(res, status, code, message, requestId) {
  sendJson(res, status, { error: { code, message, requestId } }, requestId);
}

// ---------------------------------------------------------------------------
// Servidor de arquivos estaticos
// ---------------------------------------------------------------------------

async function serveStatic(req, res, pathname, requestId) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const ext = path.extname(rel).toLowerCase();

  if (!Object.hasOwn(MIME, ext)) {
    return sendError(res, 404, 'not_found', 'Recurso nao encontrado.', requestId);
  }

  const target = path.resolve(CONFIG.publicDir, rel);

  // Path traversal: o caminho resolvido precisa continuar dentro de public/.
  if (target !== CONFIG.publicDir && !target.startsWith(CONFIG.publicDir + path.sep)) {
    log('warn', 'path traversal bloqueado', { requestId, pathname });
    return sendError(res, 403, 'forbidden', 'Acesso negado.', requestId);
  }

  let stat;
  try {
    stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error('nao e arquivo');
  } catch {
    return sendError(res, 404, 'not_found', 'Recurso nao encontrado.', requestId);
  }

  applySecurityHeaders(res);
  res.setHeader('Content-Type', MIME[ext]);
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=300');
  res.setHeader('Content-Length', String(stat.size));
  res.writeHead(200);

  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
}

// ---------------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const requestId = randomId();
  res.setHeader('X-Request-Id', requestId);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendError(res, 405, 'method_not_allowed', 'Metodo nao permitido.', requestId);
  }

  if (!rateLimit(req, res, CONFIG.rateLimit)) {
    log('warn', 'rate limit excedido', { requestId });
    return sendError(res, 429, 'rate_limited', 'Muitas requisicoes. Tente novamente em instantes.', requestId);
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendError(res, 400, 'bad_request', 'URL invalida.', requestId);
  }

  try {
    if (url.pathname === '/api/health') {
      return sendJson(
        res,
        200,
        {
          status: 'ok',
          uptime: Math.round(process.uptime()),
          criteria: Object.entries(CRITERIA).map(([key, c]) => ({ key, label: c.label })),
        },
        requestId
      );
    }

    if (url.pathname === '/api/coins') {
      // Validacao de entrada: allowlist + limites (previne DoS e abuso).
      const rawTop = Number.parseInt(url.searchParams.get('top') ?? '10', 10);
      const top = Number.isFinite(rawTop)
        ? Math.min(Math.max(rawTop, 1), CONFIG.maxTop)
        : 10;

      // Allowlist: qualquer valor fora da lista cai no padrao.
      const requested = url.searchParams.get('order') ?? DEFAULT_CRITERIA;
      const criterionKey = Object.hasOwn(CRITERIA, requested) ? requested : DEFAULT_CRITERIA;

      const { coins, cached } = await getMarkets(criterionKey, top);
      log('info', 'markets servido', {
        requestId,
        order: criterionKey,
        top,
        count: coins.length,
        cached,
      });

      return sendJson(
        res,
        200,
        {
          updatedAt: new Date().toISOString(),
          currency: 'USD',
          order: criterionKey,
          orderLabel: CRITERIA[criterionKey].label,
          count: coins.length,
          coins,
        },
        requestId
      );
    }

    if (url.pathname === '/api/coins' || url.pathname.startsWith('/api/')) {
      return sendError(res, 404, 'not_found', 'Endpoint inexistente.', requestId);
    }

    return serveStatic(req, res, url.pathname, requestId);
  } catch (err) {
    // Nunca expor detalhe interno (mensagem/stack) ao cliente.
    log('error', 'falha ao processar requisicao', { requestId, err: err.message });
    const serviceUnavailable = /upstream|fetch|abort|timeout|network/i.test(err.message);
    return sendError(
      res,
      serviceUnavailable ? 503 : 500,
      serviceUnavailable ? 'upstream_unavailable' : 'internal_error',
      serviceUnavailable
        ? 'Servico de dados indisponivel no momento. Tente novamente.'
        : 'Erro interno.',
      requestId
    );
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log('error', 'erro nao tratado', { err: err.message });
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

// Timeout de conexao e cabecalhos (defesa contra slowloris).
server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;

// So sobe o listener quando executado diretamente (permite import em testes).
if (require.main === module) {
  server.listen(CONFIG.port, CONFIG.host, () => {
    log('info', 'servidor iniciado', { url: `http://${CONFIG.host}:${CONFIG.port}` });
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('info', 'encerrando servidor', { signal });
      server.close(() => process.exit(0));
    });
  }
}

module.exports = { normalize, handle, server, CRITERIA, DEFAULT_CRITERIA, UPSTREAM_ORDERS };