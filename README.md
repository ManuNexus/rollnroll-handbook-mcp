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
