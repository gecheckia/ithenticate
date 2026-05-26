# iThenticate PDF Proxy

Bot Node.js + Puppeteer que inicia sesión en iThenticate, abre el visor del reporte y devuelve el PDF como stream a tu app de Lovable. Pensado para desplegarse **gratis en Render** (también funciona en Railway, Fly.io, etc.).

## 1. Estructura

```
ithenticate-pdf-proxy/
├── server.js        # API Express + Puppeteer
├── package.json
├── Dockerfile       # Imagen oficial de Puppeteer (Chromium incluido)
├── render.yaml      # Blueprint de despliegue para Render
└── README.md
```

## 2. Variables de entorno necesarias

| Variable | Descripción |
|---|---|
| `API_KEY` | Clave compartida. Tu app Lovable la envía en el header `x-api-key`. Genera algo largo y aleatorio. |
| `ITHENTICATE_USERNAME` | Email de tu cuenta iThenticate |
| `ITHENTICATE_PASSWORD` | Password de tu cuenta iThenticate |
| `ITHENTICATE_BASE_URL` | (opcional) por defecto `https://www.ithenticate.com` |
| `RENDER_WAIT_MS` | (opcional) ms a esperar tras cargar el visor. Default `8000` |

## 3. Despliegue en Render (gratis)

1. Crea un repo nuevo en GitHub y sube esta carpeta (`git init && git add . && git commit -m "init" && git push`).
2. Entra a https://dashboard.render.com → **New +** → **Blueprint**.
3. Conecta el repo. Render detectará `render.yaml` y creará el servicio.
4. En el paso de configuración, pega los valores de:
   - `API_KEY` (inventa una clave fuerte, p. ej. `openssl rand -hex 32`)
   - `ITHENTICATE_USERNAME`
   - `ITHENTICATE_PASSWORD`
5. Click **Apply**. El primer build tarda ~5 min (Docker + Chromium).
6. Cuando termine, te dará una URL pública tipo `https://ithenticate-pdf-proxy.onrender.com`.

> ⚠️ **Plan free de Render:** el servicio se "duerme" tras 15 min de inactividad. La primera petición tras dormirse tarda ~30 s en despertar. Para evitarlo, configura un ping cada 10 min (UptimeRobot gratis) a `/health`.

### Alternativa: Railway

1. https://railway.app → **New Project** → **Deploy from GitHub repo**.
2. Railway detecta el Dockerfile automáticamente.
3. En **Variables** añade las mismas 3 secretas.
4. Genera dominio público en **Settings → Networking → Generate Domain**.

## 4. Probar el bot

```bash
curl -X POST https://TU-BOT.onrender.com/report-pdf \
  -H "x-api-key: TU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"viewUrl":"https://www.ithenticate.com/dv?o=12345&u=...&s=..."}' \
  --output reporte.pdf
```

Si `reporte.pdf` se abre correctamente, el bot funciona.

## 5. Conectar con tu app Lovable

Una vez tengas la URL pública y la API_KEY, dímelo en el chat de Lovable y guardo:
- `ITHENTICATE_PROXY_URL` (la URL del bot en Render)
- `ITHENTICATE_PROXY_API_KEY` (la misma API_KEY)

Luego cambio el botón **"Descargar reporte de similitud"** para que llame a tu bot, reciba el PDF como Blob y dispare la descarga automática — el usuario nunca verá iThenticate.

## 6. Endpoint disponible

### `POST /report-pdf`

**Headers:**
- `x-api-key: <API_KEY>`
- `Content-Type: application/json`

**Body:**
```json
{ "viewUrl": "https://www.ithenticate.com/dv?o=..." }
```
o bien:
```json
{ "documentId": "12345678" }
```

**Respuesta:** `application/pdf` (stream binario).

### `GET /health`
Devuelve `{ "ok": true }`. Sin auth. Úsalo para UptimeRobot.

## 7. Notas de seguridad

- La `API_KEY` evita que terceros usen tu bot. Rótala si se filtra.
- Las credenciales iThenticate viven solo en variables de entorno de Render — nunca en el repo.
- Añade `.env` y `node_modules` a `.gitignore`.
