const $ = (id) => document.getElementById(id);
const CACHE_TTL = 10 * 60 * 1000;
const SSL_CACHE_TTL = 6 * 60 * 60 * 1000;
const WHOIS_CACHE_TTL = 24 * 60 * 60 * 1000;
const TILE_HOST = 'https://{s}.basemaps.cartocdn.com';
const TILE_ZOOM = 4; // Vista a nivel nacional, 2x2 tiles acercados a zoom 5 nivel ciudad
const FLAG_STYLE_KEY = 'flagStyle';
const DEFAULT_FLAG_STYLE = 'rect';

// Nombres cortos para las regiones que Intl.DisplayNames devuelve de forma verbosa
// (p. ej. "RAE de Hong Kong (China)"). El resto de países se traducen con Intl.DisplayNames.
const REGION_SHORT_NAMES = {
  es: { hk: 'Hong Kong', mo: 'Macau', tw: 'Taiwán' },
  en: { hk: 'Hong Kong', mo: 'Macau', tw: 'Taiwan' },
};

const I18N = {
  en: {
    retry: 'Retry',
    domain: 'Domain',
    timezone: 'Time zone',
    openInMaps: 'Open in Maps',

    unsupportedPage: 'This page cannot be checked',
    resolveFailed: 'Unable to resolve server IP. Check your network and try again.',
    fetchFailed: 'Unable to fetch IP information',
    sslDaysLeft: 'Expires in {days}d',
    sslExpired: 'Expired',
    sslUnknown: 'Unavailable',
    sslIssuer: 'Issuer',
    sslValidTo: 'Valid to',
    sslHost: 'Host',
    sourceDns: 'DNS',
    locationSeparator: ', ',
    whoisRegistrar: 'Registrar',
    whoisCreated: 'Created',
    whoisExpires: 'Expires',
  },
  es: {
    retry: 'Reintentar',
    domain: 'Dominio',
    timezone: 'Zona horaria',
    openInMaps: 'Abrir en mapas',

    unsupportedPage: 'Esta página no puede ser verificada',
    resolveFailed: 'No se pudo resolver la IP del servidor. Verifica tu red e intenta de nuevo.',
    fetchFailed: 'No se pudo obtener información de la IP',
    sslDaysLeft: 'Expira en {days}d',
    sslExpired: 'Expirado',
    sslUnknown: 'No disponible',
    sslIssuer: 'Emisor',
    sslValidTo: 'Válido hasta',
    sslHost: 'Dominio',
    sourceDns: 'DNS',
    locationSeparator: ', ',
    whoisRegistrar: 'Registrador',
    whoisCreated: 'Creado',
    whoisExpires: 'Expira',
  },
};

// Idioma del popup: usamos el mismo idioma que la interfaz de la extensión (el nombre y la
// descripción del manifest vienen de _locales según el idioma del navegador). Así TODO el popup
// queda en un único idioma —inglés o español— elegido por el navegador del usuario, sin mezclas.
function detectLocale() {
  let lang = '';
  try { lang = chrome.i18n.getUILanguage() || ''; } catch { /* chrome.i18n no disponible */ }
  if (!lang) lang = navigator.language || '';
  return /^es/i.test(lang) ? 'es' : 'en';
}
const LOCALE = detectLocale();
let currentMapCoords = null;
let lastRenderData = null;
let lastSslData = null;

function t(key) {
  return I18N[LOCALE][key] || I18N.en[key] || key;
}

// Localizar las etiquetas estáticas marcadas con data-i18n según el idioma del navegador.
function applyStaticI18n() {
  document.documentElement.lang = LOCALE;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const value = I18N[LOCALE][el.dataset.i18n] || I18N.en[el.dataset.i18n];
    if (value) el.textContent = value;
  });
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}





function isSpecialPage(url) {
  return !url || /^(chrome|chrome-extension|edge|about|file|devtools|browser):/.test(url);
}

// Normalizar campos de la API ipwho.is al schema interno del popup.
function normalizeData(raw, ip) {
  const asn = raw.connection?.asn ? String(raw.connection.asn) : '';
  return {
    ip: raw.ip || ip,
    country: raw.country,
    country_code: raw.country_code,
    city: raw.city,
    region: raw.region,
    province: raw.region,
    latitude: raw.latitude,
    longitude: raw.longitude,
    timezone: raw.timezone?.id,
    isp: raw.connection?.isp,
    asn: asn ? (asn.toUpperCase().startsWith('AS') ? asn.toUpperCase() : `AS${asn}`) : undefined,
    ssl: raw.ssl || null,
    whois: raw.whois || null,
  };
}

async function fetchGeoJson(ip) {
  const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
  if (!res.ok) return null;
  const raw = await res.json();
  return raw.success ? raw : null;
}

async function fetchDomainJson(hostname) {
  // ipwho.is no soporta dominios, siempre resolvemos DNS primero
  const ip = await resolveIpDoH(hostname);
  if (!ip) return null;
  return await fetchGeoJson(ip);
}

async function fetchSslJson(hostname) {
  const res = await fetch(`https://host.tools/api/v1/ssl/cert?q=${encodeURIComponent(hostname)}`);
  if (!res.ok) return null;
  const raw = await res.json();
  if (!raw?.data || typeof raw.data !== 'object') return null;
  const data = raw.data;
  return {
    issuer: data.issuer,
    host: data.cn || data.host,
    expires_at: data.valid_to,
    days_remaining: data.days_left,
    valid: !data.expired,
    status: data.expired ? 'expired' : 'ok'
  };
}

async function fetchWhoisJson(hostname) {
  const res = await fetch(`https://who-dat.as93.net/${encodeURIComponent(hostname)}`);
  if (!res.ok) return null;
  const raw = await res.json();
  if (!raw || typeof raw !== 'object') return null;
  return {
    registrar: raw.registrar?.name,
    created: raw.dates?.created,
    updated: raw.dates?.updated,
    expires: raw.dates?.expires,
    nameservers: raw.nameservers?.map(ns => ns.name) || [],
    status: raw.status || []
  };
}

async function fetchSslInfo(hostname) {
  const key = `ssl_${hostname}`;
  const store = await chrome.storage.session.get(key);
  if (store[key] && Date.now() - store[key].ts < SSL_CACHE_TTL) {
    return store[key].data;
  }

  const data = await fetchSslJson(hostname);
  if (data) {
    await chrome.storage.session.set({ [key]: { data, ts: Date.now() } });
  }
  return data;
}

async function fetchWhoisInfo(hostname) {
  const key = `whois_${hostname}`;
  const store = await chrome.storage.session.get(key);
  if (store[key] && Date.now() - store[key].ts < WHOIS_CACHE_TTL) {
    return store[key].data;
  }

  const data = await fetchWhoisJson(hostname);
  if (data) {
    await chrome.storage.session.set({ [key]: { data, ts: Date.now() } });
  }
  return data;
}

// Extraer número ASN del campo ASN
// "AS37963 Hangzhou Alibaba Advertising Co.,Ltd." → "AS37963"
// "AS15169" → "AS15169"
function extractAsn(asString) {
  if (!asString) return '--';
  const m = asString.match(/^(AS\s*\d+)/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, '') : asString;
}

function isIPv4(ip) {
  return typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

// Usar Cloudflare DoH público para resolver hostname → IPv4 (solo registros A)
async function resolveIpDoH(hostname) {
  try {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { 'Accept': 'application/dns-json' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const a = data.Answer?.find(x => x.type === 1);
    return a?.data || null;
  } catch {
    return null;
  }
}

// Resolver hostname → IPv4 vía DNS-over-HTTPS. El resultado se cachea en la sesión para
// evitar repetir la consulta DoH al reabrir el popup en el mismo host.
async function resolveHostIp(hostname) {
  const key = `ip_${hostname}`;
  const cached = (await chrome.storage.session.get(key))[key];
  if (cached && isIPv4(cached)) return cached;

  const v4 = await resolveIpDoH(hostname);
  if (v4) {
    await chrome.storage.session.set({ [key]: v4 });
    return v4;
  }
  return null;
}

function lonToWorldX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z) * 256;
}
function latToWorldY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z) * 256;
}

// El tile style sigue el esquema de color del sistema para que el mapa combine con el tema del popup.
function getMapStyle() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark_all' : 'light_all';
}

function getMapTiles(lat, lon, width, height) {
  const style = getMapStyle();
  const worldX = lonToWorldX(lon, TILE_ZOOM);
  const worldY = latToWorldY(lat, TILE_ZOOM);
  const centerTileX = Math.floor(worldX / 256);
  const centerTileY = Math.floor(worldY / 256);
  const startX = centerTileX - 1;
  const startY = centerTileY - 1;
  const offsetX = Math.round(width / 2 - (worldX - startX * 256));
  const offsetY = Math.round(height / 2 - (worldY - startY * 256));
  const tiles = [];
  const maxTile = Math.pow(2, TILE_ZOOM);
  const subdomains = ['a', 'b', 'c', 'd'];

  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const x = (startX + dx + maxTile) % maxTile;
      const y = startY + dy;
      if (y < 0 || y >= maxTile) continue;
      const subdomain = subdomains[(dx + dy) % subdomains.length];
      const url = `${TILE_HOST.replace('{s}', subdomain)}/${style}/${TILE_ZOOM}/${x}/${y}.png`;
      tiles.push({
        url,
        left: offsetX + dx * 256,
        top: offsetY + dy * 256,
      });
    }
  }
  return tiles;
}

function getFlagCode(data) {
  const code = (data.country_code || '').toUpperCase();
  if (code === 'CN') {
    const place = [data.country, data.region, data.province, data.city].filter(Boolean).join(' ');
    if (/Hong\s*Kong/i.test(place)) return 'hk';
    if (/Macau|Macao/i.test(place)) return 'mo';
    if (/Taiwan/i.test(place)) return 'tw';
  }
  return code.toLowerCase();
}

function getFallbackFlagCode(hostname) {
  if (/^(www\.)?x\.com$/i.test(hostname || '')) return 'us';
  return '';
}

// Traducir códigos ISO de país (US, BR, IT, ...) al idioma activo con la API nativa del navegador,
// que cubre todos los países. Memoizado; si Intl.DisplayNames no existe, devuelve '' y se usa el fallback.
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
    } catch { /* código de región no válido */ }
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
  img.style.display = 'block';
  img.alt = flagCode ? flagCode.toUpperCase() : '';

  if (!flagCode) {
    img.onerror = null;
    img.src = chrome.runtime.getURL('../assets/icons/icon48.png');
    return;
  }

  const style = $('flag-img').dataset.style === 'square' ? 'square' : DEFAULT_FLAG_STYLE;
  const localSvgSrc = chrome.runtime.getURL(style === 'square' ? `../assets/flags/1x1/${flagCode}.png` : `../assets/flags/4x3/${flagCode}.svg`);
  img.onerror = () => {
    img.onerror = null;
    img.src = chrome.runtime.getURL('../assets/icons/icon48.png');
  };
  img.src = localSvgSrc;
}

function setFlagStyle(style) {
  const normalized = style === 'square' ? 'square' : DEFAULT_FLAG_STYLE;
  const flag = $('flag-img');
  if (flag) {
    flag.dataset.style = normalized;
    flag.classList.toggle('flag-square', normalized === 'square');
  }
  return normalized;
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
  return date.toLocaleDateString(LOCALE === 'es' ? 'es-ES' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function renderIpSource() {
  const el = $('ip-source');
  if (!el) return;
  el.textContent = t('sourceDns');
  el.title = 'DNS A';
}

function getSslClass(daysLeft, status) {
  if (!Number.isFinite(daysLeft) || status === 'error' || status === 'expired' || status === false) return 'muted';
  if (daysLeft < 7) return 'danger';
  if (daysLeft < 30) return 'warning';
  return '';
}

function getSslText(data) {
  const daysLeft = Number(data?.days_remaining ?? data?.days_left);
  if (!Number.isFinite(daysLeft)) return t('sslUnknown');
  if (daysLeft < 0 || data?.status === 'expired' || data?.valid === false) return t('sslExpired');
  return t('sslDaysLeft').replace('{days}', String(daysLeft));
}

function renderSsl(data) {
  lastSslData = data;
  const el = $('ssl-toggle');
  if (!el) return;
  const daysLeft = Number(data?.days_remaining ?? data?.days_left);
  el.textContent = data ? getSslText(data) : t('sslUnknown');
  el.className = `value-main ssl-value ${getSslClass(daysLeft, data?.status || (data?.valid === false ? 'expired' : 'ok'))}`.trim();
  const expiresAt = data?.expires_at || data?.valid_to;
  if (expiresAt) {
    const issuer = data.issuer ? ` · ${data.issuer}` : '';
    el.title = `${expiresAt}${issuer}`;
  } else {
    el.removeAttribute('title');
  }
  setText('ssl-issuer', data?.issuer || '--');
  setText('ssl-valid-to', formatDateTime(expiresAt));
  setText('ssl-host', data?.host || data?.subject || '--');
}

async function loadSslInfo(hostname, embeddedSsl) {
  renderSsl(embeddedSsl || null);
  if (embeddedSsl) return;
  try {
    renderSsl(await fetchSslInfo(hostname));
  } catch {
    renderSsl(null);
  }
}

async function loadWhoisInfo(hostname) {
  try {
    renderWhois(await fetchWhoisInfo(hostname));
  } catch {
    renderWhois(null);
  }
}

function renderWhois(data) {
  const button = $('whois-toggle');
  if (!button) return;
  
  if (!data || !data.registrar) {
    button.textContent = '--';
    button.classList.add('muted');
    setText('whois-registrar', '--');
    setText('whois-created', '--');
    setText('whois-expires', '--');
    return;
  }
  
  button.textContent = data.registrar || '--';
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

function openCurrentCoordsInMaps() {
  if (!currentMapCoords) return;
  const { lat, lon } = currentMapCoords;
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`;
  chrome.tabs.create({ url }).catch(() => {});
  window.close();
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
  document.addEventListener('click', hideMapContextMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMapContextMenu();
  });
}

function toggleSslDetails() {
  const details = $('ssl-details');
  const button = $('ssl-toggle');
  const expandBtn = document.querySelector('[data-expand="ssl-details"]');
  if (!details || !button || !lastSslData) return;
  const isHidden = details.hidden;
  details.hidden = !isHidden;
  button.setAttribute('aria-expanded', String(isHidden));
  if (expandBtn) {
    expandBtn.classList.toggle('expanded', !isHidden);
  }
}

function toggleWhoisDetails() {
  const details = $('whois-details');
  const button = $('whois-toggle');
  const expandBtn = document.querySelector('[data-expand="whois-details"]');
  if (!details || !button) return;
  const isHidden = details.hidden;
  details.hidden = !isHidden;
  button.setAttribute('aria-expanded', String(isHidden));
  if (expandBtn) {
    expandBtn.classList.toggle('expanded', !isHidden);
  }
}

function handleExpandButtonClick(button) {
  const targetId = button.dataset.expand;
  const details = $(targetId);
  if (details) {
    details.hidden = !details.hidden;
    button.classList.toggle('expanded', !details.hidden);
  }
}



function bindActions() {
  const sslToggle = $('ssl-toggle');
  if (sslToggle && !sslToggle._bound) {
    sslToggle.addEventListener('click', toggleSslDetails);
    sslToggle._bound = true;
  }

  const whoisToggle = $('whois-toggle');
  if (whoisToggle && !whoisToggle._bound) {
    whoisToggle.addEventListener('click', toggleWhoisDetails);
    whoisToggle._bound = true;
  }

  document.querySelectorAll('[data-expand]').forEach((button) => {
    if (button._bound) return;
    button.addEventListener('click', () => handleExpandButtonClick(button));
    button._bound = true;
  });
}

function renderMap(data) {
  const lat = parseFloat(data.latitude);
  const lon = parseFloat(data.longitude);
  // Number.isFinite descarta null/undefined/NaN sin tratar el 0 válido (Greenwich, ecuador) como ausente.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    currentMapCoords = null;
    $('map-container').style.display = 'none';
    hideMapContextMenu();
    return;
  }

  currentMapCoords = { lat, lon };
  $('map-container').style.display = 'block';
  $('map-loading').style.display = 'flex';
  $('map-grid').innerHTML = '';

  const mapGrid = $('map-grid');
  const tiles = getMapTiles(lat, lon, $('map-container').clientWidth || 320, $('map-container').clientHeight || 130);
  let loaded = 0;
  tiles.forEach((tile) => {
    const img = new Image();
    img.className = 'map-tile';
    img.draggable = false;
    img.style.left = `${tile.left}px`;
    img.style.top = `${tile.top}px`;
    img.onload = img.onerror = () => {
      loaded++;
      if (loaded === tiles.length) $('map-loading').style.display = 'none';
    };
    img.src = tile.url;
    mapGrid.appendChild(img);
  });
}

function resetDetailPanels() {
  const details = $('ssl-details');
  const sslToggle = $('ssl-toggle');
  if (details) details.hidden = true;
  if (sslToggle) sslToggle.setAttribute('aria-expanded', 'false');

  const whoisDetails = $('whois-details');
  const whoisToggle = $('whois-toggle');
  if (whoisDetails) whoisDetails.hidden = true;
  if (whoisToggle) whoisToggle.setAttribute('aria-expanded', 'false');
}

function render(data, hostname, flagStyle) {
  lastRenderData = data;
  $('loading').style.display = 'none';
  $('content').style.display = 'block';
  resetDetailPanels();

  const flagCode = getFlagCode(data) || getFallbackFlagCode(hostname);
  setFlagStyle(flagStyle);
  $('flag-img').dataset.flagCode = flagCode;
  setFlagImage(flagCode);
  setText('country', getDisplayName(data, flagCode));
  setText('city-region', [data.city, data.province].filter(Boolean).join(t('locationSeparator')) || '--');

  renderMap(data);

  const asn = extractAsn(data.asn);
  setWhoisLink('ip', data.ip);
  setWhoisLink('domain', hostname);
  setWhoisLink('asn', asn === '--' ? '' : asn);
  setText('isp', data.isp || '--');
  setText('timezone', data.timezone || '--');
  renderIpSource();
}

function showError(msg) {
  $('loading').style.display = 'none';
  $('error').style.display = 'block';
  setText('error-msg', msg);
}

function bindRetry() {
  const btn = $('error-retry');
  if (btn && !btn._bound) {
    btn.addEventListener('click', () => {
      $('error').style.display = 'none';
      $('loading').style.display = 'flex';
      init();
    });
    btn._bound = true;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || isSpecialPage(tab.url)) { showError(t('unsupportedPage')); return; }

  const hostname = new URL(tab.url).hostname;
  const settings = await chrome.storage.sync.get({ [FLAG_STYLE_KEY]: DEFAULT_FLAG_STYLE });
  const flagStyle = setFlagStyle(settings[FLAG_STYLE_KEY]);

  // SSL y WHOIS solo dependen del hostname: se lanzan ya, en paralelo con la resolución de
  // geolocalización, y cada uno se pinta al llegar (o queda en '--' si su servicio falla).
  resetDetailPanels();
  loadSslInfo(hostname);
  loadWhoisInfo(hostname);

  // Resolver la IPv4 del host vía DNS-over-HTTPS (con cache de sesión).
  const ip = await resolveHostIp(hostname);

  if (!ip) {
    // Si la resolución DoH falla, dejar que la API intente resolver por dominio directamente.
    try {
      const raw = await fetchDomainJson(hostname);
      if (!raw) throw new Error('domain lookup failed');
      const data = normalizeData(raw, raw.ip);

      // Cachear bajo la IP resuelta (misma clave que lee la ruta principal), no bajo el hostname.
      if (data.ip) {
        await chrome.storage.session.set({ [`geo_${data.ip}`]: { data, ts: Date.now() } });
      }
      render(data, hostname, flagStyle);
      return;
    } catch {
      showError(t('resolveFailed'));
      return;
    }
  }

  // Buscar cache geo (usando IP como key, reutilizable cuando múltiples dominios comparten IP CDN)
  const key = `geo_${ip}`;
  const store = await chrome.storage.session.get(key);
  if (store[key] && Date.now() - store[key].ts < CACHE_TTL) {
    render(store[key].data, hostname, flagStyle);
    return;
  }

  // Llamar a API de geolocalización
  try {
    const raw = await fetchGeoJson(ip);
    if (!raw) throw new Error('API error');
    const data = normalizeData(raw, ip);

    await chrome.storage.session.set({ [key]: { data, ts: Date.now() } });
    render(data, hostname, flagStyle);
  } catch {
    showError(t('fetchFailed'));
  }
}

function bindSystemThemeListener() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (lastRenderData) renderMap(lastRenderData);
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else mq.addListener(onChange);
}

document.addEventListener('DOMContentLoaded', () => {
  applyStaticI18n();
  bindRetry();
  bindMapContextMenu();
  bindActions();
  bindSystemThemeListener();
  init();
});
