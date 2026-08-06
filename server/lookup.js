/**
 * Server-side collection of everything known about an IP address: geolocation,
 * network, registry records, reverse DNS and a postal address for the coordinates.
 *
 * Every upstream service is queried in parallel with a timeout. A failure in any
 * one of them does not break the response — missing fields are simply filled in
 * from another source.
 */

import net from 'node:net';
import dns from 'node:dns/promises';

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

const TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000);
const MAX_ENTRIES = Number(process.env.CACHE_MAX || 5000);

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  // Re-insert to refresh position: Map keeps insertion order, giving a simple LRU.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + TTL_MS });
}

export function cacheStats() {
  return { entries: cache.size, max: MAX_ENTRIES, ttlMs: TTL_MS };
}

/* ------------------------------------------------------------------ *
 * Address validation
 * ------------------------------------------------------------------ */

/** Returns the address in canonical form, or null when it is not an IP. */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return null;
  let ip = raw.trim();
  if (!ip || ip.length > 45) return null;

  // ::ffff:1.2.3.4 is an IPv4 address wrapped in IPv6 notation.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];

  const version = net.isIP(ip);
  return version ? ip : null;
}

/** Reserved ranges that are not worth querying upstream services for. */
export function isBogon(ip) {
  const version = net.isIP(ip);

  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||                          // 0.0.0.0/8
      a === 10 ||                         // private network
      a === 127 ||                        // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
      (a === 169 && b === 254) ||         // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||           // IETF protocol assignments
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224                            // multicast and reserved
    );
  }

  const lower = ip.toLowerCase();
  return (
    lower === '::' || lower === '::1' ||
    lower.startsWith('fe80:') ||          // link-local
    /^f[cd][0-9a-f]{2}:/.test(lower) ||   // ULA fc00::/7
    lower.startsWith('ff')                // multicast
  );
}

/* ------------------------------------------------------------------ *
 * HTTP helper
 * ------------------------------------------------------------------ */

const UA = process.env.OUTBOUND_USER_AGENT ||
  'myip/1.0 (+https://myip.sharapov.biz)';

async function get(url, { timeout = 6000, accept = 'application/json' } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { accept, 'user-agent': UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : (await res.text()).trim();
}

/** First non-empty value. */
function pick(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '' && v !== 0) return v;
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Geolocation sources
 * ------------------------------------------------------------------ */

const GEO_SOURCES = [
  {
    name: 'ipwho.is',
    url: ip => `https://ipwho.is/${ip}`,
    parse: d => (!d || d.success === false) ? null : ({
      version: d.type,
      country: d.country, countryCode: d.country_code, flag: d.flag?.emoji,
      region: d.region, city: d.city, postal: d.postal,
      latitude: d.latitude, longitude: d.longitude,
      continent: d.continent, inEU: d.is_eu, capital: d.capital,
      callingCode: d.calling_code ? `+${String(d.calling_code).replace(/^\+/, '')}` : undefined,
      timezone: d.timezone?.id, utcOffset: d.timezone?.utc,
      isp: d.connection?.isp, org: d.connection?.org,
      asn: d.connection?.asn ? `AS${d.connection.asn}` : undefined,
      domain: d.connection?.domain,
    }),
  },
  {
    name: 'ipapi.co',
    url: ip => `https://ipapi.co/${ip}/json/`,
    parse: d => (!d || d.error) ? null : ({
      version: d.version,
      country: d.country_name, countryCode: d.country_code,
      region: d.region, city: d.city, postal: d.postal,
      latitude: d.latitude, longitude: d.longitude,
      continent: d.continent_code, inEU: d.in_eu, cidr: d.network,
      callingCode: d.country_calling_code, capital: d.country_capital,
      currency: d.currency ? d.currency + (d.currency_name ? ` · ${d.currency_name}` : '') : undefined,
      timezone: d.timezone, utcOffset: d.utc_offset,
      asn: d.asn, org: d.org, isp: d.org,
    }),
  },
  {
    name: 'ipinfo.io',
    url: ip => `https://ipinfo.io/${ip}/json`,
    parse: d => (!d || !d.ip) ? null : ({
      hostname: d.hostname, city: d.city, region: d.region,
      countryCode: d.country, postal: d.postal, timezone: d.timezone,
      latitude: d.loc ? Number(d.loc.split(',')[0]) : undefined,
      longitude: d.loc ? Number(d.loc.split(',')[1]) : undefined,
      asn: d.org ? (d.org.match(/^AS\d+/) || [])[0] : undefined,
      org: d.org ? d.org.replace(/^AS\d+\s*/, '') : undefined,
      isp: d.org ? d.org.replace(/^AS\d+\s*/, '') : undefined,
    }),
  },
  {
    name: 'geojs.io',
    url: ip => `https://get.geojs.io/v1/ip/geo/${ip}.json`,
    parse: d => (!d || !d.ip) ? null : ({
      country: d.country, countryCode: d.country_code,
      region: d.region, city: d.city,
      latitude: Number(d.latitude), longitude: Number(d.longitude),
      continent: d.continent_code, timezone: d.timezone,
      asn: d.asn ? `AS${d.asn}` : undefined,
      org: d.organization_name, isp: d.organization_name,
    }),
  },
  {
    // Returns two shapes: a detailed one (nested objects) and a shortened
    // anonymous one (flat fields). Both are supported.
    name: 'ipapi.is',
    url: ip => `https://api.ipapi.is/?q=${ip}`,
    parse: d => {
      if (!d || !d.ip) return null;
      const L = d.location || {}, A = d.asn || {}, C = d.company || {};
      const asnNum = pick(A.asn, d.asn_num);
      return {
        rir: pick(d.rir, A.rir),
        country: L.country, countryCode: pick(L.country_code, d.cc),
        region: L.state, city: L.city, postal: L.zip,
        latitude: pick(L.latitude, d.lat), longitude: pick(L.longitude, d.lon),
        continent: L.continent, inEU: L.is_eu_member, timezone: L.timezone,
        callingCode: L.calling_code ? `+${L.calling_code}` : undefined,
        currency: L.currency_code,
        asn: asnNum ? `AS${asnNum}` : undefined,
        org: pick(A.org, C.name, d.asn_org, d.company_name),
        isp: pick(C.name, A.descr, d.company_name, d.asn_org),
        domain: pick(A.domain, C.domain),
        netType: pick(A.type, C.type),
        route: pick(A.route, C.network),
        abuse: A.abuse,
        security: {
          vpn: d.is_vpn, proxy: d.is_proxy, tor: d.is_tor,
          datacenter: d.is_datacenter, mobile: d.is_mobile,
          satellite: d.is_satellite, abuser: d.is_abuser,
          crawler: d.is_crawler, bogon: d.is_bogon,
          abuseScore: pick(A.abuser_score, C.abuser_score),
        },
      };
    },
  },
];

async function fetchGeo(ip) {
  const results = await Promise.allSettled(
    GEO_SOURCES.map(async s => ({ name: s.name, data: s.parse(await get(s.url(ip))) }))
  );

  const ok = results
    .filter(r => r.status === 'fulfilled' && r.value.data)
    .map(r => r.value);

  if (!ok.length) return null;

  const merged = { sources: ok.map(o => o.name) };
  const keys = new Set();
  ok.forEach(o => Object.keys(o.data).forEach(k => keys.add(k)));
  for (const key of keys) {
    if (key === 'security') continue;
    merged[key] = pick(...ok.map(o => o.data[key]));
  }
  const withSecurity = ok.find(o => o.data.security);
  if (withSecurity) merged.security = withSecurity.data.security;
  return merged;
}

/* ------------------------------------------------------------------ *
 * RDAP — official registry records
 * ------------------------------------------------------------------ */

const RIR_NAMES = {
  'whois.arin.net': 'ARIN',
  'whois.ripe.net': 'RIPE NCC',
  'whois.apnic.net': 'APNIC',
  'whois.lacnic.net': 'LACNIC',
  'whois.afrinic.net': 'AFRINIC',
};

function vcardValue(vcardArray, key) {
  if (!Array.isArray(vcardArray) || !Array.isArray(vcardArray[1])) return undefined;
  const row = vcardArray[1].find(r => Array.isArray(r) && r[0] === key);
  if (!row) return undefined;
  if (typeof row[3] === 'string') return row[3];
  if (Array.isArray(row[3])) return row[3].filter(Boolean).join(', ');
  return undefined;
}

function findEntity(entities, role) {
  for (const e of entities || []) {
    if ((e.roles || []).includes(role)) return e;
    const nested = findEntity(e.entities, role);
    if (nested) return nested;
  }
  return null;
}

async function fetchRdap(ip) {
  const endpoints = [`https://rdap.org/ip/${ip}`, `https://rdap.db.ripe.net/ip/${ip}`];
  for (const url of endpoints) {
    let d;
    try { d = await get(url, { timeout: 7000, accept: 'application/rdap+json, application/json' }); }
    catch { continue; }
    if (!d || !d.startAddress) continue;

    const eventDate = action => (d.events || []).find(e => e.eventAction === action)?.eventDate;
    const holder = findEntity(d.entities, 'registrant') ||
                   findEntity(d.entities, 'administrative') ||
                   (d.entities || [])[0];
    const abuse = findEntity(d.entities, 'abuse');

    return {
      name: d.name,
      range: `${d.startAddress} – ${d.endAddress}`,
      cidr: (d.cidr0_cidrs || []).map(c => `${c.v4prefix || c.v6prefix}/${c.length}`).join(', ') || undefined,
      type: d.type,
      holder: holder ? (vcardValue(holder.vcardArray, 'fn') || holder.handle) : undefined,
      country: d.country,
      rir: RIR_NAMES[d.port43] || d.port43,
      registered: eventDate('registration'),
      updated: eventDate('last changed'),
      abuse: abuse ? (vcardValue(abuse.vcardArray, 'email') || vcardValue(abuse.vcardArray, 'fn')) : undefined,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Reverse geocoding of coordinates
 * ------------------------------------------------------------------ */

export async function reverseGeocode(lat, lon, lang = 'en') {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = `rg:${lat.toFixed(4)}:${lon.toFixed(4)}:${lang}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  let result = null;

  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1' +
      `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}` +
      `&accept-language=${encodeURIComponent(lang)},en`;
    const d = await get(url, { timeout: 8000 });
    if (d?.address) {
      const a = d.address;
      result = {
        source: 'OpenStreetMap Nominatim',
        display: d.display_name,
        road: [a.road, a.house_number].filter(Boolean).join(', ') || undefined,
        suburb: a.suburb || a.city_district || a.neighbourhood || a.quarter,
        city: a.city || a.town || a.village || a.municipality || a.hamlet,
        state: a.state || a.region || a.province,
        postcode: a.postcode,
        country: a.country,
        countryCode: a.country_code?.toUpperCase(),
      };
    }
  } catch { /* fall through to the backup service */ }

  if (!result) {
    try {
      const url = 'https://api.bigdatacloud.net/data/reverse-geocode-client' +
        `?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
        `&localityLanguage=${encodeURIComponent(lang)}`;
      const d = await get(url, { timeout: 8000 });
      if (d && (d.countryName || d.locality)) {
        result = {
          source: 'BigDataCloud',
          display: [d.locality, d.city, d.principalSubdivision, d.countryName].filter(Boolean).join(', '),
          suburb: d.locality,
          city: d.city || d.locality,
          state: d.principalSubdivision,
          postcode: d.postcode,
          country: d.countryName,
          countryCode: d.countryCode,
        };
      }
    } catch { /* both services are unavailable */ }
  }

  cacheSet(key, result);
  return result;
}

/* ------------------------------------------------------------------ *
 * Reverse DNS
 * ------------------------------------------------------------------ */

async function reverseDns(ip) {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
    ]);
    return names?.[0];
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * @param {string} ip     already normalized address
 * @param {object} opts   { lang, geocode }
 */
export async function lookup(ip, { lang = 'en', geocode = true } = {}) {
  const started = Date.now();
  const version = net.isIP(ip) === 6 ? 'IPv6' : 'IPv4';

  if (isBogon(ip)) {
    return {
      ip, version, bogon: true,
      location: null, network: null, registry: null, address: null, security: null,
      meta: { sources: [], cached: false, elapsedMs: Date.now() - started, generatedAt: new Date().toISOString() },
    };
  }

  const cacheKey = `ip:${ip}:${geocode ? lang : 'nogeo'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, meta: { ...cached.meta, cached: true } };

  const [geo, registry, ptr] = await Promise.all([
    fetchGeo(ip).catch(() => null),
    fetchRdap(ip).catch(() => null),
    reverseDns(ip),
  ]);

  const lat = Number(geo?.latitude);
  const lon = Number(geo?.longitude);
  const address = geocode ? await reverseGeocode(lat, lon, lang).catch(() => null) : null;

  let localTime;
  if (geo?.timezone) {
    try {
      localTime = new Intl.DateTimeFormat('sv-SE', {
        timeZone: geo.timezone, dateStyle: 'short', timeStyle: 'medium',
      }).format(new Date());
    } catch { /* upstream service returned an invalid time zone */ }
  }

  const result = {
    ip,
    version: geo?.version || version,
    bogon: false,
    reverseDns: ptr || geo?.hostname,
    location: geo ? {
      country: geo.country,
      countryCode: geo.countryCode,
      flag: geo.flag,
      region: geo.region,
      city: geo.city,
      postal: geo.postal,
      latitude: Number.isFinite(lat) ? lat : undefined,
      longitude: Number.isFinite(lon) ? lon : undefined,
      continent: geo.continent,
      inEU: geo.inEU,
      capital: geo.capital,
      callingCode: geo.callingCode,
      currency: geo.currency,
      timezone: geo.timezone,
      utcOffset: geo.utcOffset,
      localTime,
    } : null,
    network: geo ? {
      isp: geo.isp,
      org: geo.org,
      asn: geo.asn,
      domain: geo.domain,
      type: geo.netType,
      route: pick(geo.route, geo.cidr, registry?.cidr),
      cidr: pick(geo.cidr, registry?.cidr),
      abuse: pick(geo.abuse, registry?.abuse),
      rir: pick(geo.rir, registry?.rir),
    } : null,
    registry,
    address,
    security: geo?.security || null,
    meta: {
      sources: [...(geo?.sources || []), ...(registry ? ['rdap'] : []), ...(address ? [address.source] : [])],
      cached: false,
      elapsedMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    },
  };

  if (geo || registry) cacheSet(cacheKey, result);
  return result;
}
