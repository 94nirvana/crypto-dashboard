'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalize } = require('../server.js');

test('normalize: ordena, limita e converte os campos principais', () => {
  const result = normalize(
    [
      {
        id: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        current_price: 61234.5678,
        total_volume: 2.5e10,
        high_24h: 62000,
        low_24h: 60000,
        price_change_percentage_24h_in_currency: 1.2345,
        sparkline_in_7d: { price: [1, 2, 3, null, 4] },
      },
      { id: 'ethereum', symbol: 'eth', name: 'Ethereum', current_price: 3000 },
    ],
    10
  );

  assert.equal(result.length, 2);
  assert.equal(result[0].rank, 1);
  assert.equal(result[0].symbol, 'BTC');
  assert.equal(result[0].price, 61234.57);
  assert.equal(result[0].volume24h, 25000000000);
  assert.equal(result[0].change24h, 1.23);
  // Valores nao finitos removidos do sparkline.
  assert.deepEqual(result[0].sparkline, [1, 2, 3, 4]);
});

test('normalize: respeita o limite de itens (anti-DoS)', () => {
  const payload = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, name: `C${i}` }));
  assert.equal(normalize(payload, 10).length, 10);
});

test('normalize: rejeita payload que nao e array', () => {
  assert.throws(() => normalize({ nope: true }, 10), /payload invalido/i);
});

test('normalize: aceita imagens apenas dos hosts HTTPS da CoinGecko', () => {
  const [safe, untrustedHost, unsafeScheme, credentials] = normalize(
    [
      { id: 'safe', image: 'https://assets.coingecko.com/coins/example.png' },
      { id: 'untrusted', image: 'https://evil.example/image.png' },
      { id: 'scheme', image: 'http://assets.coingecko.com/image.png' },
      { id: 'credentials', image: 'https://user:pass@assets.coingecko.com/image.png' },
    ],
    10
  );

  assert.equal(safe.image, 'https://assets.coingecko.com/coins/example.png');
  assert.equal(untrustedHost.image, null);
  assert.equal(unsafeScheme.image, null);
  assert.equal(credentials.image, null);
});

test('normalize: limita tamanho de simbolo/nome', () => {
  const [coin] = normalize([{ id: 'x', symbol: 'A'.repeat(50), name: 'B'.repeat(200) }], 10);
  assert.equal(coin.symbol.length, 12);
  assert.equal(coin.name.length, 64);
});

test('normalize: valores ausentes viram null em vez de NaN', () => {
  const [coin] = normalize([{ id: 'x', current_price: 'abc' }], 10);
  assert.equal(coin.price, null);
  assert.deepEqual(coin.sparkline, []);
});