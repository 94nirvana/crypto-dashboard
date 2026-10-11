# Crypto Dashboard

A lightweight crypto market dashboard that displays ranked coins by volume, market cap, and daily movers using a small Node.js server and static frontend.

## Features

- Ranked crypto overview by volume and market cap
- Sorting by gainers and losers over the last 24h
- Cached upstream requests to reduce API pressure
- Strict server-side validation and security headers
- No external frontend dependency bundle

## Run locally

```bash
npm install
npm start
```

Open: http://127.0.0.1:3000

## Available scripts

```bash
npm start
npm run dev
npm test
```

## Security

This project includes basic AppSec controls such as:

- CSP and security headers
- input allowlists and validation
- rate limiting
- path traversal protection
- no `innerHTML`/`eval` usage in the frontend
- no secrets committed to the repository

Please review `SECURITY.md` for vulnerability reporting guidance.

## License

This project is licensed under the MIT License. See `LICENSE`.
