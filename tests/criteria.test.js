'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CRITERIA, UPSTREAM_ORDERS, DEFAULT_CRITERIA } = require('../server.js');

test('CRITERIA: todo criterio usa uma ordem suportada pelo upstream', () => {
  for (const [key, c] of Object.entries(CRITERIA)) {
    assert.ok(
      UPSTREAM_ORDERS.includes(c.order),
      `criterio "${key}" usa ordem nao suportada: ${c.order}`
    );
  }
});

test('CRITERIA: criterios locais declaram sortBy e dir coerentes', () => {
  for (const [key, c] of Object.entries(CRITERIA)) {
    if (c.sortBy) {
      assert.ok(['asc', 'desc'].includes(c.dir), `dir invalido em ${key}`);
      // Universo maior que o maximo exibido: sem isso a ordenacao local
      // so Barthawaria dentro do recorte ja ordenado pelo upstream.
      assert.ok(c.perPage >= 50, `universo pequeno demais em ${key}`);
    }
  }
});

test('CRITERIA: criterios sem sortBy delegam a ordenacao ao upstream', () => {
  for (const key of ['volume_desc', 'market_cap_desc']) {
    assert.equal(CRITERIA[key].sortBy, undefined, `${key} nao deveria ordenar localmente`);
  }
});

test('CRITERIA: criterio padrao existe e e o de volume', () => {
  assert.ok(Object.hasOwn(CRITERIA, DEFAULT_CRITERIA));
  assert.equal(DEFAULT_CRITERIA, 'volume_desc');
});

test('CRITERIA: todos tem rotulo legivel (nao vazio)', () => {
  for (const [key, c] of Object.entries(CRITERIA)) {
    assert.equal(typeof c.label, 'string');
    assert.ok(c.label.trim().length > 0, `rotulo vazio em ${key}`);
  }
});

test('CRITERIA: nenhum criterio injeta caracteres de query', () => {
  // defense in depth: o valor vai concatenado numa URL
  for (const [key, c] of Object.entries(CRITERIA)) {
    assert.match(c.order, /^[a-z_]+$/, `ordem suspeita em ${key}: ${c.order}`);
  }
});