# myip

**Русская версия — [ниже](#русская-версия).**

External IP address and every piece of technical information available about a
visitor. Works as a page and as an API.

Live: **https://myip.sharapov.biz**

## Usage

| URL | Result |
| --- | --- |
| `/` | Page about your own address |
| `/8.8.8.8` | Page about an arbitrary address |
| `/?output=json` | Data instead of the page |
| `/8.8.8.8?output=yaml` | Data for a given address |

`curl`, `wget`, `httpie` and similar clients get JSON with no parameters; browsers
get the page. `Accept: application/json` works too.

```bash
curl https://myip.sharapov.biz
```

```bash
curl -s "https://myip.sharapov.biz/1.1.1.1?output=yaml&lang=en"
```

## API

| Route | Response |
| --- | --- |
| `GET /` · `GET /<ip>` | Page for browsers, JSON for console clients |
| `GET /api` · `GET /api/<ip>` | Always data |
| `GET /api/geocode?lat=&lon=` | Reverse geocoding for coordinates |
| `GET /api/headers` | Request headers as the server sees them |
| `GET /healthz` | Liveness probe and cache stats |

Parameters: `output=json|yaml|html`, `lang=<code>`, `geocode=false` (skip geocoding,
faster), `download=1` (serve as a file).

Errors are JSON with `statusCode`, `error` and `message`. Private and reserved ranges
answer with `bogon: true` and no outbound call.

## What it shows

Server side, included in the JSON/YAML output:

| Section | Contents |
| --- | --- |
| IP | Address, protocol version, reverse DNS (PTR), subnet |
| Provider | ISP, organisation, ASN, domain, network type, route, abuse contact |
| Registry | RDAP/WHOIS: network name, range, CIDR, block holder, dates, RIR |
| Geolocation | Country, region, city, postal code, coordinates, continent, currency, time zone |
| Geocoding | Coordinates resolved to a postal address, down to the street |
| Reputation | VPN, proxy, Tor, data centre, mobile network and blacklist flags |

Browser side, page only, also included in the downloadable JSON:

| Section | Contents |
| --- | --- |
| Browser | Name and version, engine, languages, cookies, DNT/GPC, ad blocker, plugins |
| System | OS, platform version, architecture, model, cores, memory, battery, storage |
| Screen | Resolution, available area, window, DPI, colour depth, colour gamut, HDR |
| Graphics | GPU, WebGL, WebGPU, canvas and audio fingerprints, combined browser hash |
| WebRTC | Public address via STUN and local addresses — a VPN leak check |
| Precise location | GPS/Wi-Fi coordinates on request, their address and the distance from the IP location |
| Permissions | Permission states, microphone/speaker/camera counts, installed fonts |
| Headers | HTTP headers as the server sees them |

The page also warns about a time zone that does not match the IP, a detected VPN or
data centre, a WebRTC leak and a private address.

## Languages

12 languages: English, Russian, Spanish, Chinese, Hindi, Arabic, Portuguese, French,
German, Japanese, Turkish, Ukrainian. Arabic flips the layout right-to-left.

The language comes from `navigator.languages` and is remembered in `localStorage`
once picked manually. The server picks it from `Accept-Language` for the page head.

To add one: copy the `en` object in [i18n.js](public/i18n.js), translate the values
and register the code in `LANG_NAMES` and `LANG_LOCALES` — plus `RTL_LANGS` for
right-to-left scripts. That file is the single source of truth; the server reads it
too. Run `npm run check:i18n` to verify.

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

Syntax check, dictionary consistency and 47 API checks against a live server. No
upstream services involved, so it works offline.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3021` | Port |
| `HOSTNAME` | `0.0.0.0` | Interface |
| `TRUST_PROXY` | `true` | Read the client IP from `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For` |
| `PUBLIC_ORIGIN` | derived from `Host` | Canonical origin for `canonical`, `og:url` and the sitemap |
| `HSTS` | `false` | Send `Strict-Transport-Security` |
| `RATE_MAX` | `120` | Overall requests per minute per address |
| `RATE_LOOKUP_MAX` | `30` | Limit on address lookups |
| `RATE_GEOCODE_MAX` | `12` | Limit on geocoding |
| `RATE_BAN` | `8` | Violations before returning 403 |
| `MAX_INFLIGHT` | `24` | Ceiling on concurrent calls to upstream services |
| `CACHE_TTL_MS` | `900000` | Cache lifetime |
| `CACHE_MAX` | `5000` | Cache size |
| `LOG_REQUESTS` | `false` | Log every request |

Two settings matter in production:

- `TRUST_PROXY` only behind a reverse proxy. Facing the internet directly, a client
  can forge the header and bypass the rate limits.
- `PUBLIC_ORIGIN` pins the canonical URL. Without it it is built from the `Host`
  header, which a client controls.

## Load protection

Rate limits per address in three tiers (overall, lookups, geocoding), a 15-minute
response cache, a ceiling of `MAX_INFLIGHT` concurrent outbound calls, and container
limits: 384 MB, 256 processes, read-only filesystem, unprivileged user.

Security headers: CSP with no inline scripts, `nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`.

## SEO

The page head is rendered server side, because social scrapers and simpler crawlers
do not run JavaScript: title, description, `canonical` and `og:` tags are correct in
the markup, localized by `Accept-Language`, with `Vary: Accept-Language` on the
response. The client updates the same tags when the visitor switches language.

`robots.txt` allows `/` and `/static/`, disallows `/api` and address pages. Keeping
the assets crawlable is required — the page is rendered by its scripts, so a crawler
denied access to them indexes an empty body. Address pages send
`X-Robots-Tag: noindex, follow`.

Icons come from [favicon.svg](public/favicon.svg):

```bash
rsvg-convert -w 512 -h 512 public/favicon.svg -o public/icon-512.png
```

## Deployment

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs on push to `main`:
checks, image build, publish to GHCR, deploy over SSH. The container is published on
`127.0.0.1:3023`, so a reverse proxy has to sit in front of it.

Repository secrets, environment `Prod`: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`,
`DEPLOY_PORT` (optional), `GHCR_USERNAME`, `GHCR_TOKEN`. Extra environment variables
go in `/opt/myip/.env` on the server; the deploy picks the file up if it exists.

Manually:

```bash
docker run -d --name myip --restart unless-stopped --init --read-only \
  --tmpfs /tmp --security-opt no-new-privileges --memory 384m \
  -e TRUST_PROXY=true -e HSTS=true -e PUBLIC_ORIGIN=https://myip.sharapov.biz \
  -p 127.0.0.1:3021:3021 ghcr.io/sharapov-outsource/myip:latest
```

## Data sources

Geolocation is queried from five services in parallel — `ipwho.is`, `ipapi.co`,
`ipinfo.io`, `geojs.io`, `ipapi.is` — and merged field by field, so one being down
or incomplete does not break the answer. No API keys needed. Registry data comes from
RDAP via `rdap.org`, falling back to `rdap.db.ripe.net`. Reverse DNS is resolved by
the server. Geocoding uses Nominatim with BigDataCloud as a fallback. The map is an
embedded OpenStreetMap widget.

Free tiers have daily quotas and Nominatim asks for at most one request per second.
The cache and the rate limits keep usage within those bounds.

## Limitations

- Only the protocol the connection arrived over is shown. Detecting IPv4 and IPv6 for
  the same client needs separate A-only and AAAA-only subdomains, which do not exist.
- IP geolocation resolves to a city or a provider node, not a building. Real
  coordinates come only from the GPS section, with the user's permission.
- VPN and proxy flags are an upstream heuristic, not a fact. False positives on large
  public resolvers are common.

## License

[MIT](LICENSE).

---

## Русская версия

Внешний IP-адрес и вся техническая информация, которую можно узнать о посетителе.
Работает как страница и как API.

Рабочий адрес: **https://myip.sharapov.biz**

### Как пользоваться

| URL | Результат |
| --- | --- |
| `/` | Страница про ваш адрес |
| `/8.8.8.8` | Страница про произвольный адрес |
| `/?output=json` | Данные вместо страницы |
| `/8.8.8.8?output=yaml` | Данные по указанному адресу |

`curl`, `wget`, `httpie` и подобные получают JSON без параметров, браузер — страницу.
Работает и `Accept: application/json`.

```bash
curl https://myip.sharapov.biz
```

```bash
curl -s "https://myip.sharapov.biz/1.1.1.1?output=yaml&lang=ru"
```

### API

| Маршрут | Ответ |
| --- | --- |
| `GET /` · `GET /<ip>` | Страница для браузера, JSON для консольных клиентов |
| `GET /api` · `GET /api/<ip>` | Всегда данные |
| `GET /api/geocode?lat=&lon=` | Обратный геокодинг координат |
| `GET /api/headers` | Заголовки запроса глазами сервера |
| `GET /healthz` | Проверка живости и состояние кеша |

Параметры: `output=json|yaml|html`, `lang=<код>`, `geocode=false` (без геокодинга,
быстрее), `download=1` (отдать файлом).

Ошибки — JSON с полями `statusCode`, `error`, `message`. Приватные и служебные
диапазоны отдаются с `bogon: true` без обращения наружу.

### Что показывает

Серверная часть, попадает в JSON/YAML:

| Раздел | Содержимое |
| --- | --- |
| IP | Адрес, версия протокола, обратный DNS (PTR), подсеть |
| Провайдер | ISP, организация, ASN, домен, тип сети, маршрут, abuse-контакт |
| Реестр | RDAP/WHOIS: имя сети, диапазон, CIDR, владелец блока, даты, RIR |
| Геолокация | Страна, регион, город, индекс, координаты, континент, валюта, часовой пояс |
| Геокодинг | Координаты → почтовый адрес вплоть до улицы |
| Репутация | Признаки VPN, прокси, Tor, дата-центра, мобильной сети, чёрных списков |

Браузерная часть, только на странице, попадает в скачиваемый JSON:

| Раздел | Содержимое |
| --- | --- |
| Браузер | Название и версия, движок, языки, cookies, DNT/GPC, блокировщик, плагины |
| Система | ОС, версия платформы, архитектура, модель, ядра, память, батарея, хранилище |
| Экран | Разрешение, рабочая область, окно, DPI, глубина цвета, цветовой охват, HDR |
| Графика | Видеокарта, WebGL, WebGPU, canvas- и audio-отпечатки, итоговый хэш браузера |
| WebRTC | Публичный адрес через STUN и локальные адреса — проверка утечки под VPN |
| Точная геолокация | GPS/Wi-Fi координаты по запросу, их адрес и расхождение с IP |
| Разрешения | Состояние прав, число микрофонов, динамиков и камер, шрифты |
| Заголовки | HTTP-заголовки, как их видит сервер |

Страница дополнительно предупреждает о несовпадении часового пояса с IP,
обнаруженном VPN или дата-центре, утечке WebRTC и приватном адресе.

### Языки

12 языков: английский, русский, испанский, китайский, хинди, арабский,
португальский, французский, немецкий, японский, турецкий, украинский. Для арабского
вёрстка разворачивается справа налево.

Язык берётся из `navigator.languages` и запоминается в `localStorage` после ручного
выбора. Сервер определяет его по `Accept-Language` для head страницы.

Чтобы добавить язык: скопируйте объект `en` в [i18n.js](public/i18n.js), переведите
значения и впишите код в `LANG_NAMES` и `LANG_LOCALES`, а для письма справа налево
ещё и в `RTL_LANGS`. Этот файл — единственный источник правды, сервер читает его же.
Проверить: `npm run check:i18n`.

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

Синтаксис, согласованность словарей и 47 проверок API на поднятом сервере. Внешние
сервисы не задействованы — работает без сети.

### Настройки

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `PORT` | `3021` | Порт |
| `HOSTNAME` | `0.0.0.0` | Интерфейс |
| `TRUST_PROXY` | `true` | Читать IP клиента из `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For` |
| `PUBLIC_ORIGIN` | из заголовка `Host` | Канонический origin для `canonical`, `og:url` и sitemap |
| `HSTS` | `false` | Отдавать `Strict-Transport-Security` |
| `RATE_MAX` | `120` | Общий лимит запросов в минуту на адрес |
| `RATE_LOOKUP_MAX` | `30` | Лимит на просмотры адресов |
| `RATE_GEOCODE_MAX` | `12` | Лимит на геокодинг |
| `RATE_BAN` | `8` | Сколько превышений до 403 |
| `MAX_INFLIGHT` | `24` | Потолок одновременных обращений к внешним сервисам |
| `CACHE_TTL_MS` | `900000` | Время жизни кеша |
| `CACHE_MAX` | `5000` | Размер кеша |
| `LOG_REQUESTS` | `false` | Писать каждый запрос в лог |

Две настройки важны в продакшене:

- `TRUST_PROXY` включайте только за обратным прокси. Если сервер смотрит в интернет
  напрямую, клиент подделает заголовок и обойдёт лимиты.
- `PUBLIC_ORIGIN` фиксирует канонический адрес. Без него он собирается из заголовка
  `Host`, а его контролирует клиент.

### Защита от нагрузки

Лимиты по адресу в три уровня (общий, просмотры, геокодинг), кеш ответов на 15 минут,
потолок в `MAX_INFLIGHT` одновременных исходящих запросов и ограничения контейнера:
384 МБ, 256 процессов, read-only ФС, непривилегированный пользователь.

Заголовки безопасности: CSP без inline-скриптов, `nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, ограничивающий `Permissions-Policy`.

### SEO

Head страницы формируется на сервере, потому что соцсети и часть краулеров не
исполняют JavaScript: заголовок, описание, `canonical` и `og:`-теги корректны прямо
в разметке, локализованы по `Accept-Language`, ответ идёт с `Vary: Accept-Language`.
Клиент обновляет те же теги при переключении языка.

`robots.txt` разрешает `/` и `/static/`, запрещает `/api` и страницы адресов.
Оставить ассеты открытыми обязательно: страница рисуется скриптами, и краулер без
доступа к ним проиндексирует пустое тело. Страницы адресов отдаются с
`X-Robots-Tag: noindex, follow`.

Иконки собираются из [favicon.svg](public/favicon.svg):

```bash
rsvg-convert -w 512 -h 512 public/favicon.svg -o public/icon-512.png
```

### Развёртывание

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) на пуш в `main`:
проверки, сборка образа, публикация в GHCR, деплой по SSH. Контейнер публикуется на
`127.0.0.1:3023`, наружу его выставляет обратный прокси.

Секреты репозитория, окружение `Prod`: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`,
`DEPLOY_PORT` (необязательно), `GHCR_USERNAME`, `GHCR_TOKEN`. Дополнительные
переменные окружения кладутся в `/opt/myip/.env` на сервере — деплой подхватит файл,
если он есть.

Вручную:

```bash
docker run -d --name myip --restart unless-stopped --init --read-only \
  --tmpfs /tmp --security-opt no-new-privileges --memory 384m \
  -e TRUST_PROXY=true -e HSTS=true -e PUBLIC_ORIGIN=https://myip.sharapov.biz \
  -p 127.0.0.1:3021:3021 ghcr.io/sharapov-outsource/myip:latest
```

### Источники данных

Геолокация опрашивается у пяти сервисов параллельно — `ipwho.is`, `ipapi.co`,
`ipinfo.io`, `geojs.io`, `ipapi.is` — и сливается по полям, так что недоступность или
неполнота одного не ломает ответ. Ключи API не нужны. Регистрационные данные — RDAP
через `rdap.org` с запасным `rdap.db.ripe.net`. Обратный DNS сервер резолвит сам.
Геокодинг — Nominatim с запасным BigDataCloud. Карта — виджет OpenStreetMap.

У бесплатных тарифов есть суточные квоты, Nominatim просит не больше запроса в
секунду. Кеш и лимиты держат нагрузку в этих рамках.

### Ограничения

- Показывается только протокол, по которому пришло соединение. Чтобы определить у
  одного клиента и IPv4, и IPv6, нужны отдельные A- и AAAA-поддомены, их нет.
- Точность IP-геолокации — город или узел провайдера, а не дом. Реальные координаты
  даёт только раздел с GPS и только с разрешения пользователя.
- Признаки VPN и прокси — эвристика внешнего сервиса, а не факт. Ложные срабатывания
  на крупных публичных резолверах обычны.

### Лицензия

[MIT](LICENSE).
