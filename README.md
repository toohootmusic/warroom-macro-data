# warroom-macro-data

Automated macro-economic data fetcher that runs on GitHub Actions and stores the latest snapshot as a static JSON file — no server required.

## Data sources

| Key      | Symbol      | Source    | Description             |
|----------|-------------|-----------|-------------------------|
| `brent`  | `cb.f`      | Stooq     | Brent Crude Oil (USD)   |
| `sp500`  | `^spx`      | Stooq     | S&P 500 Index           |
| `vix`    | `^vix`      | Stooq     | CBOE Volatility Index   |
| `dxy`    | `^dxy`      | Stooq     | US Dollar Index         |
| `usdbrl` | `usdbrl`    | Stooq     | USD/BRL exchange rate   |
| `ibov`   | `^bvsp`     | Stooq     | Ibovespa Index          |
| `btc`    | `BTC-USD`   | CoinGecko | Bitcoin price (USD)     |

`change_pct` and `change_abs` are derived from the penultimate daily close (Stooq history endpoint), so they reflect day-over-day change.

## Output structure

```json
{
  "generated_at": "2026-05-07T13:00:00.000Z",
  "next_update":  "2026-05-07T19:00:00.000Z",
  "data": {
    "brent": {
      "symbol": "BZ=F",
      "name": "Brent Crude Oil",
      "value": 82.45,
      "change_pct": -0.62,
      "change_abs": -0.51,
      "previous_close": 82.96,
      "timestamp": "2026-05-07T12:59:00.000Z"
    }
  },
  "errors": []
}
```

Each asset shares the same shape. `errors` lists any fetch failures — partial failures do not block other sources, and previous values are preserved on retry.

## Public endpoint

```
https://raw.githubusercontent.com/toohootmusic/warroom-macro-data/main/data/macro-latest.json
```

## Run manually

```bash
node scripts/fetch-macro.js
```

Requires Node.js 18+ (uses native `fetch` and ES modules — no `npm install` needed).

## Update schedule

| Cron (UTC)    | Approximate BRT    |
|---------------|--------------------|
| `0 13 * * *`  | 10:00 BRT (UTC-3)  |
| `0 19 * * *`  | 16:00 BRT (UTC-3)  |
| `0 1 * * *`   | 22:00 BRT (UTC-3)  |

You can also trigger a manual run via **Actions → Fetch Macro Data → Run workflow**.

## Repository structure

```
warroom-macro-data/
├── .github/
│   └── workflows/
│       └── fetch-macro.yml   # GitHub Actions workflow
├── data/
│   └── macro-latest.json     # Latest snapshot (auto-updated)
├── scripts/
│   └── fetch-macro.js        # Fetch script (pure Node.js, no dependencies)
└── README.md
```
