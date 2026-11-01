'use strict';

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

const CH_UA_MAP = {
  124: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  123: '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="99"',
};

function randomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function buildBrowserHeaders(site, ua) {
  const origin = new URL(site).origin;
  const isChrome = ua.includes('Chrome/');
  const chromeVer = isChrome ? parseInt((ua.match(/Chrome\/(\d+)/) || [])[1] || '124') : 0;
  const isMac = ua.includes('Macintosh');

  const h = {
    'User-Agent':      ua,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection':      'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    'Origin':          origin,
    'Referer':         `${origin}/`,
  };

  if (isChrome) {
    const chua = CH_UA_MAP[chromeVer] || CH_UA_MAP[124];
    Object.assign(h, {
      'sec-ch-ua':          chua,
      'sec-ch-ua-mobile':   '?0',
      'sec-ch-ua-platform': isMac ? '"macOS"' : '"Windows"',
      'sec-fetch-dest':     'document',
      'sec-fetch-mode':     'navigate',
      'sec-fetch-site':     'same-origin',
      'sec-fetch-user':     '?1',
    });
  }

  return h;
}

function buildAjaxHeaders(site, ua) {
  const origin = new URL(site).origin;
  return {
    'User-Agent':       ua,
    'Accept':           'application/json, text/javascript, */*; q=0.01',
    'Accept-Language':  'en-US,en;q=0.9',
    'Accept-Encoding':  'gzip, deflate, br',
    'Content-Type':     'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin':           origin,
    'Referer':          `${origin}/`,
    'sec-fetch-dest':   'empty',
    'sec-fetch-mode':   'cors',
    'sec-fetch-site':   'same-origin',
  };
}

function buildFormHeaders(site, ua) {
  return {
    ...buildBrowserHeaders(site, ua),
    'Content-Type': 'application/x-www-form-urlencoded',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
  };
}

function jitter(base, spread = 300) {
  return base + Math.floor(Math.random() * spread);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { randomUA, buildBrowserHeaders, buildAjaxHeaders, buildFormHeaders, sleep, jitter };
