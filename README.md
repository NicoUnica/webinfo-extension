# WebInfo

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green.svg)](https://chrome.google.com/webstore)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)

Extensión de Chrome para consultar de un vistazo la ubicación aproximada del servidor del sitio abierto.

## Características

- Bandera, país, ciudad y ubicación aproximada del servidor.
- Dirección IP, ASN, ISP y zona horaria.
- Información del certificado SSL y registro WHOIS.
- Vista previa del mapa con acceso directo a Google Maps.
- Resolución DNS compatible con IPv4 e IPv6.
- Interfaz en español y tema claro u oscuro.
- Copia del resumen y actualización de los datos.

## Uso

1. Abre un sitio web en Chrome.
2. Haz clic en el icono de **WebInfo** en la barra de herramientas.
3. Consulta los datos o despliega SSL y WHOIS para ver más detalles.

La extensión funciona sobre la pestaña activa y no analiza el contenido de las páginas.

## Instalación

Requiere Chrome 102 o posterior.

1. Abre `chrome://extensions`.
2. Activa **Modo desarrollador**.
3. Pulsa **Cargar descomprimida**.
4. Selecciona este directorio.

## Privacidad

WebInfo consulta servicios de geolocalización, DNS, SSL, WHOIS y mapas. Para las consultas solo utiliza el nombre de host o la IP del sitio activo; no lee el contenido de la página, formularios ni cookies.

Los resultados se guardan temporalmente durante la sesión del navegador. Consulta la [política de privacidad](paginas/privacidad.html) para ver los detalles.

## Tipografía

Afacad se incluye localmente desde [Google Fonts](https://github.com/google/fonts/tree/main/ofl/afacad), bajo la licencia [SIL Open Font License](recursos/fuentes/licencia-afacad.txt).
