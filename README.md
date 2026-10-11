# Crypto Dashboard

[![Licença: MIT](https://img.shields.io/github/license/94nirvana/crypto-dashboard)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

Dashboard leve para acompanhar o mercado de criptomoedas. Um servidor Node.js sem dependências de runtime fornece dados da CoinGecko a uma interface estática que pode ser executada localmente.

## Funcionalidades

- Rankings por volume negociado em 24 horas, capitalização de mercado, maiores altas e maiores quedas.
- Preço em USD, variações em 1h, 24h, 7d, 30d e 1 ano, máximas e mínimas de 24h.
- Resumo do ranking e gráfico de variação dos últimos 7 dias.
- Atualização automática a cada minuto, atualização manual e preferência de ordenação salva no navegador.
- Cache de 60 segundos para reduzir chamadas à API upstream.
- Interface estática sem dependências de frontend e servidor sem dependências de runtime.

Os dados são fornecidos pela CoinGecko e podem estar sujeitos a limites e disponibilidade do serviço upstream.

## Requisitos

- Node.js 18 ou superior (inclui a API `fetch` nativa).
- npm.

## Executar localmente

```bash
git clone https://github.com/94nirvana/crypto-dashboard.git
cd crypto-dashboard
npm install
npm start
```

Abra <http://127.0.0.1:3000>. O servidor escuta, por padrão, somente no endereço local.

## Scripts

| Comando | Descrição |
| --- | --- |
| `npm start` | Inicia o servidor. |
| `npm run dev` | Inicia o servidor com reinicialização automática ao alterar arquivos (Node.js `--watch`). |
| `npm test` | Executa os testes integrados do Node.js. |

## Configuração

Configure as opções por variáveis de ambiente antes de iniciar o processo:

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Endereço de interface em que o servidor escuta. |
| `PORT` | `3000` | Porta HTTP local. |
| `UPSTREAM_URL` | `https://api.coingecko.com/api/v3` | URL base da API upstream compatível com o endpoint `/coins/markets`. |

Exemplo:

```bash
HOST=127.0.0.1 PORT=3000 npm start
```

O dashboard exibe valores em USD. A API local `GET /api/coins` aceita `top` (de 1 a 50, padrão 10) e `order` (`volume_desc`, `market_cap_desc`, `gainers_24h` ou `losers_24h`). O endpoint `GET /api/health` informa o estado do processo e os critérios disponíveis.

## Segurança

O servidor aplica cabeçalhos de segurança, valida critérios por allowlist, limita requisições, normaliza a resposta upstream e restringe imagens aos domínios HTTPS da CoinGecko. A interface cria conteúdo usando APIs seguras do DOM, sem injeção de HTML. O limite de requisições e o cache são mantidos em memória por processo; avalie essa limitação e use uma fronteira de rede apropriada antes de expor uma instância publicamente.

Consulte [SECURITY.md](SECURITY.md) para orientações sobre como reportar vulnerabilidades. Não envie segredos ou credenciais para o repositório.

## Licença

Distribuído sob a licença MIT. Consulte [LICENSE](LICENSE).
