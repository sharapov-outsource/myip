/**
 * myip — the HTTP layer, which is now almost nothing.
 *
 * Routing, content negotiation, the content security policy, rate limits, the
 * cache, the head of the page and the family footer all live in
 * @sharapov/service-kit. What is left here is the part that is actually about
 * addresses: what counts as one, how to look one up, and the two endpoints the
 * page needs that no other service in the family has.
 *
 *   GET /                          the page, or your own address for a console
 *   GET /api                       your own address, always data
 *   GET /<ip>                      page for an address (data for console clients)
 *   GET /api/<ip>                  always data
 *   GET /api/headers               the request as this server received it
 *   GET /api/geocode?lat=&lon=     reverse geocoding for browser GPS
 *   GET /healthz                   liveness probe
 *
 * Unlike its siblings, this service answers about whoever is asking. That is
 * what `homeTarget` is for: `/` and `/api` report on the caller rather than
 * printing instructions for naming a target.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createService, localizeReport, clientIp, wantedFormat, sendData,
} from '@sharapov/service-kit';

import { lookup, reverseGeocode, normalizeIp, cacheStats } from './lookup.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Geocoding is a separate upstream with a stricter budget than a lookup. */
const geocodeLimit = {
  rateLimit: {
    max: Number(process.env.RATE_GEOCODE_MAX || 12),
    timeWindow: process.env.RATE_GEOCODE_WINDOW || '1 minute',
  },
};

const service = await createService({
  slug: 'myip',
  name: 'My IP',
  domain: 'myip.sharapov.biz',
  port: 3021,
  root: ROOT,
  /* Nothing to watch: a lookup is a handful of parallel upstream calls that
     either land together or not at all. The progress stream still exists and
     simply reports the finished answer. */
  stages: [],

  parse: raw => {
    const ip = normalizeIp(raw);
    return ip ? { host: ip } : { error: 'invalid-host' };
  },
  homeTarget: req => clientIp(req),

  /* The reverse-geocoded street address comes back from the upstream in the
     language it was asked in, so two languages are two different answers and
     must not share a cache entry. Turning geocoding off is a third. */
  cacheKey: target => target.host,
  cacheSuffix: (query, lang) => (query?.geocode === 'false' ? 'nogeo' : `geo:${lang}`),

  run: (target, options) => lookup(target.host, {
    lang: options.lang,
    geocode: options.query?.geocode !== 'false',
  }),

  /* The page embeds an OpenStreetMap widget to show where the address lands.
     No other service in the family frames anything, so the closed policy the
     kit ships has to be opened by exactly this much and no more. */
  csp: { frameSrc: ['https://www.openstreetmap.org'] },

  examples: ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888'],

  usage: {
    usage: {
      mine: 'GET /                    — your own address',
      headers: 'GET /api/headers         — the request as this server received it',
      geocode: 'GET /api/geocode?lat=&lon= — reverse geocoding',
      nogeo: 'add ?geocode=false to skip the street address',
    },
  },

  /* The kit reports on its own cache; this is the upstream one inside lookup. */
  health: () => ({ upstream: cacheStats() }),

  /* A lookup carries no machine codes to label — the upstream already answered
     in the requested language. This is here for the language stamp in `meta`,
     which every service in the family sets. */
  localize: (report, lang) => localizeReport(report, service.i18n, lang),
});

/* ------------------------------------------------------------------ *
 * The two endpoints that are myip's alone
 *
 * Registered on the app the kit built, before it starts listening.
 * ------------------------------------------------------------------ */

/** Request headers as the server sees them — replaces third-party echo services. */
service.app.get('/api/headers', async (req, reply) => {
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
service.app.get('/api/geocode', { config: geocodeLimit }, async (req, reply) => {
  const lat = Number(req.query?.lat);
  const lon = Number(req.query?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Valid lat (-90…90) and lon (-180…180) parameters are required.',
    });
  }

  const address = await reverseGeocode(lat, lon, service.pickLang(req));
  return sendData(reply, wantedFormat(req) === 'yaml' ? 'yaml' : 'json',
    { latitude: lat, longitude: lon, address });
});

/* Icons and the manifest live in public/ but browsers and crawlers probe them
   at the site root, so they get their own routes there. The kit already serves
   /favicon.ico; these are the rest. */
const ROOT_ASSETS = {
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  // iOS asks for this variant too, and 404s in the log are just noise.
  '/apple-touch-icon-precomposed.png': ['apple-touch-icon.png', 'image/png'],
  '/site.webmanifest': ['site.webmanifest', 'application/manifest+json'],
};

for (const [route, [file, type]] of Object.entries(ROOT_ASSETS)) {
  const body = readFileSync(path.join(ROOT, 'public', file));
  service.app.get(route, { config: { rateLimit: false } }, async (req, reply) =>
    reply.type(type).header('cache-control', 'public, max-age=86400').send(body)
  );
}

await service.start();

export { service };
