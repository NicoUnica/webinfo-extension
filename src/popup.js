const $ = (id) => document.getElementById(id);
const CACHE_TTL = 10 * 60 * 1000;
const SSL_CACHE_TTL = 6 * 60 * 60 * 1000;
const WHOIS_CACHE_TTL = 24 * 60 * 60 * 1000;
const DNS_CACHE_TTL = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;
const TILE_HOST = 'https://tile.openstreetmap.org';
const TILE_ZOOM = 4;

// Acorta nombres de regiones especiales.
const REGION_SHORT_NAMES = {
  es: { hk: 'Hong Kong', mo: 'Macau', tw: 'Taiwán' },
  en: { hk: 'Hong Kong', mo: 'Macau', tw: 'Taiwan' },
};

function detectLocale() {
  let lang = '';
  try { lang = chrome.i18n.getUILanguage() || ''; } catch {}
  if (!lang) lang = navigator.language || '';
  return /^es/i.test(lang) ? 'es' : 'en';
}
const LOCALE = detectLocale();
let currentMapCoords = null;
let lastSslData = null;
let lastWhoisData = null;
let initializing = false;
let mapLoadTimer;

function t(key) {
  return chrome.i18n.getMessage(key) || key;
}

function localeTag() {
  return LOCALE === 'es' ? 'es-ES' : 'en-US';
}

function applyStaticI18n() {
  document.documentElement.lang = LOCALE;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const value = t(el.dataset.i18n);
    if (value) el.textContent = value;
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const value = t(el.dataset.i18nAria);
    if (value) el.setAttribute('aria-label', value);
  });
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function isSpecialPage(url) {
  try {
    const parsed = new URL(url);
    return !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname;
  } catch {
    return true;
  }
}

function normalizeData(raw, ip) {
  const asn = raw.connection?.asn ? String(raw.connection.asn) : '';
  return {
    ip: raw.ip || ip,
    country: raw.country,
    country_code: raw.country_code,
    city: raw.city,
    region: raw.region,
    latitude: raw.latitude,
    longitude: raw.longitude,
    timezone: raw.timezone?.id,
    isp: raw.connection?.isp,
    asn: asn ? (asn.toUpperCase().startsWith('AS') ? asn.toUpperCase() : `AS${asn}`) : undefined,
  };
}

// Evita que el popup quede cargando indefinidamente.
const FETCH_TIMEOUT_MS = 8000;
async function fetchJson(resource, options = {}) {
  const { timeout = FETCH_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, { ...fetchOptions, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGeoJson(ip) {
  const raw = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`);
  return raw?.success === true && isIpAddress(raw.ip) ? raw : null;
}

async function fetchSslJson(hostname) {
  const raw = await fetchJson(`https://host.tools/api/v1/ssl/cert?q=${encodeURIComponent(hostname)}`);
  if (raw?.ok === false || !raw?.data || typeof raw.data !== 'object') return null;
  const data = raw.data;
  return {
    issuer: typeof data.issuer === 'string' ? data.issuer : data.issuer?.CN || data.issuer?.O,
    host: data.cn || data.host || data.subject?.CN,
    expires_at: data.valid_to,
    expired: data.expired === true,
  };
}

async function fetchWhoisJson(hostname) {
  if (isIpAddress(hostname)) return null;
  const raw = await fetchJson(`https://who-dat.as93.net/${encodeURIComponent(hostname)}`);
  if (!raw || typeof raw !== 'object' || raw.error) return null;
  const data = {
    registrar: raw.registrar?.name,
    created: raw.dates?.created,
    expires: raw.dates?.expires,
  };
  return Object.values(data).some(Boolean) ? data : null;
}

// Un fallo de almacenamiento no debe impedir mostrar una respuesta válida.
async function cachedLookup(key, ttl, load) {
  try {
    const entry = (await chrome.storage.session.get(key))[key];
    if (entry?.expiresAt > Date.now()) return entry.data;
    if (entry) await chrome.storage.session.remove(key);
  } catch {}
  const data = await load();
  if (data) {
    const duration = typeof ttl === 'function' ? ttl(data) : ttl;
    if (duration > 0) {
      try {
        await chrome.storage.session.set({ [key]: { data, expiresAt: Date.now() + duration } });
      } catch {}
    }
  }
  return data;
}

async function pruneCache() {
  try {
    const entries = Object.entries(await chrome.storage.session.get(null))
      .filter(([key]) => /^(ip|geo|ssl|whois)_/.test(key));
    const expired = entries.filter(([, value]) => !(value?.expiresAt > Date.now())).map(([key]) => key);
    const live = entries.filter(([, value]) => value?.expiresAt > Date.now())
      .sort((a, b) => b[1].expiresAt - a[1].expiresAt);
    const remove = [...expired, ...live.slice(MAX_CACHE_ENTRIES - 4).map(([key]) => key)];
    if (remove.length) await chrome.storage.session.remove(remove);
  } catch {}
}

function extractAsn(asString) {
  if (!asString) return '--';
  const m = asString.match(/^(AS\s*\d+)/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, '') : asString;
}

function isIPv4(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.');
  return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIPv6(ip) {
  if (typeof ip !== 'string' || !ip.includes(':') || !/^[0-9a-f:.]+$/i.test(ip)) return false;
  try {
    return new URL(`http://[${ip}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

function isIpAddress(ip) {
  return isIPv4(ip) || isIPv6(ip);
}

// Prioriza IPv4 y usa IPv6 como alternativa.
async function resolveDnsRecord(hostname, type, answerType) {
  try {
    const data = await fetchJson(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      { headers: { 'Accept': 'application/dns-json' } }
    );
    if (data.Status !== 0 || !Array.isArray(data.Answer)) return null;
    const valid = answerType === 1 ? isIPv4 : isIPv6;
    const answer = data.Answer.find(entry => entry.type === answerType && valid(entry.data));
    if (!answer) return null;
    const ttl = Number.isFinite(answer.TTL) ? Math.max(0, answer.TTL * 1000) : 60 * 1000;
    return { ip: answer.data, ttl: Math.min(ttl, DNS_CACHE_TTL) };
  } catch {
    return null;
  }
}

async function resolveIpDoH(hostname) {
  return await resolveDnsRecord(hostname, 'A', 1)
    || await resolveDnsRecord(hostname, 'AAAA', 28);
}

async function resolveHostIp(hostname) {
  const record = await cachedLookup(`ip_${hostname}`, data => data.ttl, () => resolveIpDoH(hostname));
  return isIpAddress(record?.ip) ? record.ip : null;
}

// Convierte coordenadas a píxeles Web Mercator.
function lonToWorldX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z) * 256;
}
function latToWorldY(lat, z) {
  const r = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z) * 256;
}

function getMapTiles(lat, lon, width, height) {
  const worldX = lonToWorldX(lon, TILE_ZOOM);
  const worldY = latToWorldY(lat, TILE_ZOOM);
  const originX = worldX - width / 2;
  const originY = worldY - height / 2;
  const tiles = [];
  const maxTile = Math.pow(2, TILE_ZOOM);

  for (let y = Math.floor(originY / 256); y < Math.ceil((originY + height) / 256); y++) {
    for (let tileX = Math.floor(originX / 256); tileX < Math.ceil((originX + width) / 256); tileX++) {
      const x = ((tileX % maxTile) + maxTile) % maxTile;
      if (y < 0 || y >= maxTile) continue;
      const url = `${TILE_HOST}/${TILE_ZOOM}/${x}/${y}.png`;
      tiles.push({
        url,
        left: Math.round(tileX * 256 - originX),
        top: Math.round(y * 256 - originY),
      });
    }
  }
  return tiles;
}

// Distingue territorios con bandera propia.
function getFlagCode(data) {
  const code = (data.country_code || '').toUpperCase();
  if (code === 'CN') {
    const place = [data.country, data.region, data.city].filter(Boolean).join(' ');
    if (/Hong\s*Kong/i.test(place)) return 'hk';
    if (/Macau|Macao/i.test(place)) return 'mo';
    if (/Taiwan/i.test(place)) return 'tw';
  }
  return /^[A-Z]{2}$/.test(code) ? code.toLowerCase() : '';
}

let _regionNames;
function localizeCountry(countryCode) {
  const cc = (countryCode || '').toUpperCase();
  if (!cc) return '';
  if (_regionNames === undefined) {
    try {
      _regionNames = new Intl.DisplayNames([LOCALE, 'en'], { type: 'region' });
    } catch {
      _regionNames = null;
    }
  }
  if (_regionNames) {
    try {
      const name = _regionNames.of(cc);
      if (name && name.toUpperCase() !== cc) return name;
    } catch {}
  }
  return '';
}

function getDisplayName(data, flagCode) {
  const shortName = REGION_SHORT_NAMES[LOCALE]?.[flagCode] || REGION_SHORT_NAMES.en[flagCode];
  if (shortName) return shortName;
  return localizeCountry(data.country_code) || data.country || data.country_code || '--';
}

function setFlagImage(flagCode) {
  const img = $('flag-img');
  if (!img) return;
  // El nombre del país ya acompaña la bandera.
  img.alt = '';

  if (!flagCode) {
    img.onerror = null;
    img.removeAttribute('src');
    img.style.display = 'none';
    return;
  }

  const localSrc = chrome.runtime.getURL(`assets/flags/4x3/${flagCode}.svg`);
  img.onerror = () => {
    img.onerror = null;
    img.removeAttribute('src');
    img.style.display = 'none';
  };
  img.style.display = 'block';
  img.src = localSrc;
}

function setWhoisLink(id, value) {
  const el = $(id);
  if (!el) return;
  const text = value || '--';
  el.textContent = text;
  if (value) {
    el.href = `https://who.ga/whois/${encodeURIComponent(value)}`;
    el.classList.remove('disabled');
  } else {
    el.removeAttribute('href');
    el.classList.add('disabled');
  }
}

function formatDateTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(localeTag(), { dateStyle: 'medium' });
}

function formatTimeZone(tz) {
  if (!tz) return '--';
  try {
    const parts = new Intl.DateTimeFormat(localeTag(), {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const offset = parts.find((p) => p.type === 'timeZoneName')?.value;
    return offset ? `${tz} (${offset})` : tz;
  } catch {
    return tz;
  }
}

function renderIpSource(hostname) {
  const el = $('ip-source');
  if (!el) return;
  const literalIp = isIpAddress(hostname);
  el.textContent = t(literalIp ? 'sourceIp' : 'sourceDns');
  el.title = t(literalIp ? 'sourceIpTitle' : 'sourceDnsTitle');
  el.setAttribute('aria-label', el.title);
}

function getSslClass(daysLeft, expired) {
  if (!Number.isFinite(daysLeft) || expired) return 'muted';
  if (daysLeft < 7) return 'danger';
  if (daysLeft < 30) return 'warning';
  return '';
}

function getSslText(data) {
  const daysLeft = getSslDays(data);
  if (isSslExpired(data)) return t('sslExpired');
  if (!Number.isFinite(daysLeft)) return t('sslUnknown');
  return t('sslDaysLeft').replace('{days}', String(daysLeft));
}

function isSslExpired(data) {
  const expiry = Date.parse(data?.expires_at);
  return data?.expired === true || (Number.isFinite(expiry) && expiry <= Date.now());
}

function getSslDays(data) {
  const expiry = Date.parse(data?.expires_at);
  return Number.isFinite(expiry) ? Math.ceil((expiry - Date.now()) / (24 * 60 * 60 * 1000)) : NaN;
}

function renderSsl(data) {
  lastSslData = data;
  setPanelAvailable('ssl', Boolean(data));
  const el = $('ssl-toggle');
  if (!el) return;
  const daysLeft = getSslDays(data);
  el.textContent = data ? getSslText(data) : t('sslUnknown');
  el.className = `value-main ssl-value ${getSslClass(daysLeft, isSslExpired(data))}`.trim();
  const expiresAt = data?.expires_at;
  if (expiresAt) {
    const issuer = data.issuer ? ` · ${data.issuer}` : '';
    el.title = `${expiresAt}${issuer}`;
  } else {
    el.removeAttribute('title');
  }
  setText('ssl-issuer', data?.issuer || '--');
  setText('ssl-valid-to', formatDateTime(expiresAt));
  setText('ssl-host', data?.host || '--');
}

async function loadSslInfo(hostname) {
  try {
    renderSsl(await cachedLookup(`ssl_${hostname}`, SSL_CACHE_TTL, () => fetchSslJson(hostname)));
  } catch {
    renderSsl(null);
  }
}

async function loadWhoisInfo(hostname) {
  try {
    renderWhois(await cachedLookup(`whois_${hostname}`, WHOIS_CACHE_TTL, () => fetchWhoisJson(hostname)));
  } catch {
    renderWhois(null);
  }
}

function renderWhois(data) {
  lastWhoisData = data;
  setPanelAvailable('whois', Boolean(data));
  const button = $('whois-toggle');
  if (!button) return;
  
  if (!data) {
    button.textContent = '--';
    button.classList.add('muted');
    setText('whois-registrar', '--');
    setText('whois-created', '--');
    setText('whois-expires', '--');
    return;
  }
  
  button.textContent = data.registrar || t('whoisUnknown');
  button.classList.remove('muted');
  
  setText('whois-registrar', data.registrar || '--');
  setText('whois-created', data.created ? formatDateTime(data.created) : '--');
  setText('whois-expires', data.expires ? formatDateTime(data.expires) : '--');
}

function hideMapContextMenu() {
  const menu = $('map-context-menu');
  if (menu) menu.hidden = true;
}

function showMapContextMenu(event) {
  if (!currentMapCoords) return;
  event.preventDefault();
  event.stopPropagation();

  const menu = $('map-context-menu');
  if (!menu) return;
  const menuWidth = 132;
  const menuHeight = 36;
  const left = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
  const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.hidden = false;
}

async function openCurrentCoordsInMaps() {
  if (!currentMapCoords) return;
  const { lat, lon } = currentMapCoords;
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`;
  try {
    await chrome.tabs.create({ url });
    window.close();
  } catch {}
}

function bindMapContextMenu() {
  const map = $('map-container');
  const open = $('map-open');
  if (map) {
    map.addEventListener('contextmenu', showMapContextMenu);
  }
  if (open) {
    open.addEventListener('click', openCurrentCoordsInMaps);
  }
  $('map-open-direct').addEventListener('click', openCurrentCoordsInMaps);
  document.addEventListener('click', hideMapContextMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMapContextMenu();
  });
}

function setPanelExpanded(kind, expanded) {
  $(`${kind}-details`).hidden = !expanded;
  const arrow = document.querySelector(`[data-expand="${kind}-details"]`);
  arrow.classList.toggle('expanded', expanded);
  arrow.setAttribute('aria-expanded', String(expanded));
  $(`${kind}-toggle`).setAttribute('aria-expanded', String(expanded));
}

function setPanelAvailable(kind, available) {
  $(`${kind}-toggle`).disabled = !available;
  document.querySelector(`[data-expand="${kind}-details"]`).disabled = !available;
  if (!available) setPanelExpanded(kind, false);
}

function bindActions() {
  for (const kind of ['ssl', 'whois']) {
    const toggle = () => {
      if (kind === 'ssl' ? !lastSslData : !lastWhoisData) return;
      setPanelExpanded(kind, $(`${kind}-details`).hidden);
    };
    $(`${kind}-toggle`).addEventListener('click', toggle);
    document.querySelector(`[data-expand="${kind}-details"]`).addEventListener('click', toggle);
  }
}

function renderMap(data) {
  clearTimeout(mapLoadTimer);
  const lat = typeof data.latitude === 'number' ? data.latitude : NaN;
  const lon = typeof data.longitude === 'number' ? data.longitude : NaN;
  // 0 también es una coordenada válida.
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    currentMapCoords = null;
    $('map-container').style.display = 'none';
    $('map-open-direct').hidden = true;
    hideMapContextMenu();
    return;
  }

  currentMapCoords = { lat, lon };
  $('map-open-direct').hidden = false;
  $('map-container').style.display = 'block';
  $('map-loading').style.display = 'flex';
  $('map-grid').replaceChildren();
  $('map-loading').replaceChildren(Object.assign(document.createElement('div'), { className: 'spinner' }));

  const mapGrid = $('map-grid');
  const tiles = getMapTiles(lat, lon, $('map-container').clientWidth || 320, $('map-container').clientHeight || 130);
  let loaded = 0;
  let succeeded = 0;
  const finish = () => {
    clearTimeout(mapLoadTimer);
    if (succeeded) $('map-loading').style.display = 'none';
    else $('map-loading').textContent = t('mapUnavailable');
  };
  mapLoadTimer = setTimeout(finish, FETCH_TIMEOUT_MS);
  if (!tiles.length) finish();
  tiles.forEach((tile) => {
    const img = new Image();
    img.className = 'map-tile';
    img.alt = '';
    img.draggable = false;
    img.referrerPolicy = 'strict-origin-when-cross-origin';
    img.style.left = `${tile.left}px`;
    img.style.top = `${tile.top}px`;
    const settled = (success) => {
      if (success) succeeded++;
      loaded++;
      if (loaded === tiles.length) finish();
    };
    img.onload = () => settled(true);
    img.onerror = () => settled(false);
    img.src = tile.url;
    mapGrid.appendChild(img);
  });
}

function resetDetailPanels() {
  for (const kind of ['ssl', 'whois']) setPanelExpanded(kind, false);
}

function render(data, hostname) {
  $('loading').style.display = 'none';
  $('content').style.display = 'block';
  resetDetailPanels();

  const flagCode = getFlagCode(data);
  setFlagImage(flagCode);
  setText('country', getDisplayName(data, flagCode));
  setText('city-region', [data.city, data.region].filter(Boolean).join(t('locationSeparator')) || '--');

  renderMap(data);

  const asn = extractAsn(data.asn);
  setWhoisLink('ip', data.ip);
  setWhoisLink('domain', hostname);
  setWhoisLink('asn', asn === '--' ? '' : asn);
  setText('isp', data.isp || '--');
  setText('timezone', formatTimeZone(data.timezone));
  renderIpSource(hostname);
}

function showError(msg) {
  $('loading').style.display = 'none';
  $('content').style.display = 'none';
  $('error').style.display = 'block';
  setText('error-msg', msg);
}

function bindRetry() {
  $('error-retry').addEventListener('click', init);
}

async function init() {
  if (initializing) return;
  initializing = true;
  $('error-retry').disabled = true;
  $('error').style.display = 'none';
  $('content').style.display = 'none';
  $('loading').style.display = 'flex';
  renderSsl(null);
  renderWhois(null);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || isSpecialPage(tab.url)) { showError(t('unsupportedPage')); return; }

    const hostname = new URL(tab.url).hostname.replace(/^\[|\]$/g, '');
    await pruneCache();

    const ip = isIpAddress(hostname) ? hostname : await resolveHostIp(hostname);
    if (!ip) { showError(t('resolveFailed')); return; }

    // La caché por IP se comparte entre dominios.
    const data = await cachedLookup(`geo_${ip}`, CACHE_TTL, async () => {
      const raw = await fetchGeoJson(ip);
      return raw ? normalizeData(raw, ip) : null;
    });
    if (!data) throw new Error('API error');
    render(data, hostname);
    // Consultar detalles solo cuando la ubicación principal se ha podido mostrar.
    loadSslInfo(hostname);
    loadWhoisInfo(hostname);
  } catch {
    showError(t('fetchFailed'));
  } finally {
    initializing = false;
    $('error-retry').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyStaticI18n();
  bindRetry();
  bindMapContextMenu();
  bindActions();
  init();
});
