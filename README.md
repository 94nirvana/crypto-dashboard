# Crypto Volume — Top 10 por volume negociado

Painel web com o ranking das 10 maiores criptomoedas, com **criterio de
ordenacao selecionavel** (volume, capitalizacao, maiores altas e maiores quedas).
Dados em tempo real via CoinGecko. **Zero dependencias externas** (apenas Node >= 18).

## Como executar

```bash
npm start          # http://127.0.0.1:3000
npm run dev        # com auto-reload
npm test           # 11 testes (backend + frontend)
```

Variaveis de ambiente opcionais:

| Var | Padrao | Descricao |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `127.0.0.1` | Interface de bind |
| `UPSTREAM_URL` | CoinGecko | Endpoint da fonte de dados |

## Estrutura

```
crypto-dashboard/
├── server.js            # HTTP server, proxy com cache, seguranca
├── public/
│   ├── index.html       # markup sem script inline (CSP estrita)
│   ├── styles.css       # tema escuro com acento laranja
│   └── app.js           # render via DOM APIs (sem innerHTML)
└── tests/               # node:test — sem deps
```

## Criterios de ordenacao

Selecionaveis pela interface e lembrados entre recargas (preferencia de UI
persistida em `localStorage`; nao e dado sensivel).

| Chave | Criterio | Como e obtido |
|---|---|---|
| `volume_desc` | Volume negociado (24h) | Upstream |
| `market_cap_desc` | Maior capitalizacao de mercado | Upstream |
| `gainers_24h` | Maior alta (24h) | Ordem local sobre 250 ativos |
| `losers_24h` | Maior queda (24h) | Ordem local sobre 250 ativos |

**Por que dois criterios sao ordenados localmente:** a CoinGecko aceita apenas
`market_cap_desc`, `market_cap_asc`, `volume_desc`, `volume_asc` e `id` no
parametro `order`, e **ignora silenciosamente** qualquer outro valor devolvendo
`market_cap_desc`. Enviar `price_change_percentage_24h_desc` parecia funcionar,
mas retornava exatamente o ranking por capitalizacao. Por isso alta/queda sao
calculados sobre um universo maior (top 250 por capitalizacao) e ordenados no
servidor.

Criterios ascendentes (menor volume, menor capitalizacao) foram descartados:
retornam tokens sem liquidez e sem utilidade para consulta de mercado.

## API

- `GET /api/coins?top=N&order=KEY` — top N (1..50, padrao 10).
  `order` fora da allowlist cai no padrao `volume_desc`.
- `GET /api/health` — liveness + criterios suportados

Exemplo:

```bash
curl "localhost:3000/api/coins?top=10&order=gainers_24h"
```

## Decisoes de seguranca

- **Zero dependencias** — elimina superficie de supply chain.
- **CSP estrita** sem `unsafe-inline`/`unsafe-eval`; `frame-ancestors 'none'`.
- **Path traversal** bloqueado por resolucao canonica + allowlist de extensao.
- **Rate limiting** por IP (60 req/min) com `Retry-After`.
- **Timeout + retry com backoff exponencial e jitter** na chamada upstream.
- **Cache de 60s** para preservar cota da API e blindar contra indisponibilidade.
- **Payload externo nao e confiado**: normalizado, com limites de tamanho e
  allowlist de esquema para URLs de imagem.
- **Ordenacao validada em tres camadas**: allowlist no front, allowlist no
  servidor e allowlist de ordens upstream (`UPSTREAM_ORDERS`). O valor do
  cliente nunca e concatenado direto na query.
- **Zero `innerHTML`** no front-end; erros sempre inseridos como texto.
- **Sem vazamento de detalhe interno** em respostas de erro.

## Limites conhecidos

- CoinGecko aplica rate limit na free tier; o app responde `503` com mensagem
  amigavel em vez de falhar silenciosamente. O cache de 60s reduz as chamadas.
- No ranking por volume, moedas estaveis (USDT/USDC) ocupam as primeiras
  posicoes por terem volume massiveo de troca — correto para o criterio pedido.
- Em `gainers_24h` / `losers_24h` aparecem micro-caps de baixo volume. Nao ha
  piso de liquidez no filtro: a lista reflete a variacao real do universo.
  Se preferir apenas ativos tradeaveis, da para exigir volume minimo.
