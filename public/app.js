/**
 * myip client.
 *
 * Server-side data (IP, geo, network, registry, address) comes from /api;
 * browser-side data (screen, hardware, fingerprints, WebRTC) is collected here.
 * Switching the language repaints everything from cache without refetching —
 * only geocoding is requested again, since it depends on the language.
 */
'use strict';

const byId = id => document.getElementById(id);
const DASH = '—';

/* ================================================================== *
 * Language
 * ================================================================== */

const I18N = window.I18N;
const SUPPORTED = Object.keys(I18N);
const RTL = new Set(window.RTL_LANGS || []);
const STORAGE_KEY = 'myip-lang';

function detectLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && I18N[saved]) return saved;
  } catch { /* localStorage may be unavailable */ }

  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language || 'en'];
  for (const raw of candidates) {
    const tag = String(raw).toLowerCase();
    if (I18N[tag]) return tag;
    const base = tag.split('-')[0];
    if (I18N[base]) return base;
  }
  return 'en';
}

let LANG = detectLang();
const locale = () => (window.LANG_LOCALES?.[LANG]) || LANG;

function t(key, vars) {
  const dict = I18N[LANG] || I18N.en;
  let s = dict[key] ?? I18N.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(v);
  return s;
}

/** Translation when the key exists, otherwise the raw value from the service. */
function tOr(key, fallback) {
  return (I18N[LANG]?.[key] ?? I18N.en[key]) !== undefined ? t(key) : fallback;
}

/** Localized country name for an ISO code. */
function countryName(code) {
  if (!code) return undefined;
  try {
    return new Intl.DisplayNames([locale()], { type: 'region' }).of(code.toUpperCase());
  } catch {
    return undefined;
  }
}

/* ================================================================== *
 * Rendering helpers
 * ================================================================== */

function set(id, value, state) {
  const n = byId(id);
  if (!n) return;
  const empty = value === undefined || value === null || value === '' ||
                (Array.isArray(value) && !value.length) ||
                (typeof value === 'number' && Number.isNaN(value));
  n.className = 'v' + (empty ? ' muted' : state ? ' ' + state : '');
  n.textContent = empty ? DASH : (Array.isArray(value) ? value.join(', ') : String(value));
}

function setHTML(id, html, state) {
  const n = byId(id);
  if (!n) return;
  n.className = 'v' + (state ? ' ' + state : '');
  n.innerHTML = html;
}

/** Escapes values that end up inside alert HTML. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function flag(id, value, { badIfTrue = true } = {}) {
  if (value === undefined || value === null) { set(id, null); return; }
  set(id, value ? t('v_yes') : t('v_no'), value ? (badIfTrue ? 'bad' : 'ok') : 'ok');
}

function skeletons(on) {
  document.querySelectorAll('.card:not(.client-only) .v').forEach(n => {
    if (on) { n.className = 'v skeleton'; n.textContent = ''; }
  });
}

function toast(msg) {
  const el = byId('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 1900);
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || t('toast_copied'));
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(okMsg || t('toast_copied')); }
    catch { toast(t('toast_copy_fail')); }
    ta.remove();
  }
}

async function sha256(str) {
  if (window.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/* ================================================================== *
 * State
 * ================================================================== */

/** Server response for the address currently shown. */
let SERVER = null;
/** Data collected in the browser. */
const CLIENT = {};
/** Error from the last request, if any. */
let LAST_ERROR = null;
/** Address currently displayed (null means the visitor's own). */
let TARGET_IP = null;

/* ================================================================== *
 * Calls to our own API
 * ================================================================== */

async function api(pathname, { timeout = 20000 } = {}) {
  const url = new URL(pathname, location.origin);
  url.searchParams.set('lang', LANG);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/* ================================================================== *
 * Browser-side data
 * ================================================================== */

function parseUA(ua) {
  const browsers = [
    [/YaBrowser\/([\d.]+)/, 'Yandex Browser'],
    [/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Microsoft Edge'],
    [/OPR\/([\d.]+)/, 'Opera'],
    [/Vivaldi\/([\d.]+)/, 'Vivaldi'],
    [/SamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
    [/FxiOS\/([\d.]+)/, 'Firefox iOS'],
    [/Firefox\/([\d.]+)/, 'Firefox'],
    [/CriOS\/([\d.]+)/, 'Chrome iOS'],
    [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Version\/([\d.]+).*Safari/, 'Safari'],
  ];
  const systems = [
    [/Windows NT 10\.0/, () => 'Windows 10 / 11'],
    [/Windows NT 6\.3/, () => 'Windows 8.1'],
    [/Windows NT 6\.1/, () => 'Windows 7'],
    [/Windows/, () => 'Windows'],
    [/(iPhone|iPad|iPod).*?OS ([\d_]+)/, m => 'iOS ' + m[2].replace(/_/g, '.')],
    [/Mac OS X ([\d_.]+)/, m => 'macOS ' + m[1].replace(/_/g, '.')],
    [/Android ([\d.]+)/, m => 'Android ' + m[1]],
    [/CrOS/, () => 'ChromeOS'],
    [/Linux/, () => 'Linux'],
  ];

  let browser;
  for (const [re, name] of browsers) {
    const m = re.exec(ua);
    if (m) { browser = name + (m[1] ? ' ' + m[1].split('.').slice(0, 2).join('.') : ''); break; }
  }
  let os;
  for (const [re, build] of systems) {
    const m = re.exec(ua);
    if (m) { os = build(m); break; }
  }

  let engine;
  if (/AppleWebKit/.test(ua)) engine = /Chrome|Chromium|Edg|OPR/.test(ua) ? 'Blink' : 'WebKit';
  if (/Firefox\//.test(ua)) engine = 'Gecko';
  if (/FxiOS/.test(ua)) engine = 'WebKit';

  return { browser, os, engine };
}

function detectAdblock() {
  return new Promise(resolve => {
    const bait = document.createElement('div');
    bait.className = 'adsbox ad-banner ads advertisement sponsor-banner pub_300x250';
    bait.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:22px;height:22px';
    bait.innerHTML = '&nbsp;';
    document.body.appendChild(bait);
    setTimeout(() => {
      const s = getComputedStyle(bait);
      resolve(bait.offsetHeight === 0 || bait.clientHeight === 0 ||
              s.display === 'none' || s.visibility === 'hidden');
      bait.remove();
    }, 150);
  });
}

const FONT_CANDIDATES = [
  'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS',
  'Consolas', 'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Impact',
  'Lucida Console', 'Lucida Grande', 'Menlo', 'Monaco', 'MS Gothic', 'Optima', 'Palatino',
  'PT Sans', 'Roboto', 'Segoe UI', 'SF Pro Text', 'Tahoma', 'Times New Roman',
  'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings', 'Ubuntu', 'Noto Sans', 'DejaVu Sans',
  'Liberation Sans', 'Cantarell', 'Yu Gothic', 'Hiragino Sans', 'Malgun Gothic', 'SimSun',
];

function detectFonts() {
  const bases = ['monospace', 'sans-serif', 'serif'];
  const probe = document.createElement('span');
  probe.textContent = 'mmmmmmmmmmlliWWWW@';
  probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;font-size:72px;visibility:hidden;white-space:nowrap';
  document.body.appendChild(probe);

  const baseline = {};
  for (const base of bases) {
    probe.style.fontFamily = base;
    baseline[base] = [probe.offsetWidth, probe.offsetHeight];
  }

  const found = [];
  for (const font of FONT_CANDIDATES) {
    for (const base of bases) {
      probe.style.fontFamily = `"${font}",${base}`;
      if (probe.offsetWidth !== baseline[base][0] || probe.offsetHeight !== baseline[base][1]) {
        found.push(font);
        break;
      }
    }
  }
  probe.remove();
  return found;
}

function canvasFingerprintData() {
  try {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 70;
    const x = c.getContext('2d');
    if (!x) return null;
    x.textBaseline = 'top';
    x.font = '16px "Arial"';
    x.fillStyle = '#f60';
    x.fillRect(0, 0, 130, 26);
    x.fillStyle = '#069';
    x.fillText('myip 🛰 fingerprint', 4, 6);
    x.fillStyle = 'rgba(102,204,0,0.72)';
    x.fillText('myip 🛰 fingerprint', 6, 22);
    x.globalCompositeOperation = 'multiply';
    x.beginPath(); x.arc(70, 48, 18, 0, Math.PI * 2); x.fillStyle = '#f0f'; x.fill();
    x.beginPath(); x.arc(100, 48, 18, 0, Math.PI * 2); x.fillStyle = '#0ff'; x.fill();
    return c.toDataURL();
  } catch { return null; }
}

function webglInfo() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      version: gl.getParameter(gl.VERSION),
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      extensions: (gl.getSupportedExtensions() || []).length,
    };
  } catch { return null; }
}

function audioFingerprint() {
  return new Promise(resolve => {
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Ctx) return resolve(null);
      const ctx = new Ctx(1, 44100, 44100);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12;
      comp.attack.value = 0; comp.release.value = 0.25;
      osc.connect(comp); comp.connect(ctx.destination);
      osc.start(0);
      const timer = setTimeout(() => resolve(null), 3000);
      ctx.startRendering().then(buf => {
        clearTimeout(timer);
        const ch = buf.getChannelData(0);
        let sum = 0;
        for (let i = 4500; i < 5000; i++) sum += Math.abs(ch[i]);
        resolve(sum.toString());
      }).catch(() => { clearTimeout(timer); resolve(null); });
    } catch { resolve(null); }
  });
}

function webrtcProbe(timeout = 3500) {
  return new Promise(resolve => {
    const local = new Set(), publicIps = new Set();
    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      });
    } catch { return resolve(null); }

    const finish = () => {
      try { pc.close(); } catch { /* already closed */ }
      resolve({ local: [...local], public: [...publicIps] });
    };
    const timer = setTimeout(finish, timeout);

    pc.onicecandidate = e => {
      if (!e.candidate) { clearTimeout(timer); return finish(); }
      const m = /candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\w+)/.exec(e.candidate.candidate || '');
      if (!m) return;
      const [, addr, type] = m;
      if (/\.local$/i.test(addr)) local.add(addr);
      else if (type === 'host') local.add(addr);
      else publicIps.add(addr);
    };

    try {
      pc.createDataChannel('probe');
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
    } catch { clearTimeout(timer); finish(); }
  });
}

async function permissionStates() {
  const out = {};
  if (!navigator.permissions?.query) return out;
  await Promise.all(['geolocation', 'notifications', 'camera', 'microphone'].map(async name => {
    try { out[name] = (await navigator.permissions.query({ name })).state; } catch { /* unsupported */ }
  }));
  return out;
}

async function mediaDeviceCounts() {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const counts = { audioinput: 0, audiooutput: 0, videoinput: 0 };
    devices.forEach(d => { if (counts[d.kind] !== undefined) counts[d.kind]++; });
    return counts;
  } catch { return null; }
}

/** One-time collection of everything that does not depend on the language. */
async function collectClient() {
  const ua = navigator.userAgent;
  CLIENT.userAgent = ua;
  Object.assign(CLIENT, parseUA(ua));

  CLIENT.languages = navigator.languages?.length ? [...navigator.languages] : [navigator.language];
  CLIENT.cookiesEnabled = navigator.cookieEnabled;
  CLIENT.doNotTrack = navigator.doNotTrack;
  CLIENT.globalPrivacyControl = 'globalPrivacyControl' in navigator ? navigator.globalPrivacyControl : undefined;
  CLIENT.plugins = navigator.plugins?.length;
  CLIENT.isSecureContext = window.isSecureContext;
  CLIENT.webdriver = navigator.webdriver;
  CLIENT.platform = navigator.platform;
  CLIENT.cores = navigator.hardwareConcurrency;
  CLIENT.memoryGb = navigator.deviceMemory;
  CLIENT.maxTouchPoints = navigator.maxTouchPoints;
  CLIENT.mobile = navigator.userAgentData
    ? navigator.userAgentData.mobile
    : /Mobi|Android|iPhone|iPad/i.test(ua);

  CLIENT.fonts = detectFonts();
  CLIENT.webgl = webglInfo();

  if (navigator.userAgentData?.getHighEntropyValues) {
    try {
      CLIENT.uaHints = await navigator.userAgentData.getHighEntropyValues(
        ['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion']
      );
    } catch { /* blocked by the user or by policy */ }
  }

  const [adblock, canvasData, audioRaw, perms, media, rtc] = await Promise.all([
    detectAdblock(),
    Promise.resolve(canvasFingerprintData()),
    audioFingerprint(),
    permissionStates(),
    mediaDeviceCounts(),
    webrtcProbe(),
  ]);

  CLIENT.adblock = adblock;
  CLIENT.canvasHash = canvasData ? (await sha256(canvasData)).slice(0, 32) : null;
  CLIENT.audioHash = audioRaw ? (await sha256(audioRaw)).slice(0, 32) : null;
  CLIENT.permissions = perms;
  CLIENT.mediaDevices = media;
  CLIENT.webrtc = rtc;

  if (navigator.getBattery) {
    try {
      const b = await navigator.getBattery();
      CLIENT.battery = { level: b.level, charging: b.charging };
    } catch { CLIENT.battery = null; }
  }
  if (navigator.storage?.estimate) {
    try { CLIENT.storage = await navigator.storage.estimate(); } catch { CLIENT.storage = null; }
  }

  CLIENT.fingerprint = await sha256([
    ua, navigator.language, CLIENT.languages.join(','),
    screen.width, screen.height, screen.colorDepth, devicePixelRatio,
    CLIENT.cores, CLIENT.memoryGb, CLIENT.maxTouchPoints,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    CLIENT.webgl ? CLIENT.webgl.vendor + '|' + CLIENT.webgl.renderer : '',
    CLIENT.canvasHash, CLIENT.audioHash, CLIENT.fonts.join(','),
  ].join('~'));
}

/* ================================================================== *
 * Rendering server data
 * ================================================================== */

function renderMap(lat, lon) {
  const wrap = byId('map-wrap');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    wrap.innerHTML = `<div class="placeholder">${esc(t('map_placeholder'))}</div>`;
    return;
  }
  const d = 0.045;
  const bbox = [lon - d, lat - d / 2, lon + d, lat + d / 2].map(n => n.toFixed(5)).join('%2C');
  const frame = document.createElement('iframe');
  frame.loading = 'lazy';
  frame.title = 'map';
  frame.src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lon}`;
  wrap.replaceChildren(frame);
}

function renderAlerts() {
  const box = byId('alerts');
  box.innerHTML = '';
  const add = (kind, html) => {
    const div = document.createElement('div');
    div.className = 'alert ' + kind;
    div.innerHTML = html;
    box.appendChild(div);
  };

  if (LAST_ERROR) {
    add('bad', `<span aria-hidden="true">✕</span><div>${esc(LAST_ERROR)}</div>`);
    return;
  }
  if (!SERVER) return;

  if (SERVER.bogon) {
    add('warn', `<span aria-hidden="true">🏠</span><div>${t('a_bogon')}</div>`);
    return;
  }

  const own = TARGET_IP === null;
  const sec = SERVER.security;

  if (sec?.vpn || sec?.proxy || sec?.tor) {
    const what = [sec.vpn && t('w_vpn'), sec.proxy && t('w_proxy'), sec.tor && t('w_tor')]
      .filter(Boolean).join(' / ');
    add('warn', `<span aria-hidden="true">🕵️</span><div>${t('a_vpn', { what: esc(what) })}</div>`);
  } else if (sec?.datacenter) {
    add('warn', `<span aria-hidden="true">🏭</span><div>${t('a_dc')}</div>`);
  }

  // Comparisons against the browser only make sense for the visitor's own address.
  if (!own) return;

  const ipTz = SERVER.location?.timezone;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (ipTz && browserTz && ipTz !== browserTz) {
    add('warn', `<span aria-hidden="true">⚠️</span><div>${
      t('a_tz', { browser: esc(browserTz), ip: esc(ipTz) })}</div>`);
  }

  const leaks = (CLIENT.webrtc?.public || []).filter(a => a !== SERVER.ip);
  if (leaks.length) {
    add('bad', `<span aria-hidden="true">🚨</span><div>${
      t('a_rtc', { main: esc(SERVER.ip), leak: esc(leaks.join(', ')) })}</div>`);
  }
}

function renderServer() {
  const heroIp = byId('hero-ip');
  const meta = byId('hero-meta');
  meta.innerHTML = '';

  if (!SERVER) {
    heroIp.textContent = LAST_ERROR ? DASH : t('detecting');
    document.querySelectorAll('.card:not(.client-only) .v').forEach(n => {
      n.classList.remove('skeleton');
      if (!n.textContent) { n.textContent = DASH; n.classList.add('muted'); }
    });
    return;
  }

  const loc = SERVER.location || {};
  const netw = SERVER.network || {};
  const reg = SERVER.registry;
  const addr = SERVER.address;
  const sec = SERVER.security;

  heroIp.textContent = SERVER.ip;

  const chip = text => {
    if (!text) return;
    const s = document.createElement('span');
    s.className = 'chip';
    s.textContent = text;
    meta.appendChild(s);
  };
  const country = countryName(loc.countryCode) || loc.country;
  chip([loc.flag, country].filter(Boolean).join(' '));
  chip([loc.city, loc.region].filter(Boolean).join(', '));
  chip(netw.isp);
  chip(netw.asn);
  chip(loc.timezone);

  const v6 = SERVER.version === 'IPv6';
  set('ipv4', v6 ? null : SERVER.ip);
  set('ipv6', v6 ? SERVER.ip : t('v_no_ipv6'), v6 ? undefined : 'muted');
  set('ip-type', v6 ? t('v_only6') : t('v_only4'));
  set('ip-network', netw.cidr);
  set('ip-hostname', SERVER.reverseDns);
  set('ip-rir', netw.rir);

  set('net-isp', netw.isp);
  set('net-org', netw.org);
  set('net-asn', netw.asn);
  if (netw.asn) {
    const num = String(netw.asn).replace(/^AS/i, '');
    setHTML('net-asorg',
      `<a href="https://bgp.tools/as/${encodeURIComponent(num)}" target="_blank" rel="noopener noreferrer">${
        esc(netw.org || netw.asn)} ↗</a>`);
  } else {
    set('net-asorg', null);
  }
  set('net-domain', netw.domain);
  const typeKey = { isp: 'nt_isp', hosting: 'nt_hosting', business: 'nt_business',
                    education: 'nt_education', government: 'nt_government', banking: 'nt_banking' }[netw.type];
  set('net-type', typeKey ? t(typeKey) : netw.type);
  set('net-route', netw.route);
  set('net-abuse', netw.abuse);

  set('rd-name', reg?.name);
  set('rd-range', reg?.range);
  set('rd-cidr', reg?.cidr);
  set('rd-type', reg?.type);
  set('rd-holder', reg?.holder);
  set('rd-country', countryName(reg?.country) || reg?.country);
  set('rd-rir', reg?.rir);
  set('rd-registered', formatDate(reg?.registered));
  set('rd-updated', formatDate(reg?.updated));
  set('rd-abuse', reg?.abuse);
  if (!reg) {
    ['rd-name', 'rd-range', 'rd-cidr', 'rd-type', 'rd-holder', 'rd-country', 'rd-rir',
     'rd-registered', 'rd-updated', 'rd-abuse'].forEach(id => set(id, t('v_registry_down')));
  }

  if (sec) {
    flag('sec-vpn', sec.vpn);
    flag('sec-proxy', sec.proxy);
    flag('sec-tor', sec.tor);
    flag('sec-dc', sec.datacenter);
    flag('sec-mobile', sec.mobile, { badIfTrue: false });
    flag('sec-sat', sec.satellite, { badIfTrue: false });
    flag('sec-abuser', sec.abuser);
    set('sec-score', sec.abuseScore);
  } else {
    ['sec-vpn', 'sec-proxy', 'sec-tor', 'sec-dc', 'sec-mobile', 'sec-sat', 'sec-abuser', 'sec-score']
      .forEach(id => set(id, t('v_service_down')));
  }

  set('geo-country', [loc.flag, country, loc.countryCode && `(${loc.countryCode})`].filter(Boolean).join(' '));
  set('geo-region', loc.region);
  set('geo-city', loc.city);
  set('geo-postal', loc.postal);
  set('geo-continent', loc.continent ? tOr('cont_' + loc.continent, loc.continent) : null);
  set('geo-eu', loc.inEU === undefined ? null : (loc.inEU ? t('v_yes') : t('v_no')));
  set('geo-calling', loc.callingCode);
  set('geo-currency', loc.currency);
  set('geo-sources', SERVER.meta?.sources);

  const lat = loc.latitude, lon = loc.longitude;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    setHTML('geo-coords',
      `<a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=12/${lat}/${lon}"
          target="_blank" rel="noopener noreferrer">${lat.toFixed(4)}, ${lon.toFixed(4)} ↗</a>`);
    renderMap(lat, lon);
  } else {
    set('geo-coords', null);
    renderMap();
  }

  set('rg-address', addr?.display);
  set('rg-road', addr?.road);
  set('rg-suburb', addr?.suburb);
  set('rg-city', addr?.city);
  set('rg-state', addr?.state);
  set('rg-postcode', addr?.postcode);
  set('rg-country', addr?.country);
  set('rg-source', addr?.source || t('v_geocode_fail'));

  set('con-latency', SERVER.meta?.elapsedMs != null ? `${SERVER.meta.elapsedMs} ${t('unit_ms')}` : null);

  renderTime();
}

function formatDate(iso) {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try { return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(d); }
  catch { return iso; }
}

function renderTime() {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const now = new Date();
  const opts = { dateStyle: 'medium', timeStyle: 'medium' };
  const fmt = (o = {}) => {
    try { return new Intl.DateTimeFormat(locale(), { ...opts, ...o }).format(now); }
    catch { return undefined; }
  };

  set('tz-browser', resolved.timeZone);
  set('tz-local', fmt());
  set('tz-utc', fmt({ timeZone: 'UTC' }));

  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '−';
  set('tz-offset', `UTC${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${
    String(Math.abs(offset) % 60).padStart(2, '0')}`);
  set('tz-locale', `${resolved.locale} · ${resolved.calendar} · ${resolved.numberingSystem}`);

  const ipTz = SERVER?.location?.timezone;
  set('tz-ip', ipTz);
  if (ipTz) {
    set('tz-remote', fmt({ timeZone: ipTz }));
    const same = ipTz === resolved.timeZone;
    // Comparing a third-party address against the browser is meaningless.
    if (TARGET_IP === null) set('tz-match', same ? t('v_match') : t('v_mismatch'), same ? 'ok' : 'warn');
    else set('tz-match', null);
  } else {
    set('tz-remote', null);
    set('tz-match', null);
  }
}

/* ================================================================== *
 * Rendering browser data
 * ================================================================== */

function renderClient() {
  byId('br-ua').textContent = CLIENT.userAgent || DASH;
  set('br-name', CLIENT.uaHints?.uaFullVersion && CLIENT.browser
    ? `${CLIENT.browser.split(' ')[0]} ${CLIENT.uaHints.uaFullVersion}`
    : (CLIENT.browser || t('v_not_determined')));
  set('br-engine', CLIENT.engine || t('v_not_determined'));
  set('br-languages', CLIENT.languages);
  set('br-cookies', CLIENT.cookiesEnabled ? t('v_enabled') : t('v_disabled'),
      CLIENT.cookiesEnabled ? 'ok' : 'warn');
  set('br-dnt', CLIENT.doNotTrack === '1' ? t('v_enabled')
    : CLIENT.doNotTrack === '0' ? t('v_disabled') : t('v_not_set'));
  set('br-gpc', CLIENT.globalPrivacyControl === undefined ? t('v_unsupported')
    : CLIENT.globalPrivacyControl ? t('v_enabled') : t('v_disabled'));
  set('br-adblock', CLIENT.adblock === undefined ? t('v_loading')
    : CLIENT.adblock ? t('v_detected') : t('v_not_detected'), CLIENT.adblock ? 'ok' : undefined);
  set('br-plugins', CLIENT.plugins != null ? t('count_tpl', { n: CLIENT.plugins }) : null);
  set('br-js', /Chrome|Edg|OPR/.test(CLIENT.userAgent || '') ? 'V8'
    : /Firefox/.test(CLIENT.userAgent || '') ? 'SpiderMonkey'
    : /Safari/.test(CLIENT.userAgent || '') ? 'JavaScriptCore' : t('v_not_determined'));
  set('br-secure', CLIENT.isSecureContext ? t('v_secure_yes') : t('v_no'),
      CLIENT.isSecureContext ? 'ok' : 'warn');

  set('os-name', CLIENT.os || t('v_not_determined'));
  set('os-version', CLIENT.uaHints
    ? [CLIENT.uaHints.platform, CLIENT.uaHints.platformVersion].filter(Boolean).join(' ') || null
    : CLIENT.platform);
  set('os-arch', CLIENT.uaHints
    ? [CLIENT.uaHints.architecture, CLIENT.uaHints.bitness && CLIENT.uaHints.bitness + '-bit']
        .filter(Boolean).join(' ') || t('v_not_reported')
    : (/WOW64|Win64|x64|x86_64/.test(CLIENT.userAgent || '') ? 'x86-64'
      : /arm|aarch64/i.test(CLIENT.userAgent || '') ? 'ARM' : t('v_not_reported')));
  set('os-model', CLIENT.uaHints?.model || t('v_not_reported'));
  set('os-mobile', CLIENT.mobile ? t('v_mobile_device') : t('v_desktop'));
  set('hw-cores', CLIENT.cores ? t('cores_tpl', { n: CLIENT.cores }) : t('v_hidden'));
  set('hw-memory', CLIENT.memoryGb ? `${t('approx')} ${CLIENT.memoryGb} ${t('unit_gb')}` : t('v_hidden'));
  set('hw-touch', CLIENT.maxTouchPoints > 0 ? t('touch_tpl', { n: CLIENT.maxTouchPoints }) : t('v_no'));

  if (CLIENT.battery === undefined) set('hw-battery', t('v_unsupported'));
  else if (CLIENT.battery === null) set('hw-battery', t('v_unavailable'));
  else set('hw-battery', t('battery_tpl', {
    n: Math.round(CLIENT.battery.level * 100),
    state: CLIENT.battery.charging ? t('battery_charging') : t('battery_discharging'),
  }));

  if (CLIENT.storage === undefined) set('hw-storage', t('v_unsupported'));
  else if (!CLIENT.storage?.quota) set('hw-storage', t('v_unavailable'));
  else {
    const gb = n => (n / 1024 ** 3).toFixed(2) + ' ' + t('unit_gb');
    set('hw-storage', t('storage_tpl', { used: gb(CLIENT.storage.usage || 0), total: gb(CLIENT.storage.quota) }));
  }

  renderScreen();

  const gl = CLIENT.webgl;
  set('gl-renderer', gl?.renderer || t('v_webgl_off'));
  set('gl-vendor', gl?.vendor || t('v_webgl_off'));
  set('gl-version', gl?.version || t('v_webgl_off'));
  set('gl-ext', gl ? t('count_tpl', { n: gl.extensions }) : t('v_webgl_off'));
  set('gl-webgpu', 'gpu' in navigator ? t('v_yes') : t('v_no'));
  set('fp-canvas', CLIENT.canvasHash || t('v_blocked'));
  set('fp-audio', CLIENT.audioHash || t('v_unavailable'));
  set('fp-total', CLIENT.fingerprint ? CLIENT.fingerprint.slice(0, 40) : t('v_loading'), 'ok');

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    set('con-type', conn.type || t('v_not_reported'));
    set('con-eff', { 'slow-2g': t('eff_slow2g'), '2g': t('eff_2g'), '3g': t('eff_3g'), '4g': t('eff_4g') }[conn.effectiveType] || conn.effectiveType);
    set('con-downlink', conn.downlink ? `${t('approx')} ${conn.downlink} ${t('unit_mbps')}` : null);
    set('con-rtt', conn.rtt ? `${t('approx')} ${conn.rtt} ${t('unit_ms')}` : null);
    set('con-save', conn.saveData ? t('v_enabled') : t('v_disabled'));
  } else {
    ['con-type', 'con-eff', 'con-downlink', 'con-rtt', 'con-save'].forEach(id => set(id, t('v_unsupported')));
  }
  set('con-online', navigator.onLine ? t('v_yes') : t('v_no'), navigator.onLine ? 'ok' : 'bad');

  const rtc = CLIENT.webrtc;
  if (!rtc) {
    set('rtc-public', t('v_rtc_off'));
    set('rtc-local', t('v_rtc_off'));
    set('rtc-match', null);
  } else {
    set('rtc-public', rtc.public.length ? rtc.public : t('v_rtc_notfound'));
    set('rtc-local', rtc.local.length
      ? rtc.local.map(a => /\.local$/i.test(a) ? `${a} (${t('v_mdns')})` : a)
      : t('v_rtc_hidden'));
    if (rtc.public.length && SERVER?.ip && TARGET_IP === null) {
      const same = rtc.public.includes(SERVER.ip);
      set('rtc-match', same ? t('v_yes') : t('v_mismatch_found'), same ? 'ok' : 'bad');
    } else {
      set('rtc-match', rtc.public.length ? null : t('v_rtc_none'), rtc.public.length ? undefined : 'ok');
    }
  }

  const ru = { granted: 'v_granted', denied: 'v_denied', prompt: 'v_prompt' };
  for (const name of ['geolocation', 'notifications', 'camera', 'microphone']) {
    const state = CLIENT.permissions?.[name];
    set('pm-' + name, state ? t(ru[state] || state) : t('v_unsupported'),
        state === 'granted' ? 'warn' : state === 'denied' ? 'ok' : undefined);
  }
  const md = CLIENT.mediaDevices;
  set('md-audioin', md ? t('count_tpl', { n: md.audioinput }) : t('v_unavailable'));
  set('md-audioout', md ? t('count_tpl', { n: md.audiooutput }) : t('v_unavailable'));
  set('md-videoin', md ? t('count_tpl', { n: md.videoinput }) : t('v_unavailable'));

  const fonts = CLIENT.fonts || [];
  set('fonts-count', t('fonts_tpl', { n: fonts.length, total: FONT_CANDIDATES.length }));
  byId('fonts-list').textContent = fonts.length ? fonts.join(' · ') : t('v_none_found');

  renderGps();
}

function renderScreen() {
  const s = window.screen;
  const mq = q => window.matchMedia(q).matches;
  const px = t('unit_px');

  set('sc-res', `${s.width} × ${s.height} ${px}`);
  set('sc-avail', `${s.availWidth} × ${s.availHeight} ${px}`);
  set('sc-viewport', `${innerWidth} × ${innerHeight} ${px}`);
  set('sc-dpr', t('dpr_tpl', {
    r: devicePixelRatio,
    w: Math.round(s.width * devicePixelRatio),
    h: Math.round(s.height * devicePixelRatio),
  }));
  set('sc-depth', `${s.colorDepth} ${t('unit_bits')}`);
  set('sc-gamut', mq('(color-gamut: rec2020)') ? 'Rec. 2020'
    : mq('(color-gamut: p3)') ? 'Display P3'
    : mq('(color-gamut: srgb)') ? 'sRGB' : t('v_not_determined'));
  set('sc-hdr', mq('(dynamic-range: high)') ? 'HDR' : 'SDR');
  set('sc-orient', s.orientation?.type || (innerWidth > innerHeight ? 'landscape' : 'portrait'));
  set('sc-scheme', mq('(prefers-color-scheme: dark)') ? t('v_dark') : t('v_light'));
  set('sc-motion', mq('(prefers-reduced-motion: reduce)') ? t('v_enabled') : t('v_disabled'));
}

/* ================================================================== *
 * Precise geolocation
 * ================================================================== */

const GPS = { status: 'idle', coords: null, address: null, error: null };

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function renderGps() {
  const statusText = {
    idle: t('gps_idle'), wait: t('gps_wait'), ok: t('gps_ok'),
    geocoding: t('gps_geocoding'), error: GPS.error,
  }[GPS.status];
  set('gps-status', statusText, GPS.status === 'ok' ? 'ok' : GPS.status === 'error' ? 'bad' : GPS.status === 'wait' ? 'warn' : undefined);

  const c = GPS.coords;
  if (!c) {
    ['gps-coords', 'gps-accuracy', 'gps-altitude', 'gps-speed', 'gps-address', 'gps-delta']
      .forEach(id => set(id, null));
    return;
  }

  set('gps-coords', `${c.latitude.toFixed(6)}, ${c.longitude.toFixed(6)}`, 'ok');
  set('gps-accuracy', c.accuracy != null ? `± ${Math.round(c.accuracy)} ${t('unit_m')}` : null);
  set('gps-altitude', c.altitude != null
    ? `${Math.round(c.altitude)} ${t('unit_m')}${c.altitudeAccuracy != null ? ` (± ${Math.round(c.altitudeAccuracy)} ${t('unit_m')})` : ''}`
    : null);
  set('gps-speed', [
    c.speed != null ? `${(c.speed * 3.6).toFixed(1)} ${t('unit_kmh')}` : null,
    c.heading != null ? `${Math.round(c.heading)}°` : null,
  ].filter(Boolean).join(' / ') || null);

  set('gps-address', GPS.status === 'geocoding' ? t('gps_geocoding')
    : GPS.address?.display || t('v_geocode_fail'),
    GPS.address ? 'ok' : undefined);

  const lat = SERVER?.location?.latitude, lon = SERVER?.location?.longitude;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const km = haversine(c.latitude, c.longitude, lat, lon);
    set('gps-delta', km < 1 ? `${Math.round(km * 1000)} ${t('unit_m')}` : `${km.toFixed(1)} ${t('unit_km')}`,
        km > 100 ? 'bad' : km > 25 ? 'warn' : 'ok');
  } else {
    set('gps-delta', null);
  }
}

async function geocodeGps() {
  if (!GPS.coords) return;
  GPS.status = 'geocoding';
  renderGps();
  try {
    const res = await api(`/api/geocode?lat=${GPS.coords.latitude}&lon=${GPS.coords.longitude}`);
    GPS.address = res.address;
  } catch {
    GPS.address = null;
  }
  GPS.status = 'ok';
  renderGps();
  renderRaw();
}

function requestPreciseLocation() {
  if (!navigator.geolocation) {
    GPS.status = 'error';
    GPS.error = t('gps_nosupport');
    renderGps();
    return;
  }
  const btn = byId('btn-geo');
  btn.disabled = true;
  GPS.status = 'wait';
  renderGps();

  navigator.geolocation.getCurrentPosition(pos => {
    btn.disabled = false;
    const c = pos.coords;
    GPS.coords = {
      latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy,
      altitude: c.altitude, altitudeAccuracy: c.altitudeAccuracy,
      speed: c.speed, heading: c.heading,
      timestamp: new Date(pos.timestamp).toISOString(),
    };
    GPS.status = 'ok';
    renderGps();
    renderMap(c.latitude, c.longitude);
    geocodeGps();
  }, err => {
    btn.disabled = false;
    GPS.status = 'error';
    GPS.error = { 1: t('gps_denied'), 2: t('gps_unavail'), 3: t('gps_timeout') }[err.code] || err.message;
    renderGps();
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

/* ================================================================== *
 * Headers and raw data
 * ================================================================== */

let HEADERS = null;

async function loadHeaders() {
  try {
    HEADERS = await api('/api/headers');
  } catch {
    HEADERS = null;
  }
  renderHeaders();
  renderRaw();
}

function renderHeaders() {
  const pre = byId('headers');
  if (!HEADERS) { pre.textContent = t('headers_down'); return; }
  const lines = Object.entries(HEADERS.headers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .sort()
    .join('\n');
  pre.textContent = `${t('headers_seen', { service: HEADERS.source })}\n${HEADERS.protocol} ${HEADERS.method}\n\n${lines}`;
}

function exportData() {
  return {
    generatedAt: new Date().toISOString(),
    query: TARGET_IP ? { ip: TARGET_IP } : { ip: 'self' },
    server: SERVER,
    headers: HEADERS,
    gps: GPS.coords ? { ...GPS.coords, address: GPS.address } : null,
    client: CLIENT,
  };
}

function renderRaw() {
  byId('raw-json').textContent = JSON.stringify(exportData(), null, 2);
}

/* ================================================================== *
 * Applying a language
 * ================================================================== */

/** Keeps title, meta description and social preview tags in the page's language. */
function updateSeoMeta() {
  const title = t('title');
  const description = t('subtitle');
  const ogLocale = locale().replace('-', '_');
  const url = location.origin + location.pathname;

  document.title = title;
  byId('meta-description')?.setAttribute('content', description);
  byId('og-title')?.setAttribute('content', title);
  byId('og-description')?.setAttribute('content', description);
  byId('og-locale')?.setAttribute('content', ogLocale);
  byId('og-url')?.setAttribute('content', url);
  byId('twitter-title')?.setAttribute('content', title);
  byId('twitter-description')?.setAttribute('content', description);
  byId('link-canonical')?.setAttribute('href', url);
}

function applyLanguage(lang, { refetchGeocode = true } = {}) {
  LANG = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* private browsing */ }

  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
  updateSeoMeta();

  document.querySelectorAll('[data-i18n]').forEach(node => {
    node.textContent = t(node.dataset.i18n);
  });
  byId('lang').value = lang;
  byId('lang').setAttribute('aria-label', t('lang_aria'));
  byId('api-hint').innerHTML = t('api_hint', { origin: esc(location.origin) });
  byId('search-ip').setAttribute('aria-label', t('btn_lookup'));

  renderAlerts();
  renderServer();
  renderClient();
  renderHeaders();
  renderRaw();

  // The server returns the address in the requested language, so refresh it.
  if (refetchGeocode) {
    if (SERVER?.location?.latitude != null) refreshGeocoding();
    if (GPS.coords) geocodeGps();
  }
}

async function refreshGeocoding() {
  const { latitude, longitude } = SERVER.location;
  try {
    const res = await api(`/api/geocode?lat=${latitude}&lon=${longitude}`);
    if (res?.address) {
      SERVER.address = res.address;
      renderServer();
      renderRaw();
    }
  } catch { /* keep the previous address */ }
}

/* ================================================================== *
 * Loading data
 * ================================================================== */

function ipFromPath() {
  const seg = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''));
  return seg && seg !== 'api' ? seg : null;
}

async function load(ip) {
  TARGET_IP = ip;
  LAST_ERROR = null;
  SERVER = null;
  skeletons(true);
  byId('hero-ip').textContent = t('detecting');
  byId('alerts').innerHTML = '';
  byId('search-ip').value = ip || '';

  try {
    SERVER = await api(ip ? `/api/${encodeURIComponent(ip)}` : '/api');
  } catch (err) {
    LAST_ERROR = err.status === 429 ? t('err_rate')
      : err.status === 400 ? t('err_badip')
      : err.message || t('err_generic');
  }

  renderAlerts();
  renderServer();
  renderGps();
  renderRaw();
}

/* ================================================================== *
 * Bootstrap
 * ================================================================== */

function initLanguageSelect() {
  const sel = byId('lang');
  const names = window.LANG_NAMES || {};
  for (const code of SUPPORTED) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = names[code] || code;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => applyLanguage(sel.value));
}

function initEvents() {
  byId('btn-refresh').addEventListener('click', () => load(TARGET_IP));

  byId('btn-copy-ip').addEventListener('click', () => {
    if (SERVER?.ip) copyText(SERVER.ip, t('toast_ip', { ip: SERVER.ip }));
  });

  byId('btn-copy-json').addEventListener('click', () =>
    copyText(JSON.stringify(exportData(), null, 2), t('toast_json')));

  byId('btn-save-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(exportData(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `myip-${(SERVER?.ip || 'unknown').replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(t('toast_saved'));
  });

  byId('btn-geo').addEventListener('click', requestPreciseLocation);

  byId('search-form').addEventListener('submit', e => {
    e.preventDefault();
    const raw = byId('search-ip').value.trim();
    const target = raw || null;
    history.pushState({ ip: target }, '', target ? `/${encodeURIComponent(target)}` : '/');
    load(target);
  });

  byId('btn-mine').addEventListener('click', () => {
    history.pushState({ ip: null }, '', '/');
    load(null);
  });

  window.addEventListener('popstate', () => load(ipFromPath()));

  window.addEventListener('resize', () => {
    set('sc-viewport', `${innerWidth} × ${innerHeight} ${t('unit_px')}`);
  });
}

async function main() {
  initLanguageSelect();
  initEvents();
  applyLanguage(LANG, { refetchGeocode: false });

  // Server data, headers and browser collection all run in parallel.
  const serverReady = load(ipFromPath());
  loadHeaders();
  await collectClient();
  renderClient();
  renderRaw();

  await serverReady;
  // The WebRTC leak check needs both halves of the data.
  renderAlerts();
  renderClient();
}

main();
