'use strict';

/**
 * Maps Shopify payment response text / decline codes → clean API response labels
 */

// Shopify decline code → API Response string
const DECLINE_MAP = {
  // Generic declines
  'card_declined':             'CARD_DECLINED',
  'do_not_honor':              'DO_NOT_HONOR',
  'insufficient_funds':        'INSUFFICIENT_FUNDS',
  'call_issuer':               'CALL_ISSUER',
  'pickup_card':               'PICKUP_CARD',
  'lost_card':                 'LOST_CARD',
  'stolen_card':               'STOLEN_CARD',
  'expired_card':              'EXPIRED_CARD',
  'incorrect_number':          'INVALID_CARD_NUMBER',
  'invalid_number':            'INVALID_CARD_NUMBER',
  'incorrect_cvc':             'CVV_MISMATCH',
  'invalid_cvc':               'CVV_MISMATCH',
  'incorrect_zip':             'ADDRESS_MISMATCH',
  'incorrect_address':         'ADDRESS_MISMATCH',
  'card_velocity_exceeded':    'VELOCITY_EXCEEDED',
  'fraudulent':                'FRAUD_BLOCK',
  'generic_decline':           'CARD_DECLINED',
  'no_action_taken':           'DO_NOT_HONOR',
  'not_permitted':             'NOT_PERMITTED',
  'restricted_card':           'RESTRICTED_CARD',
  'security_violation':        'SECURITY_VIOLATION',
  'service_not_allowed':       'SERVICE_NOT_ALLOWED',
  'transaction_not_allowed':   'TRANSACTION_NOT_ALLOWED',
  'try_again_later':           'TRY_AGAIN_LATER',
  'withdrawal_count_limit_exceeded': 'WITHDRAWAL_LIMIT',
  // Shopify Payments specific
  'authentication_required':   'SCA_REQUIRED',
  '3d_secure':                 'SCA_REQUIRED',
  'approved':                  'APPROVED',
  'pending':                   'PENDING',
  'voided':                    'VOIDED',
};

// Text patterns in Shopify checkout HTML error messages
const HTML_PATTERNS = [
  { pattern: /your card was declined/i,              response: 'CARD_DECLINED',      status: false },
  { pattern: /do not honor/i,                        response: 'DO_NOT_HONOR',        status: false },
  { pattern: /insufficient funds/i,                  response: 'INSUFFICIENT_FUNDS',  status: false },
  { pattern: /security code is incorrect/i,          response: 'CVV_MISMATCH',        status: false },
  { pattern: /card number is incorrect/i,            response: 'INVALID_CARD_NUMBER', status: false },
  { pattern: /expiration date/i,                     response: 'EXPIRED_CARD',        status: false },
  { pattern: /zip.*?incorrect|address.*?match/i,     response: 'ADDRESS_MISMATCH',    status: false },
  { pattern: /card has been declined.*?fraud/i,      response: 'FRAUD_BLOCK',         status: false },
  { pattern: /call your bank/i,                      response: 'CALL_ISSUER',         status: false },
  { pattern: /transaction.*?not.*?permitted/i,       response: 'NOT_PERMITTED',       status: false },
  { pattern: /try again/i,                           response: 'TRY_AGAIN',           status: false },
  { pattern: /payment.*?error|error.*?payment/i,     response: 'PAYMENT_ERROR',       status: false },
  // Success signals
  { pattern: /thank.*?you.*?order|order.*?confirmed/i, response: 'APPROVED',          status: true  },
  { pattern: /thank_you|\/orders\//i,                  response: 'APPROVED',          status: true  },
];

// Gateway name extraction patterns
const GATEWAY_PATTERNS = [
  { pattern: /shopify[_\s-]?payments/i,   name: 'Shopify Payments' },
  { pattern: /stripe/i,                   name: 'Stripe' },
  { pattern: /braintree/i,               name: 'Braintree' },
  { pattern: /paypal/i,                   name: 'PayPal' },
  { pattern: /authorize\.?net/i,          name: 'Authorize.Net' },
  { pattern: /adyen/i,                    name: 'Adyen' },
  { pattern: /klarna/i,                   name: 'Klarna' },
  { pattern: /afterpay|clearpay/i,        name: 'Afterpay' },
  { pattern: /worldpay/i,                 name: 'Worldpay' },
  { pattern: /checkout\.com/i,            name: 'Checkout.com' },
  { pattern: /square/i,                   name: 'Square' },
  { pattern: /2checkout|verifone/i,       name: '2Checkout' },
];

/**
 * Parse checkout HTML for payment result
 * @param {string} html
 * @param {string} url - current URL
 * @returns {{ response: string, status: boolean }}
 */
function parseCheckoutResult(html = '', url = '') {
  // Check URL first (most reliable)
  if (url.includes('thank_you') || url.includes('/orders/')) {
    return { response: 'APPROVED', status: true };
  }
  if (url.includes('/processing')) {
    return { response: 'PROCESSING', status: null };
  }

  // Check HTML patterns
  for (const { pattern, response, status } of HTML_PATTERNS) {
    if (pattern.test(html) || pattern.test(url)) {
      return { response, status };
    }
  }

  // Look for Shopify error notice elements
  const noticeMatch = html.match(/class="[^"]*notice[^"]*"[^>]*>[\s\S]*?<[^>]+>([^<]{5,120})</i);
  if (noticeMatch) {
    const text = noticeMatch[1].trim();
    return { response: textToCode(text), status: false, raw: text };
  }

  // Look for alert/error elements
  const alertMatch = html.match(/(?:data-alert|role="alert")[^>]*>([^<]{5,150})/i);
  if (alertMatch) {
    const text = alertMatch[1].trim();
    return { response: textToCode(text), status: false, raw: text };
  }

  return null;
}

/**
 * Convert decline code string to API response
 */
function declineCodeToResponse(code = '') {
  const normalized = code.toLowerCase().replace(/\s+/g, '_');
  return DECLINE_MAP[normalized] || 'CARD_DECLINED';
}

/**
 * Convert raw text to clean code
 */
function textToCode(text = '') {
  // Try pattern match first
  for (const { pattern, response } of HTML_PATTERNS) {
    if (pattern.test(text)) return response;
  }
  // Normalize: CARD DECLINED → CARD_DECLINED
  return text.toUpperCase().trim().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '').slice(0, 40) || 'PAYMENT_ERROR';
}

/**
 * Detect payment gateway from checkout HTML
 */
function detectGateway(html = '') {
  for (const { pattern, name } of GATEWAY_PATTERNS) {
    if (pattern.test(html)) return name;
  }
  // Try data-gateway attribute
  const dataMatch = html.match(/data-(?:select-)?gateway="([^"]+)"/);
  if (dataMatch) return `Gateway #${dataMatch[1]}`;
  return 'Shopify Payments'; // default
}

/**
 * Extract price + currency from checkout HTML
 */
function extractPrice(html = '') {
  // Total price spans
  const patterns = [
    /class="[^"]*total[^"]*"[^>]*>[\s\S]*?\$([\d,.]+)/i,
    /data-checkout-total-price-target="[^"]*"[^>]*>([\d,.]+)/i,
    /"totalPrice":\s*"?([\d.]+)"?/i,
    /\$\s*([\d,.]+)/,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const price = parseFloat(m[1].replace(/,/g, ''));
      if (price > 0) return { price, currency: 'USD' };
    }
  }

  // Currency detection
  const currMatch = html.match(/"currency":\s*"([A-Z]{3})"/i);
  const currency = currMatch ? currMatch[1] : 'USD';

  return { price: 0, currency };
}

module.exports = {
  parseCheckoutResult,
  declineCodeToResponse,
  detectGateway,
  extractPrice,
  textToCode,
};
