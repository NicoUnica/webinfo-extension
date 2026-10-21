/* Consultas de red y caché compartidas por la ventana y las pruebas de regresión. */
(function (raiz) {
  'use strict';
  const DURACIONES_CACHE = { dns: 600000, ubicacion: 600000, ssl: 21600000, whois: 86400000 };
  const ESPERA_MAXIMA_MS = 8000;
  const texto = valor => typeof valor === 'string' ? valor.trim() : '';

  function esIPv4(ip) {
    return typeof ip === 'string' && ip.split('.').length === 4
      && ip.split('.').every(parte => /^(0|[1-9]\d{0,2})$/.test(parte) && +parte <= 255);
  }
  function esIPv6(ip) {
    if (typeof ip !== 'string' || !ip.includes(':') || !/^[\da-f:.]+$/i.test(ip)) return false;
    try { return new URL(`http://[${ip}]/`).hostname.startsWith('['); } catch { return false; }
  }
  const esDireccionIp = ip => esIPv4(ip) || esIPv6(ip);

  function esIpPublica(ip) {
    if (esIPv4(ip)) {
      const [a, b, c] = ip.split('.').map(Number);
      return !(a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
        || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
        || (a === 203 && b === 0 && c === 113));
    }
    if (!esIPv6(ip)) return false;
    const canonica = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    // Comprueba las IPv4 representadas como IPv6, incluida su notación hexadecimal.
    if (canonica.startsWith('::ffff:')) {
      const partes = canonica.slice(7).split(':').map(parte => parseInt(parte, 16));
      return partes.length === 2 && esIpPublica(`${partes[0] >> 8}.${partes[0] & 255}.${partes[1] >> 8}.${partes[1] & 255}`);
    }
    // Admite direcciones globales y excluye los bloques de documentación, transición y reserva.
    const primero = parseInt(canonica.split(':')[0], 16);
    return primero >= 0x2000 && primero <= 0x3fff
      && !canonica.startsWith('2001::') && !/^2001:(?:db8|0|[12][0-9a-f]?):/i.test(canonica)
      && !/^2002:/i.test(canonica) && !/^3fff:/i.test(canonica);
  }

  function esServidorLocal(nombreHost) {
    const servidor = nombreHost.toLowerCase().replace(/\.$/, '');
    if (esDireccionIp(servidor)) return !esIpPublica(servidor);
    return !servidor.includes('.') || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|test|example|invalid|onion|alt)$/.test(servidor)
      || /(?:^|\.)home\.arpa$/.test(servidor) || /(?:^|\.)in-addr\.arpa$/.test(servidor) || /(?:^|\.)ip6\.arpa$/.test(servidor);
  }

  function destinoDesdeUrl(valor) {
    const url = new URL(valor);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error("paginaNoCompatible");
    const nombreHost = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    return { hostname: nombreHost, local: esServidorLocal(nombreHost), sslApplicable: url.protocol === 'https:' && !url.port };
  }

  function registroDns(respuestaOriginal, tipoRespuesta, nombreHost) {
    if (respuestaOriginal?.Status !== 0 || !Array.isArray(respuestaOriginal.Answer)) return null;
    const valido = tipoRespuesta === 1 ? esIPv4 : esIPv6;
    const nombre = valor => texto(valor).toLowerCase().replace(/\.$/, '');
    let propietario = nombre(nombreHost), duracionCache = DURACIONES_CACHE.dns;
    const visitados = new Set();
    for (let paso = 0; paso < 16; paso++) {
      if (visitados.has(propietario)) return null;
      visitados.add(propietario);
      const coincidencias = respuestaOriginal.Answer.filter(registro => registro && nombre(registro.name) === propietario);
      const registros = coincidencias.filter(registro => registro.type === tipoRespuesta && valido(registro.data));
      const duracion = registro => Number.isFinite(registro.TTL) ? Math.max(0, registro.TTL * 1000) : 60000;
      if (registros.length) return {
        ips: [...new Set(registros.map(registro => registro.data))],
        ttl: Math.min(duracionCache, ...registros.map(duracion)),
      };
      const alias = coincidencias.find(registro => registro.type === 5 && texto(registro.data));
      if (!alias) return null;
      duracionCache = Math.min(duracionCache, duracion(alias));
      propietario = nombre(alias.data);
    }
    return null;
  }

  function normalizarSsl(respuestaOriginal) {
    const datos = respuestaOriginal?.data;
    if (respuestaOriginal?.ok === false || datos?.ok === false || !datos || typeof datos !== 'object') return null;
    const emisor = texto(datos.issuer) || texto(datos.issuer?.CN) || texto(datos.issuer?.O);
    const servidor = texto(datos.cn) || texto(datos.host) || texto(datos.subject?.CN);
    const caducaEn = texto(datos.valid_to);
    if (!emisor && !servidor && !Number.isFinite(Date.parse(caducaEn))) return null;
    return { issuer: emisor, host: servidor, expires_at: caducaEn, expired: datos.expired === true };
  }
  function normalizarWhois(respuestaOriginal) {
    if (!respuestaOriginal || typeof respuestaOriginal !== 'object' || respuestaOriginal.error) return null;
    const datos = { registrar: texto(respuestaOriginal.registrar?.name), created: texto(respuestaOriginal.dates?.created), expires: texto(respuestaOriginal.dates?.expires) };
    return Object.values(datos).some(Boolean) ? datos : null;
  }

  function estadoSsl(datos, ahora = Date.now()) {
    const vencimiento = Date.parse(datos?.expires_at);
    const dias = Math.ceil((vencimiento - ahora) / 86400000);
    const caducado = datos?.expired === true || (Number.isFinite(vencimiento) && vencimiento <= ahora);
    return { days: dias, expired: caducado, className: caducado ? "peligro" : !Number.isFinite(dias) ? "atenuado" : dias < 7 ? "peligro" : dias < 30 ? "advertencia" : '' };
  }

  function crearCliente({ storage: almacenamiento, fetcher: solicitar = globalThis.fetch, now: ahora = Date.now, timeout: esperaMaxima = ESPERA_MAXIMA_MS } = {}) {
    const pendientes = new Map();
    const pausas = new Map();
    async function leer(clave) { try { return (await almacenamiento.get(clave))[clave]; } catch { return undefined; } }
    async function guardar(clave, valor) { try { await almacenamiento.set({ [clave]: valor }); } catch {} }
    async function consultarJson(url, servicio) {
      const clavePausa = `cooldown_${servicio}`;
      if (pausas.get(servicio) > ahora() || (await leer(clavePausa))?.until > ahora()) throw new Error("limiteAlcanzado");
      const controlador = new AbortController();
      const temporizador = setTimeout(() => controlador.abort(), esperaMaxima);
      try {
        const respuesta = await solicitar(url, { signal: controlador.signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers: servicio === 'dns' ? { Accept: 'application/dns-json' } : {} });
        if (respuesta.status === 429) {
          const reintento = respuesta.headers?.get('Retry-After');
          const segundos = Number(reintento);
          const hasta = reintento && Number.isFinite(segundos) ? ahora() + Math.max(1, segundos) * 1000 : Date.parse(reintento);
          const reanudarEn = Number.isFinite(hasta) && hasta > ahora() ? hasta : ahora() + 60000;
          pausas.set(servicio, reanudarEn);
          await guardar(clavePausa, { until: reanudarEn });
          throw new Error("limiteAlcanzado");
        }
        if (!respuesta.ok) throw new Error("errorServicio");
        return await respuesta.json();
      } catch (error) {
        if (error.name === 'AbortError') throw new Error("tiempoAgotado");
        if (["limiteAlcanzado", "errorServicio"].includes(error.message)) throw error;
        throw new Error("errorRed");
      } finally { clearTimeout(temporizador); }
    }
    async function consultarConCache(clave, duracionCache, cargar, forzar = false) {
      if (pendientes.has(clave)) return pendientes.get(clave);
      const trabajo = (async () => {
        const entrada = await leer(clave);
        if (!forzar && entrada?.expiresAt > ahora()) {
          await guardar(clave, { ...entrada, accessedAt: ahora() });
          return { data: entrada.data, checkedAt: entrada.checkedAt };
        }
        if (entrada) { try { await almacenamiento.remove(clave); } catch {} }
        const datos = await cargar();
        const anotarConsulta = ahora();
        if (datos) {
          const duracion = typeof duracionCache === 'function' ? duracionCache(datos) : duracionCache;
          if (duracion > 0) await guardar(clave, { data: datos, checkedAt: anotarConsulta, accessedAt: anotarConsulta, expiresAt: anotarConsulta + duracion });
        }
        return { data: datos, checkedAt: anotarConsulta };
      })();
      pendientes.set(clave, trabajo);
      try { return await trabajo; } finally { pendientes.delete(clave); }
    }
    async function limpiarCache() {
      try {
        const todo = await almacenamiento.get(null);
        const entradas = Object.entries(todo).filter(([clave]) => /^(dns|ip|geo|ssl|whois|cooldown)_/.test(clave));
        const vigentes = entradas.filter(([clave, valor]) => clave.startsWith('cooldown_') ? valor?.until > ahora() : valor?.expiresAt > ahora());
        const pausas = vigentes.filter(([clave]) => clave.startsWith('cooldown_'));
        const resultados = vigentes.filter(([clave]) => !clave.startsWith('cooldown_'))
          .sort((a, b) => (b[1].accessedAt || b[1].checkedAt || 0) - (a[1].accessedAt || a[1].checkedAt || 0));
        const conservar = new Set([...pausas, ...resultados.slice(0, Math.max(0, 300 - pausas.length))].map(([clave]) => clave));
        const eliminar = entradas.filter(([clave]) => !conservar.has(clave)).map(([clave]) => clave);
        if (eliminar.length) await almacenamiento.remove(eliminar);
      } catch {}
    }
    async function resolver(nombreHost, forzar = false) {
      if (esServidorLocal(nombreHost)) throw new Error("redLocal");
      return consultarConCache(`dns_${nombreHost}`, datos => datos.ttl, async () => {
        const registros = await Promise.allSettled([['A', 1], ['AAAA', 28]].map(async ([tipo, numero]) => {
          const respuestaOriginal = await consultarJson(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(nombreHost)}&type=${tipo}`, 'dns');
          return registroDns(respuestaOriginal, numero, nombreHost);
        }));
        const disponibles = registros.filter(registro => registro.status === 'fulfilled' && registro.value).map(registro => registro.value);
        if (!disponibles.length) {
          const fallo = registros.find(registro => registro.status === 'rejected');
          if (fallo) throw fallo.reason;
          return null;
        }
        // Si falla una familia de direcciones, no se guarda una respuesta DNS incompleta.
        return { ips: [...new Set(disponibles.flatMap(registro => registro.ips))], ttl: registros.some(registro => registro.status === 'rejected') ? 0 : Math.min(...disponibles.map(registro => registro.ttl)) };
      }, forzar);
    }
    async function ubicacion(ip, forzar = false) {
      if (!esIpPublica(ip)) throw new Error("redLocal");
      return consultarConCache(`geo_${ip}`, DURACIONES_CACHE.ubicacion, async () => {
        const respuestaOriginal = await consultarJson(`https://ipwho.is/${encodeURIComponent(ip)}?lang=es`, 'geo');
        if (respuestaOriginal?.success !== true || respuestaOriginal.ip !== ip && (!esIPv6(ip) || !esIPv6(respuestaOriginal.ip) || new URL(`http://[${ip}]/`).hostname !== new URL(`http://[${respuestaOriginal.ip}]/`).hostname)) return null;
        return { ip, country: texto(respuestaOriginal.country), country_code: texto(respuestaOriginal.country_code), city: texto(respuestaOriginal.city), region: texto(respuestaOriginal.region), latitude: respuestaOriginal.latitude, longitude: respuestaOriginal.longitude, timezone: texto(respuestaOriginal.timezone?.id), isp: texto(respuestaOriginal.connection?.isp), asn: /^\d+$/.test(String(respuestaOriginal.connection?.asn)) ? `AS${respuestaOriginal.connection.asn}` : texto(respuestaOriginal.connection?.asn) };
      }, forzar);
    }
    async function ssl(nombreHost, forzar = false) {
      if (esServidorLocal(nombreHost)) throw new Error("redLocal");
      return consultarConCache(`ssl_${nombreHost}`, DURACIONES_CACHE.ssl, async () => normalizarSsl(await consultarJson(`https://host.tools/api/v1/ssl/cert?q=${encodeURIComponent(nombreHost)}`, 'ssl')), forzar);
    }
    async function whois(nombreHost, forzar = false) {
      if (esDireccionIp(nombreHost) || esServidorLocal(nombreHost)) return { data: null };
      // El proveedor normaliza los subdominios y los nombres internacionales con la lista de sufijos públicos.
      return consultarConCache(`whois_${nombreHost}`, DURACIONES_CACHE.whois, async () => normalizarWhois(await consultarJson(`https://who-dat.as93.net/${encodeURIComponent(nombreHost)}`, 'whois')), forzar);
    }
    return { resolver, ubicacion, ssl, whois, limpiarCache };
  }
  const api = { esIPv4, esIPv6, esDireccionIp, esIpPublica, esServidorLocal, destinoDesdeUrl, registroDns, normalizarSsl, normalizarWhois, estadoSsl, crearCliente };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.WebInfo = api;
})(globalThis);
