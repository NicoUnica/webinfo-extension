# WebInfo

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green.svg)](https://chrome.google.com/webstore)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)

Extensión de Chrome para consultar de un vistazo dónde está alojado el servidor del sitio abierto.

## Características

- Bandera, país, ciudad y ubicación aproximada del servidor
- Dirección IP, ASN, ISP y zona horaria
- Información del certificado SSL y registro WHOIS
- Mapa interactivo con acceso directo a Google Maps
- Resolución DNS compatible con IPv4 e IPv6
- Interfaz disponible en inglés y español

## Uso

1. Abre cualquier sitio web en Chrome
2. Haz clic en el icono de **WebInfo** en la barra de herramientas
3. Consulta los datos del servidor o despliega SSL y WHOIS para ver más detalles

La extensión funciona sobre la pestaña activa y no analiza el contenido de las páginas.

## Instalación

1. Abrir `chrome://extensions`
2. Activar **Modo desarrollador**
3. Clic en **Cargar descomprimida**
4. Seleccionar este directorio

## Privacidad

Para obtener los datos del servidor, WebInfo consulta servicios de geolocalización, DNS, SSL, WHOIS y mapas. Solo se envían el nombre de host o la IP del sitio activo; nunca el contenido de la página, formularios, cookies o actividad de navegación.

Los resultados se guardan temporalmente durante la sesión del navegador. Consulta la [política de privacidad](pages/privacy.html) para ver el detalle de los servicios utilizados.

<img width="318" height="471" alt="image" src="https://github.com/user-attachments/assets/2f9e320b-9c7f-47ac-be29-467202132a41" />

