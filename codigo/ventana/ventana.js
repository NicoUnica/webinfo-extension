'use strict';
const $ = id => document.getElementById(id);
const traducir = clave => chrome.i18n.getMessage(clave) || clave;
const IDIOMA = 'es';
const NOMBRES_CORTOS = { hk: 'Hong Kong', mo: 'Macau', tw: 'Taiwán' };
const SERVIDOR_MAPA = 'https://tile.openstreetmap.org';
const ZOOM_MAPA = 4;
const cliente = WebInfo.crearCliente({ storage: chrome.storage.session });
let destino, ipSeleccionada = '', coordenadasActuales, temporizadorMapa, generacionMapa = 0;
let enCurso = false, generacion = 0, generacionUbicacion = 0;
let actualizacionDisponibleEn = 0;

function ponerTexto(id, valor) {
  const elemento = $(id);
  elemento.textContent = valor || '--';
}
function aplicarTextos() {
  document.documentElement.lang = IDIOMA;
  document.querySelectorAll('[data-i18n]').forEach(elemento => { elemento.textContent = traducir(elemento.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach(elemento => { elemento.setAttribute('aria-label', traducir(elemento.dataset.i18nAria)); });
  document.querySelectorAll('[data-i18n-title]').forEach(elemento => { elemento.title = traducir(elemento.dataset.i18nTitle); });
}
function formatearFecha(valor) {
  const fecha = new Date(valor);
  return valor && Number.isFinite(fecha.getTime()) ? fecha.toLocaleDateString(IDIOMA, { dateStyle: 'medium' }) : '--';
}
function anotarConsulta(id, valor) {
  const etiqueta = valor ? traducir("fechaConsulta").replace("{hora}", new Date(valor).toLocaleString(IDIOMA, { dateStyle: 'short', timeStyle: 'short' })) : '';
  $(id).title = id === "ssl-alternar" ? [traducir("alcanceSsl"), etiqueta].filter(Boolean).join('\n') : etiqueta;
  if (id === "actualizar") {
    $(id).setAttribute('aria-label', etiqueta ? traducir("actualizar") + '. ' + etiqueta : traducir("actualizar"));
  }
}
function textoError(error) {
  const clave = ["limiteAlcanzado", "tiempoAgotado", "errorServicio", "redLocal"].includes(error?.message) ? error.message : "errorRed";
  return traducir(clave);
}
function ponerEnlaceWhois(id, valor, local = false) {
  const elemento = $(id);
  elemento.textContent = valor || '--';
  if (valor && !local) elemento.href = 'https://who.ga/whois/' + encodeURIComponent(valor);
  else elemento.removeAttribute('href');
  elemento.classList.toggle("deshabilitado", !valor || local);
}
function abrirPanel(tipoPanel, abierto) {
  if (abierto) {
    const otro = tipoPanel === 'ssl' ? 'whois' : 'ssl';
    $(otro + "-detalles").hidden = true;
    $(otro + "-alternar").setAttribute('aria-expanded', 'false');
  }
  $(tipoPanel + "-detalles").hidden = !abierto;
  $(tipoPanel + "-alternar").setAttribute('aria-expanded', String(abierto));
}
function estadoPanel(tipoPanel, mensaje, cargando = false) {
  const boton = $(tipoPanel + "-alternar");
  const valor = $(tipoPanel + "-valor");
  valor.textContent = mensaje;
  valor.className = "valor-panel atenuado";
  boton.setAttribute('aria-busy', String(cargando));
  boton.disabled = cargando;
  abrirPanel(tipoPanel, false);
  $(tipoPanel + "-mensaje").textContent = cargando ? traducir("datosCargando") : mensaje;
  $(tipoPanel + "-mensaje").hidden = false;
  $(tipoPanel + "-campos").hidden = true;
  anotarConsulta(tipoPanel + "-alternar", null);
  const aplicable = destino && !destino.local && (tipoPanel === 'ssl' ? destino.sslApplicable : !WebInfo.esDireccionIp(destino.hostname));
  $(tipoPanel + "-reintentar").hidden = cargando || !aplicable;
}
function mostrarPanel(tipoPanel, resultado) {
  const datos = resultado.data;
  if (!datos) { estadoPanel(tipoPanel, traducir("sinDatos")); return; }
  $(tipoPanel + "-alternar").disabled = false;
  $(tipoPanel + "-alternar").setAttribute('aria-busy', 'false');
  $(tipoPanel + "-mensaje").hidden = true;
  $(tipoPanel + "-campos").hidden = false;
  $(tipoPanel + "-reintentar").hidden = true;
  const valor = $(tipoPanel + "-valor");
  if (tipoPanel === 'ssl') {
    const estado = WebInfo.estadoSsl(datos);
    valor.textContent = estado.expired ? traducir("sslCaducado") : Number.isFinite(estado.days) ? traducir("diasSslRestantes").replace("{dias}", estado.days) : traducir("sslNoDisponible");
    valor.className = "valor-panel " + estado.className;
    ponerTexto("ssl-emisor", datos.issuer);
    ponerTexto("ssl-validez", formatearFecha(datos.expires_at));
    ponerTexto("ssl-dominio", datos.host);
  } else {
    valor.textContent = datos.registrar || traducir("whoisSinRegistrador");
    valor.className = "valor-panel";
    ponerTexto("whois-registrador", datos.registrar);
    ponerTexto("whois-creacion", formatearFecha(datos.created));
    ponerTexto("whois-caducidad", formatearFecha(datos.expires));
  }
  anotarConsulta(tipoPanel + "-alternar", resultado.checkedAt);
}
async function cargarPanel(tipoPanel, forzar = false) {
  const version = generacion;
  if (destino.local || tipoPanel === 'ssl' && !destino.sslApplicable || tipoPanel === 'whois' && WebInfo.esDireccionIp(destino.hostname)) {
    estadoPanel(tipoPanel, traducir("noAplicable")); return;
  }
  estadoPanel(tipoPanel, traducir("datosCargando"), true);
  try {
    const resultado = await cliente[tipoPanel](destino.hostname, forzar);
    if (version === generacion) mostrarPanel(tipoPanel, resultado);
  } catch (error) {
    if (version === generacion) estadoPanel(tipoPanel, textoError(error));
  }
}
function reiniciarUbicacion() {
  mostrarMapa({});
  mostrarBandera('');
  ponerTexto("pais", traducir("datosCargando"));
  ponerTexto("ciudad-region", traducir("ubicacionAproximada"));
  for (const id of ['isp', "zonaHoraria"]) ponerTexto(id, '--');
  ponerEnlaceWhois('asn', '');
  anotarConsulta("actualizar", null);
}
async function cargarUbicacion(ip, forzar = false) {
  const version = generacion, versionUbicacion = ++generacionUbicacion;
  ipSeleccionada = ip;
  const local = !WebInfo.esIpPublica(ip);
  ponerEnlaceWhois('ip', ip, local);
  reiniciarUbicacion();
  $("mensaje-ubicacion").hidden = true;
  $("reintentar-ubicacion").hidden = true;
  $("region-ubicacion").setAttribute('aria-busy', 'true');
  try {
    if (local) throw new Error("redLocal");
    const resultado = await cliente.ubicacion(ip, forzar);
    if (version !== generacion || versionUbicacion !== generacionUbicacion) return;
    if (!resultado.data) throw new Error("sinDatos");
    const datos = resultado.data;
    const bandera = obtenerCodigoBandera(datos);
    mostrarBandera(bandera);
    ponerTexto("pais", obtenerNombrePais(datos, bandera));
    ponerTexto("ciudad-region", [...new Set([datos.city, datos.region].filter(Boolean))].join(traducir("separadorUbicacion")) || traducir("ubicacionAproximada"));
    ponerEnlaceWhois('asn', datos.asn);
    ponerTexto('isp', datos.isp);
    let zona = datos.timezone;
    try {
      const desfase = new Intl.DateTimeFormat(IDIOMA, { timeZone: zona, timeZoneName: 'shortOffset' }).formatToParts().find(parte => parte.type === 'timeZoneName')?.value;
      if (zona && desfase) zona += ' (' + desfase + ')';
    } catch {}
    ponerTexto("zonaHoraria", zona);
    mostrarMapa(datos);
    anotarConsulta("actualizar", resultado.checkedAt);
  } catch (error) {
    if (version !== generacion || versionUbicacion !== generacionUbicacion) return;
    ponerTexto("pais", local ? traducir("tituloRedLocal") : traducir("ubicacionNoDisponible"));
    ponerTexto("ciudad-region", traducir("ubicacionAproximada"));
    $("mensaje-ubicacion").textContent = error.message === "sinDatos" ? traducir("sinDatos") : textoError(error);
    $("mensaje-ubicacion").hidden = false;
    $("reintentar-ubicacion").hidden = local;
  } finally {
    if (version === generacion && versionUbicacion === generacionUbicacion) $("region-ubicacion").setAttribute('aria-busy', 'false');
  }
}
function mostrarMapa(datos) {
  clearTimeout(temporizadorMapa);
  const version = ++generacionMapa;
  const latitud = datos.latitude, longitud = datos.longitude;
  const valido = Number.isFinite(latitud) && Number.isFinite(longitud) && Math.abs(latitud) <= 90 && Math.abs(longitud) <= 180;
  coordenadasActuales = valido ? { lat: latitud, lon: longitud } : null;
  $("contenedor-mapa").hidden = !valido;
  $("abrir-mapa").hidden = !valido;
  $("cuadricula-mapa").replaceChildren();
  if (!valido) return;
  const carga = $("carga-mapa");
  carga.hidden = false;
  carga.textContent = traducir("mapaCargando");
  const mosaicos = obtenerMosaicos(latitud, longitud, $("contenedor-mapa").clientWidth || 320, $("contenedor-mapa").clientHeight || 130);
  let terminadas = 0, cargados = 0;
  function finalizar() {
    if (version !== generacionMapa) return;
    clearTimeout(temporizadorMapa);
    carga.hidden = cargados === mosaicos.length && mosaicos.length > 0;
    carga.textContent = cargados ? traducir("mapaParcial") : traducir("mapaNoDisponible");
  }
  temporizadorMapa = setTimeout(finalizar, 8000);
  if (!mosaicos.length) finalizar();
  mosaicos.forEach(mosaico => {
    const imagen = new Image();
    imagen.className = "mosaico-mapa";
    imagen.alt = '';
    imagen.draggable = false;
    imagen.referrerPolicy = 'strict-origin-when-cross-origin';
    imagen.style.left = mosaico.left + 'px';
    imagen.style.top = mosaico.top + 'px';
    const terminar = exito => {
      if (version !== generacionMapa) return;
      terminadas++;
      if (exito) cargados++;
      if (terminadas === mosaicos.length) finalizar();
    };
    imagen.onload = () => terminar(true);
    imagen.onerror = () => terminar(false);
    imagen.src = mosaico.url;
    $("cuadricula-mapa").appendChild(imagen);
  });
}
async function abrirMapa() {
  if (!coordenadasActuales) return;
  const { lat: latitud, lon: longitud } = coordenadasActuales;
  try {
    await chrome.tabs.create({ url: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(latitud + ',' + longitud) });
    window.close();
  } catch { $("estado-copia").textContent = traducir("aperturaFallida"); }
}
async function copiarResumen() {
  const filas = ["dominio", 'ip', 'asn', 'isp', "zonaHoraria"];
  const lineas = filas.map(id => $(id + "-etiqueta").textContent + ': ' + $(id).textContent);
  lineas.push(traducir("ubicacionAproximada") + ': ' + $("pais").textContent + ' · ' + $("ciudad-region").textContent);
  for (const tipoPanel of ['ssl', 'whois']) lineas.push(tipoPanel.toUpperCase() + ': ' + $(tipoPanel + "-valor").textContent);
  try { await navigator.clipboard.writeText(lineas.join('\n')); $("estado-copia").textContent = traducir("resumenCopiado"); }
  catch { $("estado-copia").textContent = traducir("copiaFallida"); }
}
async function iniciar(forzar = false) {
  if (enCurso || forzar && Date.now() < actualizacionDisponibleEn) return;
  enCurso = true;
  const version = ++generacion;
  $("actualizar").disabled = true;
  $('error').hidden = true;
  $("contenido").hidden = true;
  $("cargando").hidden = false;
  $("estado-copia").textContent = '';
  const tareas = [];
  try {
    const [pestana] = await chrome.tabs.query({ active: true, currentWindow: true });
    try { destino = WebInfo.destinoDesdeUrl(pestana?.url); }
    catch { throw new Error("paginaNoCompatible"); }
    $("cargando").hidden = true;
    $("contenido").hidden = false;
    ponerEnlaceWhois("dominio", destino.hostname, destino.local);
    ponerEnlaceWhois('ip', '');
    reiniciarUbicacion();
    $("mensaje-ubicacion").hidden = true;
    $("reintentar-ubicacion").hidden = true;
    ipSeleccionada = '';
    $("origen-ip").textContent = traducir(WebInfo.esDireccionIp(destino.hostname) ? "origenIp" : "origenDns");
    $("origen-ip").title = traducir(WebInfo.esDireccionIp(destino.hostname) ? "descripcionOrigenIp" : "descripcionOrigenDns");
    for (const tipoPanel of ['ssl', 'whois']) estadoPanel(tipoPanel, traducir("datosCargando"), true);
    let direccionesIp = [];
    if (destino.local) {
      ponerTexto("pais", traducir("tituloRedLocal"));
      $("mensaje-ubicacion").textContent = traducir("redLocal");
      $("mensaje-ubicacion").hidden = false;
      if (WebInfo.esDireccionIp(destino.hostname)) ponerEnlaceWhois('ip', destino.hostname, true);
      for (const tipoPanel of ['ssl', 'whois']) estadoPanel(tipoPanel, traducir("noAplicable"));
      return;
    }
    try {
      direccionesIp = WebInfo.esDireccionIp(destino.hostname) ? [destino.hostname] : (await cliente.resolver(destino.hostname, forzar)).data?.ips || [];
      if (!direccionesIp.length) throw new Error("resolucionFallida");
    } catch (error) {
      ponerTexto("pais", traducir("ubicacionNoDisponible"));
      $("mensaje-ubicacion").textContent = error.message === "resolucionFallida" ? traducir("resolucionFallida") : textoError(error);
      $("mensaje-ubicacion").hidden = false;
    }
    // Si el nombre público resuelve a una IP privada, no se consulta a otros proveedores.
    if (direccionesIp.some(ip => !WebInfo.esIpPublica(ip))) {
      destino.local = true;
      ponerEnlaceWhois("dominio", destino.hostname, true);
      await cargarUbicacion(direccionesIp.find(ip => !WebInfo.esIpPublica(ip)));
      for (const tipoPanel of ['ssl', 'whois']) estadoPanel(tipoPanel, traducir("noAplicable"));
      return;
    }
    if (direccionesIp.length) {
      tareas.push(cargarUbicacion(direccionesIp[0], forzar));
    } else {
      $("reintentar-ubicacion").hidden = false;
    }
    tareas.push(cargarPanel('ssl', forzar), cargarPanel('whois', forzar));
    await Promise.all(tareas);
  } catch (error) {
    $("cargando").hidden = true;
    $("contenido").hidden = true;
    $('error').hidden = false;
    $("mensaje-error").textContent = error.message === "paginaNoCompatible" ? traducir("paginaNoCompatible") : textoError(error);
  } finally {
    if (version === generacion) {
      enCurso = false;
      actualizacionDisponibleEn = Date.now() + 5000;
      setTimeout(() => { if (!enCurso) $("actualizar").disabled = false; }, 5000);
      void cliente.limpiarCache();
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  aplicarTextos();
  $("actualizar").addEventListener('click', () => iniciar(true));
  $("reintentar-error").addEventListener('click', () => iniciar());
  $("abrir-mapa").addEventListener('click', abrirMapa);
  $("contenedor-mapa").addEventListener('contextmenu', evento => { if (coordenadasActuales) { evento.preventDefault(); void abrirMapa(); } });
  $("copiar-resumen").addEventListener('click', copiarResumen);
  new ResizeObserver(() => {
    if (coordenadasActuales && !$("contenedor-mapa").hidden) mostrarMapa({ latitude: coordenadasActuales.lat, longitude: coordenadasActuales.lon });
  }).observe($("contenedor-mapa"));
  $("reintentar-ubicacion").addEventListener('click', async () => {
    $("reintentar-ubicacion").disabled = true;
    try { if (ipSeleccionada) await cargarUbicacion(ipSeleccionada, true); else await iniciar(true); }
    finally { $("reintentar-ubicacion").disabled = false; }
  });
  for (const tipoPanel of ['ssl', 'whois']) {
    $(tipoPanel + "-alternar").addEventListener('click', () => abrirPanel(tipoPanel, $(tipoPanel + "-detalles").hidden));
    $(tipoPanel + "-reintentar").addEventListener('click', async () => {
      const version = generacion;
      $(tipoPanel + "-reintentar").disabled = true;
      await cargarPanel(tipoPanel, true);
      if (version === generacion) abrirPanel(tipoPanel, true);
      $(tipoPanel + "-reintentar").disabled = false;
    });
  }
  void iniciar();
});

// Convierte coordenadas a píxeles Web Mercator.
function longitudAX(longitud, z) {
  return ((longitud + 180) / 360) * Math.pow(2, z) * 256;
}
function latitudAY(latitud, z) {
  const r = (Math.max(-85.05112878, Math.min(85.05112878, latitud)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z) * 256;
}

function obtenerMosaicos(latitud, longitud, ancho, alto) {
  const posicionX = longitudAX(longitud, ZOOM_MAPA);
  const posicionY = latitudAY(latitud, ZOOM_MAPA);
  const origenX = posicionX - ancho / 2;
  const origenY = posicionY - alto / 2;
  const mosaicos = [];
  const limiteMosaicos = Math.pow(2, ZOOM_MAPA);

  for (let y = Math.floor(origenY / 256); y < Math.ceil((origenY + alto) / 256); y++) {
    for (let mosaicoX = Math.floor(origenX / 256); mosaicoX < Math.ceil((origenX + ancho) / 256); mosaicoX++) {
      const x = ((mosaicoX % limiteMosaicos) + limiteMosaicos) % limiteMosaicos;
      if (y < 0 || y >= limiteMosaicos) continue;
      const url = `${SERVIDOR_MAPA}/${ZOOM_MAPA}/${x}/${y}.png`;
      mosaicos.push({
        url,
        left: Math.round(mosaicoX * 256 - origenX),
        top: Math.round(y * 256 - origenY),
      });
    }
  }
  return mosaicos;
}

// Distingue territorios con bandera propia.
function obtenerCodigoBandera(datos) {
  const codigo = (datos.country_code || '').toUpperCase();
  if (codigo === 'CN') {
    const lugar = [datos.country, datos.region, datos.city].filter(Boolean).join(' ');
    if (/Hong\s*Kong/i.test(lugar)) return 'hk';
    if (/Macau|Macao/i.test(lugar)) return 'mo';
    if (/Taiwan/i.test(lugar)) return 'tw';
  }
  return /^[A-Z]{2}$/.test(codigo) ? codigo.toLowerCase() : '';
}

let nombresRegiones;
function traducirPais(codigoPais) {
  const abreviaturaPais = (codigoPais || '').toUpperCase();
  if (!abreviaturaPais) return '';
  if (nombresRegiones === undefined) {
    try {
      nombresRegiones = new Intl.DisplayNames([IDIOMA], { type: 'region' });
    } catch {
      nombresRegiones = null;
    }
  }
  if (nombresRegiones) {
    try {
      const nombre = nombresRegiones.of(abreviaturaPais);
      if (nombre && nombre.toUpperCase() !== abreviaturaPais) return nombre;
    } catch {}
  }
  return '';
}

function obtenerNombrePais(datos, codigoBandera) {
  const nombreCorto = NOMBRES_CORTOS[codigoBandera];
  if (nombreCorto) return nombreCorto;
  return traducirPais(datos.country_code) || datos.country || datos.country_code || '--';
}

function mostrarBandera(codigoBandera) {
  const imagen = $("imagen-bandera");
  if (!imagen) return;
  // El nombre del país ya acompaña la bandera.
  imagen.alt = '';

  if (!codigoBandera) {
    imagen.onerror = null;
    imagen.removeAttribute('src');
    imagen.hidden = true;
    return;
  }

  const rutaLocal = chrome.runtime.getURL(`recursos/banderas/4x3/bandera-${codigoBandera}.svg`);
  imagen.onerror = () => {
    imagen.onerror = () => { imagen.onerror = null; imagen.hidden = true; };
    imagen.src = chrome.runtime.getURL('recursos/iconos/globo.svg');
  };
  imagen.hidden = false;
  imagen.src = rutaLocal;
}
