'use strict';

class CookieJar {
  constructor() {
    this.store = new Map();
  }

  ingest(domain, rawHeaders) {
    if (!rawHeaders) return;
    const headers = Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders];
    if (!this.store.has(domain)) this.store.set(domain, new Map());
    const jar = this.store.get(domain);

    for (const raw of headers) {
      const parts = raw.split(';').map(s => s.trim());
      const eqIdx = parts[0].indexOf('=');
      if (eqIdx === -1) continue;
      const name  = parts[0].slice(0, eqIdx).trim();
      const value = parts[0].slice(eqIdx + 1).trim();
      if (!name || name === 'deleted') continue;
      const meta = { value, path: '/', secure: false };
      for (let i = 1; i < parts.length; i++) {
        const lo = parts[i].toLowerCase();
        if (lo.startsWith('expires=')) {
          meta.expires = new Date(parts[i].slice(8));
          if (meta.expires < new Date()) { jar.delete(name); continue; }
        }
        if (lo === 'secure')   meta.secure = true;
        if (lo === 'httponly') meta.httpOnly = true;
      }
      jar.set(name, meta);
    }
  }

  header(domain) {
    const jar = this.store.get(domain);
    if (!jar || !jar.size) return '';
    const now = new Date();
    const parts = [];
    for (const [name, meta] of jar.entries()) {
      if (meta.expires && meta.expires < now) { jar.delete(name); continue; }
      parts.push(`${name}=${meta.value}`);
    }
    return parts.join('; ');
  }

  get(domain, name) {
    const jar = this.store.get(domain);
    return jar ? (jar.get(name) || {}).value || null : null;
  }

  set(domain, name, value) {
    if (!this.store.has(domain)) this.store.set(domain, new Map());
    this.store.get(domain).set(name, { value, path: '/' });
  }
}

module.exports = { CookieJar };
