'use strict';

const express = require('express');
const { CheckoutEngine } = require('./src/engine/checkout');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.disable('x-powered-by');

// ─── Input validation ─────────────────────────────────────────────────────────
function validateParams(site, cc, proxy) {
  const errors = [];

  if (!site) {
    errors.push('Missing parameter: site');
  } else {
    try { new URL(site.startsWith('http') ? site : `https://${site}`); }
    catch { errors.push('Invalid site URL'); }
  }

  if (!cc) {
    errors.push('Missing parameter: cc (format: number|mm|yyyy|cvv)');
  } else {
    const parts = cc.split(/[|\/]/);
    if (parts.length < 4)      errors.push('Invalid cc format — use: number|mm|yyyy|cvv');
    if (parts[0]?.length < 13) errors.push('Card number too short');
    if (parts[1]?.length > 2)  errors.push('Month should be 1-2 digits');
  }

  return errors;
}

function normaliseSite(raw) {
  if (!raw) return '';
  let s = raw.trim();
  if (!s.startsWith('http')) s = `https://${s}`;
  return s.replace(/\/$/, '');
}

// ─── GET /shopify ─────────────────────────────────────────────────────────────
// Usage: /shopify?site=https://store.myshopify.com&cc=4111111111111111|12|2027|123&proxy=user:pass@host:port
app.get('/shopify', async (req, res) => {
  const site  = normaliseSite(req.query.site  || req.query.url || '');
  const cc    = (req.query.cc   || req.query.card || '').trim();
  const proxy = (req.query.proxy || req.query.prx  || '').trim();

  const errors = validateParams(site, cc, proxy);
  if (errors.length) {
    return res.status(400).json({
      error: errors.join(' | '),
      usage: '/shopify?site=https://store.myshopify.com&cc=number|mm|yyyy|cvv&proxy=user:pass@host:port',
    });
  }

  try {
    const engine = new CheckoutEngine({ site, cc, proxy });
    const result = await engine.run();
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      cc,
      Gateway:  'Shopify Payments',
      Response: 'SERVER_ERROR',
      Price:    0,
      Currency: 'USD',
      Status:   false,
      Proxy:    proxy ? 'Unknown' : 'No Proxy',
      Time:     '0s',
      Error:    err.message,
    });
  }
});

// ─── POST /shopify (same, body-driven) ────────────────────────────────────────
app.post('/shopify', async (req, res) => {
  const site  = normaliseSite(req.body.site  || req.query.site  || '');
  const cc    = (req.body.cc   || req.query.cc   || '').trim();
  const proxy = (req.body.proxy || req.query.proxy || '').trim();

  const errors = validateParams(site, cc, proxy);
  if (errors.length) {
    return res.status(400).json({ error: errors.join(' | ') });
  }

  try {
    const engine = new CheckoutEngine({ site, cc, proxy });
    const result = await engine.run();
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ Response: 'SERVER_ERROR', Error: err.message, Status: false });
  }
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({ status: 'online', uptime: process.uptime().toFixed(0) + 's', ts: new Date().toISOString() });
});

// ─── GET / — usage info ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'Shopify Checker API',
    endpoints: {
      check: 'GET /shopify?site=...&cc=...&proxy=...',
      check_post: 'POST /shopify  body: {site, cc, proxy}',
      status: 'GET /status',
    },
    cc_format:    'number|mm|yyyy|cvv   e.g. 4111111111111111|04|2027|123',
    proxy_format: 'user:pass@host:port  or  host:port  or  omit',
    response_example: {
      cc:       '5113404319568157|04|2027|836',
      Gateway:  'Shopify Payments',
      Response: 'CARD_DECLINED',
      Price:    0.2,
      Currency: 'USD',
      Status:   false,
      Proxy:    'Live',
      Time:     '7.03s',
    },
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', hint: 'GET /shopify?site=...&cc=...&proxy=...' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[API] Shopify checker running on http://0.0.0.0:${PORT}`);
  console.log(`[API] Example: http://localhost:${PORT}/shopify?site=https://store.myshopify.com&cc=4111111111111111|12|2027|123&proxy=user:pass@host:port`);
});

module.exports = app;
