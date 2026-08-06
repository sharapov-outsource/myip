/**
 * myip HTTP server.
 *
 * Routes:
 *   GET /                        page for the client's own address
 *   GET /<ip>                    page for an arbitrary address
 *   GET /?output=json|yaml       data instead of the page
 *   GET /<ip>?output=json|yaml   the same for an arbitrary address
 *   GET /api          /api/<ip>  always data (JSON by default)
 *   GET /api/geocode?lat=&lon=   reverse geocoding for browser coordinates
 *   GET /api/headers             request headers as the server sees them
 *   GET /healthz                 liveness probe
 *
 * curl and other console clients get JSON without passing any parameters.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import YAML from 'yaml';

import { lookup, reverseGeocode, normalizeIp, cacheStats } from './lookup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 3021);
const HOST = process.env.HOSTNAME || process.env.HOST || '0.0.0.0';

/* Behind a reverse proxy (nginx / Caddy / Cloudflare) the client address
   arrives in a header. Turn this off when the server faces the internet
   directly, otherwise a client can spoof its IP and bypass the limits. */
const TRUST_PROXY = process.env.TRUST_PROXY !== 'false';

/* Ceiling on concurrent calls to upstream geolocation services: even under a
   flood, no more than this many requests leave the box; the rest get a 503. */
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 24);
let inflight = 0;

const SUPPORTED_LANGS = ['en', 'ru', 'es', 'zh', 'hi', 'ar', 'pt', 'fr', 'de', 'ja', 'tr', 'uk'];

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    // Visitor IP addresses are kept out of the logs — only route and status.
    serializers: {
      req: req => ({ method: req.method, url: req.url }),
      res: res => ({ statusCode: res.statusCode }),
    },
  },
  trustProxy: TRUST_PROXY,
  maxParamLength: 64,
  bodyLimit: 8 * 1024,
  disableRequestLogging: process.env.LOG_REQUESTS !== 'true',
});

/* ------------------------------------------------------------------ *
 * Client identification
 * ------------------------------------------------------------------ */

function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string') {
      const ip = normalizeIp(cf);
      if (ip) return ip;
    }
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string') {
      const ip = normalizeIp(real);
      if (ip) return ip;
    }
  }
  // With trustProxy enabled Fastify already parses X-Forwarded-For into req.ip.
  return normalizeIp(req.ip) || normalizeIp(req.socket?.remoteAddress) || null;
}

function pickLang(req) {
  const q = String(req.query?.lang || '').toLowerCase();
  if (SUPPORTED_LANGS.includes(q)) return q;

  const header = String(req.headers['accept-language'] || '');
  for (const part of header.split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (!tag) continue;
    if (SUPPORTED_LANGS.includes(tag)) return tag;
    const base = tag.split('-')[0];
    if (SUPPORTED_LANGS.includes(base)) return base;
  }
  return 'en';
}

/** html | json | yaml | invalid */
function wantedFormat(req) {
  const raw = String(req.query?.output ?? req.query?.format ?? '').toLowerCase().trim();
  if (raw) {
    if (raw === 'json') return 'json';
    if (raw === 'yaml' || raw === 'yml') return 'yaml';
    if (raw === 'html') return 'html';
    return 'invalid';
  }

  const accept = String(req.headers.accept || '');
  if (accept.includes('yaml')) return 'yaml';
  if (/application\/(json|[\w.+-]+\+json)/.test(accept) && !accept.includes('text/html')) return 'json';

  const ua = String(req.headers['user-agent'] || '');
  if (!ua || /^(curl|wget|httpie|python-requests|go-http-client|postmanruntime|okhttp|libwww-perl)/i.test(ua)) {
    return 'json';
  }
  return 'html';
}

/* ------------------------------------------------------------------ *
 * Security headers
 * ------------------------------------------------------------------ */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  // Embedded OpenStreetMap widget.
  'frame-src https://www.openstreetmap.org',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

app.addHook('onSend', async (req, reply) => {
  reply.header('content-security-policy', CSP);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  // Cross-origin requests carry the origin only: the path holding an IP address
  // never leaks, while the embedded OpenStreetMap widget still gets a referrer.
  reply.header('referrer-policy', 'strict-origin-when-cross-origin');
  reply.header('permissions-policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()');
  reply.header('cross-origin-opener-policy', 'same-origin');
  if (process.env.HSTS === 'true') {
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
});

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

await app.register(rateLimit, {
  global: true,
  max: Number(process.env.RATE_MAX || 120),
  timeWindow: process.env.RATE_WINDOW || '1 minute',
  // Repeat offenders get a 403 instead of a 429.
  ban: Number(process.env.RATE_BAN || 8),
  cache: 20000,
  keyGenerator: req => clientIp(req) || 'unknown',
  addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
  addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true, 'retry-after': true },
  errorResponseBuilder: (req, ctx) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Rate limit of ${ctx.max} requests exceeded. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`,
    retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
  }),
});

/** Limit for requests that reach out to upstream services. */
const lookupLimit = {
  rateLimit: {
    max: Number(process.env.RATE_LOOKUP_MAX || 30),
    timeWindow: process.env.RATE_LOOKUP_WINDOW || '1 minute',
  },
};

/** Geocoding is the most expensive call — Nominatim asks for at most 1 req/s. */
const geocodeLimit = {
  rateLimit: {
    max: Number(process.env.RATE_GEOCODE_MAX || 12),
    timeWindow: process.env.RATE_GEOCODE_WINDOW || '1 minute',
  },
};

/* ------------------------------------------------------------------ *
 * Static assets
 * ------------------------------------------------------------------ */

await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: '/static/',
  index: false,
  maxAge: '1h',
  immutable: false,
  dotfiles: 'deny',
});

const INDEX_HTML = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

function sendHtml(reply) {
  return reply
    .type('text/html; charset=utf-8')
    .header('cache-control', 'public, max-age=300')
    .send(INDEX_HTML);
}

/* ------------------------------------------------------------------ *
 * Serving data
 * ------------------------------------------------------------------ */

/** Strips undefined so YAML does not emit empty keys. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = clean(v);
    }
    return out;
  }
  return value;
}

function sendData(reply, format, payload, { filename } = {}) {
  const body = clean(payload);
  if (format === 'yaml') {
    if (filename) reply.header('content-disposition', `attachment; filename="${filename}.yaml"`);
    return reply
      .type('application/yaml; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(YAML.stringify(body, { lineWidth: 0 }));
  }
  if (filename) reply.header('content-disposition', `attachment; filename="${filename}.json"`);
  return reply
    .type('application/json; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(JSON.stringify(body, null, 2));
}

/** Shared flow: resolve the address, fetch the data, render it in the wanted format. */
async function handle(req, reply, { rawIp, forceData = false }) {
  const requested = wantedFormat(req);
  if (requested === 'invalid') {
    return reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'The output parameter accepts json, yaml or html.',
    });
  }
  // /api never serves the page — data only.
  const format = forceData ? (requested === 'yaml' ? 'yaml' : 'json') : requested;

  let ip;
  if (rawIp === null || rawIp === undefined) {
    ip = clientIp(req);
    if (!ip) {
      return reply.code(500).send({
        statusCode: 500, error: 'Internal Server Error',
        message: 'Could not determine the client address.',
      });
    }
  } else {
    ip = normalizeIp(rawIp);
    if (!ip) {
      if (format === 'html') return reply.code(404).type('text/html; charset=utf-8').send(NOT_FOUND_HTML);
      return reply.code(400).send({
        statusCode: 400, error: 'Bad Request',
        message: `"${String(rawIp).slice(0, 64)}" does not look like an IP address.`,
      });
    }
  }

  // The page is served immediately; it fetches its data from /api on its own.
  if (format === 'html') return sendHtml(reply);

  if (inflight >= MAX_INFLIGHT) {
    return reply.code(503).header('retry-after', '5').send({
      statusCode: 503, error: 'Service Unavailable',
      message: 'Service is overloaded, retry in a few seconds.',
    });
  }

  inflight++;
  try {
    const data = await lookup(ip, {
      lang: pickLang(req),
      geocode: req.query?.geocode !== 'false',
    });
    const download = req.query?.download === '1' || req.query?.download === 'true';
    return sendData(reply, format, data, { filename: download ? `myip-${ip.replace(/[:.]/g, '-')}` : undefined });
  } catch (err) {
    req.log.error({ err: err.message }, 'lookup failed');
    return reply.code(502).send({
      statusCode: 502, error: 'Bad Gateway',
      message: 'Upstream geolocation services did not respond. Try again later.',
    });
  } finally {
    inflight--;
  }
}

const NOT_FOUND_HTML = `<!doctype html><meta charset="utf-8">
<title>404</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
background:#0a0e16;color:#e6ecf5;display:grid;place-items:center;height:100vh;margin:0;text-align:center}
a{color:#38bdf8}code{background:#121a28;padding:2px 6px;border-radius:6px}</style>
<div><h1>404</h1><p>Expected the site root or an IP address in the path:<br>
<code>/8.8.8.8</code> · <code>/2001:4860:4860::8888</code></p>
<p><a href="/">Go home</a></p></div>`;

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

app.get('/healthz', { config: { rateLimit: false } }, async () => ({
  status: 'ok',
  uptime: Math.round(process.uptime()),
  cache: cacheStats(),
  inflight,
}));

app.get('/robots.txt', { config: { rateLimit: false } }, async (req, reply) =>
  reply.type('text/plain; charset=utf-8').send(
    // Crawlers are allowed on the home page only: walking arbitrary addresses
    // would put pointless load on the upstream services.
    'User-agent: *\nAllow: /$\nDisallow: /api\nDisallow: /\n'
  )
);

app.get('/favicon.ico', { config: { rateLimit: false } }, async (req, reply) =>
  reply.code(204).send()
);

/** Request headers as the server sees them — replaces third-party echo services. */
app.get('/api/headers', async (req, reply) => {
  const headers = { ...req.headers };
  delete headers.cookie;
  delete headers.authorization;
  return sendData(reply, wantedFormat(req) === 'yaml' ? 'yaml' : 'json', {
    source: req.headers.host || 'myip',
    protocol: `HTTP/${req.raw.httpVersion}`,
    method: req.method,
    scheme: req.protocol,
    headers,
  });
});

/** Reverse geocoding for coordinates the browser obtained via GPS. */
app.get('/api/geocode', { config: geocodeLimit }, async (req, reply) => {
  const lat = Number(req.query?.lat);
  const lon = Number(req.query?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return reply.code(400).send({
      statusCode: 400, error: 'Bad Request',
      message: 'Valid lat (-90…90) and lon (-180…180) parameters are required.',
    });
  }

  if (inflight >= MAX_INFLIGHT) {
    return reply.code(503).header('retry-after', '5').send({
      statusCode: 503, error: 'Service Unavailable', message: 'Service is overloaded.',
    });
  }

  inflight++;
  try {
    const address = await reverseGeocode(lat, lon, pickLang(req));
    return sendData(reply, wantedFormat(req) === 'yaml' ? 'yaml' : 'json', { latitude: lat, longitude: lon, address });
  } finally {
    inflight--;
  }
});

app.get('/api', { config: lookupLimit }, (req, reply) => handle(req, reply, { rawIp: null, forceData: true }));
app.get('/api/:ip', { config: lookupLimit }, (req, reply) => handle(req, reply, { rawIp: req.params.ip, forceData: true }));

app.get('/', { config: lookupLimit }, (req, reply) => handle(req, reply, { rawIp: null }));
app.get('/:ip', { config: lookupLimit }, (req, reply) => handle(req, reply, { rawIp: req.params.ip }));

app.setNotFoundHandler({ config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, (req, reply) => {
  if (wantedFormat(req) === 'html') {
    return reply.code(404).type('text/html; charset=utf-8').send(NOT_FOUND_HTML);
  }
  return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found.' });
});

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
