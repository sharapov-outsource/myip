# myip

**Русская версия — [ниже](#русская-версия).**

A service that reports your external IP address and everything technical that can be
learned about a visitor. Works both as a page and as an API.

```
https://myip.sharapov.biz                    page about your own address
https://myip.sharapov.biz/8.8.8.8            page about an arbitrary address
https://myip.sharapov.biz?output=json        data instead of the page
https://myip.sharapov.biz/8.8.8.8?output=yaml
```

## What it shows

Server side (included in the JSON/YAML output):

| Section | Contents |
| --- | --- |
| IP | Address, protocol version, reverse DNS (PTR), subnet |
| Provider | ISP, organisation, ASN, domain, network type, route, abuse contact |
| Registry | RDAP/WHOIS: network name, range, CIDR, block holder, dates, RIR |
| Geolocation | Country, region, city, postal code, coordinates, continent, currency, time zone |
| Geocoding | Coordinates resolved to a postal address, down to the street, in the requested language |
| Reputation | VPN, proxy, Tor, data centre, mobile network and blacklist flags |

Browser side (page only; also included in the downloadable JSON):

| Section | Contents |
| --- | --- |
| Browser | Name and version, engine, languages, cookies, DNT/GPC, ad blocker, plugins |
| System | OS, platform version, architecture, model, cores, memory, battery, storage |
| Screen | Resolution, available area, window, DPI, colour depth, colour gamut, HDR |
| Graphics | GPU, WebGL, WebGPU, canvas and audio fingerprints, combined browser hash |
| WebRTC | Public address via STUN and local addresses — a VPN leak check |
| Precise location | GPS/Wi-Fi coordinates on request, their address and the distance from the IP location |
| Permissions | Permission states, number of microphones, speakers and cameras, installed fonts |
| Headers | HTTP headers as the server sees them |

Plus warnings: time zone not matching the IP, a detected VPN or data centre,
a WebRTC leak, a private address.

## API

| Route | Response |
| --- | --- |
| `GET /` | Page for browsers, JSON for console clients |
| `GET /<ip>` | The same for a given address |
| `GET /api` · `GET /api/<ip>` | Always data |
| `GET /api/geocode?lat=&lon=` | Reverse geocoding for coordinates |
| `GET /api/headers` | Request headers as the server sees them |
| `GET /healthz` | Liveness probe and cache stats |

Parameters: `output=json|yaml|html`, `lang=<code>`, `geocode=false` (skip geocoding —
faster), `download=1` (serve as a file).

The format is chosen automatically: `curl`, `wget`, `httpie` and friends get JSON with
no parameters, browsers get the page. `Accept: application/json` works too.

```bash
curl https://myip.sharapov.biz
```

```bash
curl -s "https://myip.sharapov.biz/1.1.1.1?output=yaml&lang=en"
```

Errors come back as JSON with `statusCode`, `error` and `message`. Private and
reserved ranges are answered with `bogon: true` without any outbound call.

## Languages

The interface is translated into 12 languages: English, Russian, Spanish, Chinese,
Hindi, Arabic, Portuguese, French, German, Japanese, Turkish and Ukrainian.

The language is detected from `navigator.languages` on first visit and remembered in
`localStorage` once picked manually. Arabic flips the layout right-to-left. Country
names are localized through `Intl.DisplayNames`, dates and times through
`Intl.DateTimeFormat`, and the address is requested from the geocoder in the selected
language.

To add a language: copy the `en` object in [i18n.js](public/i18n.js), translate the
values, register the code in `LANG_NAMES` and `LANG_LOCALES` (and in `RTL_LANGS` for
right-to-left scripts), then add the code to `SUPPORTED_LANGS` in
[server/index.js](server/index.js). `npm run check:i18n` verifies nothing was missed.

## Running

```bash
git clone https://github.com/sharapov-outsource/myip.git
```

```bash
npm install && npm start
```

Opens on http://localhost:3021

```bash
npm test
```

Checks syntax, dictionary consistency, and runs 30 API checks against a live server.
No upstream services are involved, so the test works offline.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3021` | Port |
| `HOSTNAME` | `0.0.0.0` | Interface |
| `TRUST_PROXY` | `true` | Read the client IP from `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For` |
| `HSTS` | `false` | Send `Strict-Transport-Security` |
| `RATE_MAX` | `120` | Overall requests per minute per address |
| `RATE_LOOKUP_MAX` | `30` | Limit on address lookups |
| `RATE_GEOCODE_MAX` | `12` | Limit on geocoding |
| `RATE_BAN` | `8` | How many violations before returning 403 |
| `MAX_INFLIGHT` | `24` | Ceiling on concurrent calls to upstream services |
| `CACHE_TTL_MS` | `900000` | Cache lifetime (15 minutes) |
| `CACHE_MAX` | `5000` | Cache size |
| `LOG_REQUESTS` | `false` | Log every request |

**Enable `TRUST_PROXY` only behind a reverse proxy.** If the server faces the internet
directly, a client can forge the header and bypass the limits — set `TRUST_PROXY=false`
in that case.

## Load protection

What the application does:

- **Per-address limits** — three tiers: overall, address lookups, geocoding. Repeat
  offenders get a 403 instead of a 429 after `RATE_BAN` violations.
- **Response cache** — 15 minutes per address. Repeat queries for the same IP never
  leave the box.
- **Outbound ceiling** — at most `MAX_INFLIGHT` concurrent calls to upstream services;
  beyond that a 503 is returned. A flood will not turn into thousands of outbound
  connections or burn through the free geolocation quotas.
- **Crawler cutoff** — `robots.txt` allows search engines on the home page only, so
  walking arbitrary addresses creates no load.
- **Strict headers** — CSP with no inline scripts, `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`.
- **Container limits** — 384 MB of memory, 256 processes, read-only filesystem,
  unprivileged user, `no-new-privileges`.

What the application cannot do: a real volumetric DDoS never reaches it — the uplink
and the reverse proxy fall over first. That belongs one layer up, at the network edge:

- **Cloudflare** (the free tier is enough) — proxy the domain, enable Bot Fight Mode
  and a rate limiting rule on `/api*`. It also supplies `CF-Connecting-IP`, which the
  service already reads.
- **Proxy-level limits** — `limit_req` in nginx or `rate_limit` in Caddy as a second
  line of defence in front of the application.
- **fail2ban** over the proxy logs for the truly persistent.

## Deployment

The container listens on `127.0.0.1:3021`; a reverse proxy exposes it to the world.

Caddy:

```
myip.sharapov.biz {
	encode zstd gzip
	rate_limit {
		zone api {
			key {remote_host}
			events 60
			window 1m
		}
	}
	reverse_proxy 127.0.0.1:3021
}
```

nginx:

```nginx
limit_req_zone $binary_remote_addr zone=myip:10m rate=2r/s;

server {
    server_name myip.sharapov.biz;
    listen 443 ssl http2;

    location / {
        limit_req zone=myip burst=20 nodelay;
        proxy_pass http://127.0.0.1:3021;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### CI/CD

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs on every push to
`main`: it executes the checks, builds the image, publishes it to GHCR and deploys
over SSH.

Required repository secrets (environment `Prod`): `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_SSH_KEY`, `DEPLOY_PORT` (optional), `GHCR_USERNAME`, `GHCR_TOKEN`.

Extra environment variables can be placed in `/opt/myip/.env` on the server — the
deploy step picks the file up if it exists.

Manually:

```bash
docker run -d --name myip --restart unless-stopped --init --read-only \
  --tmpfs /tmp --security-opt no-new-privileges --memory 384m \
  -e TRUST_PROXY=true -e HSTS=true \
  -p 127.0.0.1:3021:3021 ghcr.io/sharapov-outsource/myip:latest
```

## Data sources

Geolocation is queried from five services in parallel (`ipwho.is`, `ipapi.co`,
`ipinfo.io`, `geojs.io`, `ipapi.is`) and the results are merged field by field: if one
is unavailable or does not know a value, another fills it in. No API keys are needed.
Registry records come from RDAP via `rdap.org` with `rdap.db.ripe.net` as a fallback.
Reverse DNS is resolved by the server itself. Geocoding uses Nominatim (OpenStreetMap)
with BigDataCloud as a fallback. The map is an embedded OpenStreetMap widget.

The free tiers have daily quotas, and Nominatim asks for no more than one request per
second and forbids bulk usage. The cache and the limits keep traffic within those
bounds; at noticeable volume it makes sense to move to a paid geocoder or run your own
Nominatim instance.

## Limitations

- Only the protocol the connection actually arrived over is shown. Detecting both IPv4
  and IPv6 for the same client requires separate A-only and AAAA-only subdomains,
  which are not set up.
- IP geolocation accuracy is a city or a provider node, not a house. Real coordinates
  come only from the GPS section, and only with the user's permission.
- Geolocation services sometimes disagree (the same address can be reported in
  different countries). The merge takes the first non-empty value in source priority
  order, and the "Data sources" row shows who actually answered.
- VPN/proxy flags are an upstream service's heuristic, not a fact. False positives on
  large public resolvers are common.

## License

[MIT](LICENSE). Fork it, change it, use it commercially — the only condition is that
the copyright notice stays in copies of the source.

Pull requests are welcome, translations especially: `npm test` has to pass and the
dictionaries have to stay consistent.

---

## Русская версия

Сервис определения внешнего IP и всей технической информации, которую можно узнать
о посетителе. Работает как страница и как API.

```
https://myip.sharapov.biz                    страница про ваш адрес
https://myip.sharapov.biz/8.8.8.8            страница про произвольный адрес
https://myip.sharapov.biz?output=json        данные вместо страницы
https://myip.sharapov.biz/8.8.8.8?output=yaml
```

### Что показывает

Серверная часть (попадает в JSON/YAML):

| Раздел | Содержимое |
| --- | --- |
| IP | Адрес, версия протокола, обратный DNS (PTR), подсеть |
| Провайдер | ISP, организация, ASN, домен, тип сети, маршрут, abuse-контакт |
| Реестр | RDAP/WHOIS: имя сети, диапазон, CIDR, владелец блока, даты, RIR |
| Геолокация | Страна, регион, город, индекс, координаты, континент, валюта, часовой пояс |
| Геокодинг | Координаты → почтовый адрес вплоть до улицы, на языке запроса |
| Репутация | Признаки VPN, прокси, Tor, дата-центра, мобильной сети, чёрных списков |

Браузерная часть (только на странице, в скачиваемый JSON тоже попадает):

| Раздел | Содержимое |
| --- | --- |
| Браузер | Название и версия, движок, языки, cookies, DNT/GPC, блокировщик, плагины |
| Система | ОС, версия платформы, архитектура, модель, ядра, память, батарея, хранилище |
| Экран | Разрешение, рабочая область, окно, DPI, глубина цвета, цветовой охват, HDR |
| Графика | Видеокарта, WebGL, WebGPU, canvas- и audio-отпечатки, итоговый хэш браузера |
| WebRTC | Публичный адрес через STUN и локальные адреса — проверка утечки под VPN |
| Точная геолокация | GPS/Wi-Fi координаты по запросу, их адрес и расхождение с IP-геолокацией |
| Разрешения | Состояние прав, количество микрофонов, динамиков, камер, шрифты |
| Заголовки | HTTP-заголовки, как их видит сервер |

Плюс предупреждения: несовпадение часового пояса с IP, обнаруженный VPN или
дата-центр, утечка WebRTC, приватный адрес.

### API

| Маршрут | Ответ |
| --- | --- |
| `GET /` | Страница для браузера, JSON для консольных клиентов |
| `GET /<ip>` | То же для указанного адреса |
| `GET /api` · `GET /api/<ip>` | Всегда данные |
| `GET /api/geocode?lat=&lon=` | Обратный геокодинг координат |
| `GET /api/headers` | Заголовки запроса глазами сервера |
| `GET /healthz` | Проверка живости, состояние кеша |

Параметры: `output=json|yaml|html`, `lang=<код>`, `geocode=false` (пропустить
геокодинг — быстрее), `download=1` (отдать файлом).

Формат выбирается автоматически: `curl`, `wget`, `httpie` и подобные получают JSON
без параметров, браузер — страницу. Работает и `Accept: application/json`.

```bash
curl https://myip.sharapov.biz
```

```bash
curl -s "https://myip.sharapov.biz/1.1.1.1?output=yaml&lang=ru"
```

Ошибки приходят в JSON с полями `statusCode`, `error`, `message`.
Приватные и служебные диапазоны отдаются с `bogon: true` без обращения наружу.

### Языки

Интерфейс переведён на 12 языков: английский, русский, испанский, китайский, хинди,
арабский, португальский, французский, немецкий, японский, турецкий, украинский.

Язык определяется из `navigator.languages` при первом заходе и запоминается в
`localStorage` после ручного выбора. Для арабского вёрстка разворачивается справа
налево. Названия стран локализуются через `Intl.DisplayNames`, даты и время — через
`Intl.DateTimeFormat`, адрес запрашивается у геокодера на выбранном языке.

Чтобы добавить язык: скопируйте объект `en` в [i18n.js](public/i18n.js), переведите
значения, впишите код в `LANG_NAMES` и `LANG_LOCALES` (и в `RTL_LANGS`, если письмо
справа налево), добавьте код в `SUPPORTED_LANGS` в [server/index.js](server/index.js).
`npm run check:i18n` проверит, что ничего не забыто.

### Запуск

```bash
git clone https://github.com/sharapov-outsource/myip.git
```

```bash
npm install && npm start
```

Откроется на http://localhost:3021

```bash
npm test
```

Проверяет синтаксис, согласованность словарей и прогоняет 30 проверок API
на поднятом сервере. Внешние сервисы не задействованы — тест работает без сети.

### Настройки

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `PORT` | `3021` | Порт |
| `HOSTNAME` | `0.0.0.0` | Интерфейс |
| `TRUST_PROXY` | `true` | Читать IP клиента из `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For` |
| `HSTS` | `false` | Отдавать `Strict-Transport-Security` |
| `RATE_MAX` | `120` | Общий лимит запросов в минуту на адрес |
| `RATE_LOOKUP_MAX` | `30` | Лимит на просмотры адресов |
| `RATE_GEOCODE_MAX` | `12` | Лимит на геокодинг |
| `RATE_BAN` | `8` | После скольких превышений отдавать 403 |
| `MAX_INFLIGHT` | `24` | Потолок одновременных обращений к внешним сервисам |
| `CACHE_TTL_MS` | `900000` | Время жизни кеша (15 минут) |
| `CACHE_MAX` | `5000` | Размер кеша |
| `LOG_REQUESTS` | `false` | Писать каждый запрос в лог |

**`TRUST_PROXY` включайте только за обратным прокси.** Если сервер смотрит в
интернет напрямую, клиент подделает заголовок и обойдёт лимиты — тогда ставьте
`TRUST_PROXY=false`.

### Защита от нагрузки

Что делает приложение:

- **Лимиты по адресу** — три уровня: общий, на просмотры адресов, на геокодинг.
  Повторные нарушители после `RATE_BAN` превышений получают 403 вместо 429.
- **Кеш ответов** — 15 минут на адрес. Повторные запросы одного IP наружу не ходят.
- **Потолок исходящих** — не более `MAX_INFLIGHT` одновременных обращений к внешним
  сервисам; сверх этого приходит 503. Наплыв не превратится в тысячи исходящих
  соединений и не сожжёт бесплатные квоты гео-сервисов.
- **Отсечка ботов** — `robots.txt` пускает поисковики только на главную, чтобы обход
  произвольных адресов не создавал нагрузку.
- **Жёсткие заголовки** — CSP без inline-скриптов, `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, ограничивающий `Permissions-Policy`.
- **Ограничения контейнера** — 384 МБ памяти, 256 процессов, read-only ФС,
  непривилегированный пользователь, `no-new-privileges`.

Чего приложение не может: настоящий объёмный DDoS до него просто не дойдёт —
канал и обратный прокси лягут раньше. Это задача уровня выше, и решается она
на границе сети:

- **Cloudflare** (бесплатного тарифа достаточно) — проксирование домена, Bot Fight
  Mode и правило rate limiting на `/api*`. Заодно приходит `CF-Connecting-IP`,
  который сервис уже умеет читать.
- **Лимиты на прокси** — `limit_req` в nginx или `rate_limit` в Caddy как второй
  рубеж перед приложением.
- **fail2ban** по логам прокси для совсем настырных.

### Развёртывание

Контейнер слушает `127.0.0.1:3021`, наружу его выставляет обратный прокси.
Примеры конфигураций Caddy и nginx — в английской части выше.

CI/CD: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) на пуш в `main`
прогоняет проверки, собирает образ, публикует в GHCR и разворачивает по SSH.

Нужные секреты репозитория (окружение `Prod`): `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_SSH_KEY`, `DEPLOY_PORT` (необязательно), `GHCR_USERNAME`, `GHCR_TOKEN`.

Дополнительные переменные окружения можно положить в `/opt/myip/.env` на сервере —
деплой подхватит файл, если он есть.

Вручную:

```bash
docker run -d --name myip --restart unless-stopped --init --read-only \
  --tmpfs /tmp --security-opt no-new-privileges --memory 384m \
  -e TRUST_PROXY=true -e HSTS=true \
  -p 127.0.0.1:3021:3021 ghcr.io/sharapov-outsource/myip:latest
```

### Источники данных

Геолокация опрашивается сразу у пяти сервисов параллельно (`ipwho.is`, `ipapi.co`,
`ipinfo.io`, `geojs.io`, `ipapi.is`), результаты сливаются по полям: если один
недоступен или не знает какой-то параметр, его подставит другой. Ни один ключ API
не нужен. Регистрационные данные — RDAP через `rdap.org` с запасным
`rdap.db.ripe.net`. Обратный DNS сервер резолвит сам. Геокодинг — Nominatim
(OpenStreetMap) с запасным BigDataCloud. Карта — встраиваемый виджет OpenStreetMap.

У бесплатных тарифов есть суточные квоты, а Nominatim просит не больше запроса в
секунду и запрещает массовое использование. Кеш и лимиты держат нагрузку в этих
рамках; при заметном трафике имеет смысл перейти на платный геокодер или поднять
свой инстанс Nominatim.

### Ограничения

- Показывается протокол, по которому пришло соединение. Определить одновременно
  IPv4 и IPv6 одного клиента можно только через отдельные A- и AAAA-поддомены —
  сейчас этого нет.
- Точность IP-геолокации — город или узел провайдера, а не дом. Реальные координаты
  даёт только раздел с GPS, и то с разрешения пользователя.
- Гео-сервисы иногда расходятся в показаниях (у одного адреса могут быть разные
  страны). Слияние берёт первое непустое значение в порядке приоритета источников,
  а строка «Источники данных» показывает, кто реально ответил.
- Признаки VPN/прокси — эвристика внешнего сервиса, а не факт. Ложные срабатывания
  на крупных публичных резолверах обычны.

### Лицензия

[MIT](LICENSE). Форкайте, меняйте, используйте коммерчески — единственное условие
в том, чтобы копирайт оставался в копиях исходников.

Pull request'ы приветствуются, особенно переводы: `npm test` должен проходить,
словари — оставаться согласованными.
