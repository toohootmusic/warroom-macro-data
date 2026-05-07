#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = `${__dirname}/../data/macro-latest.json`;

const YAHOO_SYMBOLS = {
  brent:  { symbol: 'BZ=F',    name: 'Brent Crude Oil' },
  sp500:  { symbol: '^GSPC',   name: 'S&P 500' },
  vix:    { symbol: '^VIX',    name: 'CBOE Volatility Index' },
  dxy:    { symbol: 'DX-Y.NYB',name: 'US Dollar Index' },
  usdbrl: { symbol: 'BRL=X',   name: 'USD/BRL' },
  ibov:   { symbol: '^BVSP',   name: 'Ibovespa' },
};

function loadPrevious() {
  try {
    const raw = readFileSync(OUTPUT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.data || {};
  } catch {
    return {};
  }
}

async function fetchYahoo(keys, prev, errors) {
  const symbols = keys.map(k => YAHOO_SYMBOLS[k].symbol).join(',');
  const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketChange,regularMarketPreviousClose,regularMarketTime`;

  let quotes;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    quotes = json?.quoteResponse?.result ?? [];
  } catch (err) {
    errors.push(`yahoo: ${err.message}`);
    return {};
  }

  const result = {};
  for (const key of keys) {
    const meta = YAHOO_SYMBOLS[key];
    const q = quotes.find(r => r.symbol === meta.symbol);
    if (!q) {
      errors.push(`yahoo: no data for ${meta.symbol}`);
      if (prev[key]) result[key] = prev[key];
      continue;
    }
    result[key] = {
      symbol:         meta.symbol,
      name:           meta.name,
      value:          q.regularMarketPrice ?? null,
      change_pct:     q.regularMarketChangePercent ?? null,
      change_abs:     q.regularMarketChange ?? null,
      previous_close: q.regularMarketPreviousClose ?? null,
      timestamp:      q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : null,
    };
  }
  return result;
}

async function fetchBitcoin(prev, errors) {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true';
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const btc = json?.bitcoin;
    if (!btc) throw new Error('unexpected response shape');

    const price = btc.usd;
    const changePct = btc.usd_24h_change ?? null;
    const prevClose = changePct !== null && price !== null
      ? price / (1 + changePct / 100)
      : (prev.btc?.previous_close ?? null);

    return {
      symbol:         'BTC-USD',
      name:           'Bitcoin',
      value:          price ?? null,
      change_pct:     changePct,
      change_abs:     changePct !== null && price !== null ? price - prevClose : null,
      previous_close: prevClose,
      timestamp:      btc.last_updated_at ? new Date(btc.last_updated_at * 1000).toISOString() : null,
    };
  } catch (err) {
    errors.push(`coingecko: ${err.message}`);
    return prev.btc ?? null;
  }
}

function nextUpdate(now) {
  // scheduled at 13:00, 19:00, 01:00 UTC
  const slots = [1, 13, 19];
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const todayMinutes = h * 60 + m;
  for (const slot of slots) {
    if (slot * 60 > todayMinutes) {
      const next = new Date(now);
      next.setUTCHours(slot, 0, 0, 0);
      return next.toISOString();
    }
  }
  // next day first slot
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(slots[0], 0, 0, 0);
  return next.toISOString();
}

async function main() {
  const prev = loadPrevious();
  const errors = [];
  const now = new Date();

  const yahooKeys = Object.keys(YAHOO_SYMBOLS);
  const [yahooData, btc] = await Promise.all([
    fetchYahoo(yahooKeys, prev, errors),
    fetchBitcoin(prev, errors),
  ]);

  const data = { ...yahooData };
  if (btc) data.btc = btc;

  // fall back to previous values for any key that failed entirely
  for (const key of [...yahooKeys, 'btc']) {
    if (!data[key] && prev[key]) data[key] = prev[key];
  }

  const output = {
    generated_at: now.toISOString(),
    next_update:  nextUpdate(now),
    data,
    errors,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Written ${OUTPUT_PATH} at ${now.toISOString()}`);
  if (errors.length) console.warn('Errors:', errors);
}

main().catch(err => { console.error(err); process.exit(1); });
