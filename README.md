# Shopify Checker API

One-shot Shopify checkout checker. Provide `site`, `cc`, `proxy` — get back a clean JSON result.

---

## API Usage

```
GET /shopify?site=https://store.myshopify.com&cc=4111111111111111|04|2027|123&proxy=user:pass@host:port
```

### Parameters

| Param   | Required | Format                             | Example                              |
|---------|----------|------------------------------------|--------------------------------------|
| `site`  | ✅        | Full store URL                     | `https://store.myshopify.com`        |
| `cc`    | ✅        | `number\|mm\|yyyy\|cvv`            | `5113404319568157\|04\|2027\|836`    |
| `proxy` | ❌        | `user:pass@host:port` or `host:port`| `user:pass@p.smartproxy.com:10000`  |

### Response

```json
{
  "cc":       "5113404319568157|04|2027|836",
  "Gateway":  "Shopify Payments",
  "Response": "CARD_DECLINED",
  "Price":    0.2,
  "Currency": "USD",
  "Status":   false,
  "Proxy":    "Live",
  "Time":     "7.03s"
}
```

`Status: true` = card charged / approved  
`Status: false` = declined / error

### Response Codes

| Code                  | Meaning                          |
|-----------------------|----------------------------------|
| `APPROVED`            | Card charged ✅                  |
| `CARD_DECLINED`       | Generic decline                  |
| `INSUFFICIENT_FUNDS`  | Not enough balance               |
| `DO_NOT_HONOR`        | Bank blocked                     |
| `CVV_MISMATCH`        | Wrong CVV                        |
| `ADDRESS_MISMATCH`    | AVS fail (billing zip/address)   |
| `EXPIRED_CARD`        | Card expired                     |
| `INVALID_CARD_NUMBER` | Bad card number                  |
| `FRAUD_BLOCK`         | Flagged as fraud                 |
| `VELOCITY_EXCEEDED`   | Too many attempts                |
| `SCA_REQUIRED`        | 3DS / bank auth required         |
| `RATE_LIMITED`        | Store rate-limited the request   |
| `NO_PRODUCT`          | Store has no available products  |
| `INVALID_CARD`        | Card vault tokenization failed   |
| `CHECKOUT_ERROR`      | Checkout flow error              |

---

## Deploy to Render

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect repo → Render auto-detects `render.yaml`
4. Deploy (free tier works)

Your URL: `https://your-app.onrender.com/shopify?site=...&cc=...&proxy=...`

### Or run locally

```bash
npm install
node server.js
# → http://localhost:3000
```

---

## File Structure

```
yzio-api/
├── server.js                    ← Express API (GET /shopify)
├── package.json
├── render.yaml                  ← Render deploy config
├── src/
│   ├── engine/
│   │   └── checkout.js          ← Full checkout flow engine
│   └── utils/
│       ├── fingerprint.js       ← UA, headers, stealth
│       ├── cookiejar.js         ← Session cookies
│       └── responseparser.js    ← Decline code → clean label
```

## Checkout Flow

```
GET /products.json        → pick cheapest available variant
POST /cart/add.js         → add to cart
POST /cart/checkout       → capture checkout URL + token
GET  /checkout            → load page, get auth token + gateway
POST contact step         → submit email + shipping address  
POST shipping step        → select cheapest shipping rate
POST /sessions (vault)    → tokenize card via Shopify card vault
GET  payment page         → load payment step, get gateway ID
POST payment step         → submit card token + billing address
Follow redirect           → parse thank_you / decline message
```
