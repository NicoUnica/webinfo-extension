# WebInfo

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green.svg)](https://chrome.google.com/webstore)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Status](https://img.shields.io/badge/Status-Active-success.svg)]()

Extensión de Chrome para ver información de servidores web con banderas de países y datos de geolocalización.

## Qué hace

### Información del Servidor
- Banderas de países en la barra de herramientas
- IP resuelta y hostname
- ASN, ISP, ciudad, región, zona horaria y coordenadas
- Información de certificado SSL
- Mapa de ubicación del servidor

### UI/UX
- Popup compacto con información detallada
- Banderas cuadradas o rectangulares
- Modo claro y oscuro
- Interfaz en inglés y español
- Caché de sesiones para rendimiento

## Funciones

### popup.js
- `init()` - Inicialización principal
- `fetchGeoJson()` - Obtener datos de geolocalización
- `fetchSslJson()` - Obtener información SSL
- `fetchWhoisJson()` - Obtener datos WHOIS
- `renderMap()` - Renderizar mapa de ubicación
- `setFlagImage()` - Mostrar bandera del país
- `extractAsn()` - Extraer número ASN

### popup.html
- Estructura del popup principal
- Elementos para mostrar información IP, SSL, WHOIS
- Menú contextual del mapa
- Botones de expansión de detalles

### popup.css
- Estilos responsivos para el popup
- Animaciones de carga y mapa
- Tema claro/oscuro automático
- Diseño compacto y profesional

## APIs Externas

- `ipwho.is` - Geolocalización IP
- `host.tools` - Información SSL
- `who-dat.as93.net` - Datos WHOIS
- `cloudflare-dns.com` - DNS-over-HTTPS

## Instalación

1. Abrir `chrome://extensions`
2. Activar **Modo desarrollador**
3. Clic en **Cargar descomprimida**
4. Seleccionar este directorio

## Notas

- Solo para fines informativos
- No almacena datos personales
- Caché local en sesión del navegador
- Manifest V3 compatible