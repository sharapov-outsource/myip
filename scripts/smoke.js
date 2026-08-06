/**
 * Smoke test: boots the server and exercises its routes.
 *
 * Deliberately avoids upstream geolocation services by querying private
 * addresses, whose responses are produced locally. That keeps the test
 * deterministic and lets it pass in CI without internet access.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3399;
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HOSTNAME: '127.0.0.1', TRUST_PROXY: 'false', LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', d => { serverOutput += d; });
server.stderr.on('data', d => { serverOutput += d; });

const failures = [];
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) return;
  failures.push(detail ? `${name} — ${detail}` : name);
}

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server never answered /healthz\n' + serverOutput);
}

async function run() {
  await waitForServer();

  // Private address: answered without any outbound call.
  const priv = await (await fetch(`${base}/api/192.168.1.1`)).json();
  check('bogon: ip', priv.ip === '192.168.1.1', JSON.stringify(priv.ip));
  check('bogon: flag', priv.bogon === true);
  check('bogon: version', priv.version === 'IPv4');

  const priv6 = await (await fetch(`${base}/api/fd00::1`)).json();
  check('bogon IPv6', priv6.bogon === true && priv6.version === 'IPv6');

  // YAML output.
  const yamlRes = await fetch(`${base}/api/10.0.0.1?output=yaml`);
  const yamlBody = await yamlRes.text();
  check('yaml: content-type', (yamlRes.headers.get('content-type') || '').includes('yaml'));
  check('yaml: body', yamlBody.startsWith('ip: 10.0.0.1'), yamlBody.slice(0, 40));

  // Download as a file.
  const dl = await fetch(`${base}/api/10.0.0.1?output=json&download=1`);
  check('download: content-disposition',
    (dl.headers.get('content-disposition') || '').includes('attachment'));

  // Unknown format.
  check('output=xml -> 400', (await fetch(`${base}/api?output=xml`)).status === 400);

  // Malformed address.
  check('invalid ip -> 400', (await fetch(`${base}/api/300.1.2.3`)).status === 400);
  check('junk in path -> 400', (await fetch(`${base}/api/%2Fetc%2Fpasswd`)).status === 400);

  // Page for browsers.
  const page = await fetch(`${base}/8.8.8.8`, {
    headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' },
  });
  const html = await page.text();
  check('html: status', page.status === 200);
  check('html: content-type', (page.headers.get('content-type') || '').includes('text/html'));
  check('html: links app.js', html.includes('/static/app.js'));
  check('html: links i18n.js', html.includes('/static/i18n.js'));

  // curl without an Accept header gets data, not the page.
  const cli = await fetch(`${base}/`, { headers: { 'user-agent': 'curl/8.7.1' } });
  check('curl -> json', (cli.headers.get('content-type') || '').includes('json'));

  // Security headers.
  const csp = page.headers.get('content-security-policy') || '';
  check('csp: script-src self', csp.includes("script-src 'self'"));
  check('csp: frame-ancestors none', csp.includes("frame-ancestors 'none'"));
  check('header nosniff', page.headers.get('x-content-type-options') === 'nosniff');
  check('header X-Frame-Options', page.headers.get('x-frame-options') === 'DENY');

  // Static assets and directory traversal protection.
  for (const file of ['styles.css', 'app.js', 'i18n.js']) {
    const res = await fetch(`${base}/static/${file}`);
    check(`static ${file}`, res.ok, `status ${res.status}`);
  }
  check('directory traversal blocked',
    [400, 403, 404].includes((await fetch(`${base}/static/../package.json`)).status));

  // Geocoding: input validation only, no outbound call.
  check('geocode: missing params -> 400', (await fetch(`${base}/api/geocode`)).status === 400);
  check('geocode: latitude out of range -> 400',
    (await fetch(`${base}/api/geocode?lat=91&lon=0`)).status === 400);

  // Request headers.
  const headers = await (await fetch(`${base}/api/headers`, { headers: { 'x-test': 'yes' } })).json();
  check('headers: echo', headers.headers?.['x-test'] === 'yes');
  check('headers: cookie stripped', !('cookie' in (headers.headers || {})));

  // Service routes.
  check('robots.txt', (await fetch(`${base}/robots.txt`)).ok);
  check('404 on unknown path',
    (await fetch(`${base}/foo/bar/baz`, { headers: { accept: 'application/json' } })).status === 404);

  // Rate limiting on address lookups.
  const codes = [];
  for (let i = 0; i < 45; i++) {
    codes.push((await fetch(`${base}/api/172.16.0.1`)).status);
  }
  check('rate limit kicks in', codes.includes(429), `codes: ${[...new Set(codes)].join(',')}`);
}

try {
  await run();
} catch (err) {
  failures.push('exception: ' + err.message);
} finally {
  server.kill('SIGTERM');
}

if (failures.length) {
  console.error(`Smoke test failed (${failures.length} of ${checks}):`);
  failures.forEach(f => console.error('  x ' + f));
  process.exit(1);
}

console.log(`Smoke test passed: ${checks} checks.`);
