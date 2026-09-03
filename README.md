# RollnRoll Handbook MCP Server 📚

Servidor MCP (Model Context Protocol) diseñado para que el agente extractor de RollnRoll (`agents/sentences-finder` en Latitude) obtenga y unifique dinámicamente los handbooks de **Categoría** y **Formato** tras clasificar el vídeo.

---

## 🚀 Herramienta disponible

### `get_content_handbooks`
Recupera y concatena el manual de categoría y el de formato desde Latitude (`Rollie PM - ID: 26842`).

#### Parámetros:
* `category` (enum): `business`, `comedy`, `education`, `entertainment`, `fashion`, `fitness`, `food`, `gaming`, `lifestyle`, `movies`, `music`, `politics`, `sports`, `technology`
* `format` (enum): `documentary`, `entertainment`, `gameplay`, `learning`, `news`, `podcast`, `reaction`, `tutorial`

#### Ejemplo de salida:
```markdown
# CONTENT HANDBOOKS: GAMING / GAMEPLAY

---
## 1. CATEGORY HANDBOOK (GAMING)
[Contenido de handbooks/category/gaming en Latitude...]

---
## 2. FORMAT HANDBOOK (GAMEPLAY)
[Contenido de handbooks/format/gameplay en Latitude...]
```

---

## 🔌 Endpoints y transportes

| Endpoint | Transporte | Estado | Usar en |
| --- | --- | --- | --- |
| `POST /mcp` | Streamable HTTP, **sin estado** | ✅ recomendado | Latitude y cualquier cliente MCP |
| `GET /sse` + `POST /messages?sessionId=…` | HTTP+SSE (protocolo `2024-11-05`) | ⚠️ legacy | sólo compatibilidad, requiere **una única instancia** |
| `GET /health` | — | público, sin auth | health check de Cloud Run |

Todos los endpoints (menos `/health`) exigen el token compartido:
`Authorization: Bearer $MCP_AUTH_TOKEN`.

### Por qué `POST /mcp` y no `/sse`

El transporte SSE guarda la sesión en un `Map` **en la memoria de la instancia** que
atiende el `GET /sse`. Cloud Run reparte cada `POST /messages` entre todas las instancias
vivas, y Latitude no devuelve la cookie de afinidad de sesión (`GAESA`) de Cloud Run, así
que la mayoría de los POST llegaban a una instancia que no conoce ese `sessionId` y
respondían `404 Session not found`: con 3 instancias, un handshake casi nunca terminaba.
Además cada `GET /sse` moría a los 300 s exactos, el `timeout` de request del servicio.

`POST /mcp` funciona en modo *stateless*: cada petición construye su propio `McpServer` y
lo destruye al terminar. No queda nada en memoria entre peticiones, así que da igual a qué
instancia llegue cada llamada y no hay ninguna petición de larga duración que pueda chocar
con el timeout.

### Configuración en Latitude

Apuntar el MCP a la URL del endpoint stateless:

```
https://rollnroll-handbook-mcp-op43n4aexa-ew.a.run.app/mcp
```

Si por algún motivo hay que seguir usando el transporte SSE legacy, el servicio **tiene que
correr con una sola instancia**:

```bash
gcloud run services update rollnroll-handbook-mcp \
  --project=n8n-shared-service --region=europe-west1 \
  --max-instances=1 --min-instances=1 --timeout=3600
```

---

## 🔐 Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `LATITUDE_API_KEY` | ✅ | API key del gateway de Latitude. Sin valor por defecto: no hay credenciales en el código. |
| `MCP_AUTH_TOKEN` | recomendada | Token compartido que exige el servidor. Si no está definida, el servidor **no** pide auth. |
| `LATITUDE_PROJECT_ID` | — | Proyecto de Latitude (por defecto `26842`). |
| `LATITUDE_GATEWAY_URL` | — | Por defecto `https://gateway.latitude.so/api/v3`. |
| `LATITUDE_TIMEOUT_MS` | — | Timeout de las llamadas a Latitude (por defecto `15000`). |
| `MCP_TRANSPORT` | — | `stdio` para ejecutar como MCP local en vez de servidor HTTP. |
| `PORT` | — | Puerto HTTP (por defecto `8080`). |

`LATITUDE_API_KEY` y `MCP_AUTH_TOKEN` son secretos: deben ir en Secret Manager y montarse
con `--set-secrets`, no como variables en texto plano del servicio.

---

## 🛠️ Instalación y Desarrollo Local

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env

# 3. Compilar TypeScript
npm run build

# 4. Iniciar en modo desarrollo
npm run dev
```

---

## 🐳 Despliegue con Docker

```bash
docker build -t rollnroll-handbook-mcp .
docker run -d --name handbook-mcp -e LATITUDE_API_KEY=tu_api_key rollnroll-handbook-mcp
```
