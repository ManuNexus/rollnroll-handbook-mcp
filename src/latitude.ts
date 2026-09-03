import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Nunca poner credenciales en el código: se leen del entorno (Secret Manager en Cloud Run).
const LATITUDE_API_KEY = process.env.LATITUDE_API_KEY;
const LATITUDE_PROJECT_ID = process.env.LATITUDE_PROJECT_ID || '26842';
const GATEWAY_URL = process.env.LATITUDE_GATEWAY_URL || 'https://gateway.latitude.so/api/v3';
const REQUEST_TIMEOUT_MS = Number(process.env.LATITUDE_TIMEOUT_MS || 15_000);

function authHeaders() {
  if (!LATITUDE_API_KEY) {
    throw new Error('LATITUDE_API_KEY is not set');
  }
  return { Authorization: `Bearer ${LATITUDE_API_KEY}` };
}

// Cache en memoria para evitar latencias de red en cada clip
interface CacheEntry {
  content: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos de TTL

/**
 * Obtiene el UUID de la versión más reciente del proyecto en Latitude.
 */
async function getLatestVersionUuid(): Promise<string> {
  const cached = cache.get('__latest_version__');
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.content;
  }

  const res = await axios.get(`${GATEWAY_URL}/projects/${LATITUDE_PROJECT_ID}/versions`, {
    headers: authHeaders(),
    timeout: REQUEST_TIMEOUT_MS
  });

  const versions = res.data;
  const latest = versions
    .filter((v: any) => v.version !== null && v.version !== undefined)
    .sort((a: any, b: any) => b.version - a.version)[0] || versions[0];

  if (!latest || !latest.uuid) {
    throw new Error(`Could not find a valid version for project ${LATITUDE_PROJECT_ID}`);
  }

  const versionUuid = latest.uuid;
  cache.set('__latest_version__', { content: versionUuid, timestamp: Date.now() });
  return versionUuid;
}

/**
 * Recupera el contenido Markdown de un documento de handbook en Latitude eliminando el frontmatter YAML.
 */
export async function fetchHandbookDocument(documentPath: string): Promise<string> {
  const cached = cache.get(documentPath);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.content;
  }

  const versionUuid = await getLatestVersionUuid();
  const url = `${GATEWAY_URL}/projects/${LATITUDE_PROJECT_ID}/versions/${versionUuid}/documents/${documentPath}`;

  const res = await axios.get(url, {
    headers: authHeaders(),
    timeout: REQUEST_TIMEOUT_MS
  });

  let content: string = res.data?.content || '';

  // Limpiar frontmatter YAML inicial si existe
  if (content.startsWith('---')) {
    const parts = content.split('---');
    if (parts.length >= 3) {
      content = parts.slice(2).join('---').trim();
    }
  }

  cache.set(documentPath, { content, timestamp: Date.now() });
  return content;
}
