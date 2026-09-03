import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetchHandbookDocument } from './latitude.js';

export const CATEGORIES = [
  'business',
  'comedy',
  'education',
  'entertainment',
  'fashion',
  'fitness',
  'food',
  'gaming',
  'lifestyle',
  'movies',
  'music',
  'politics',
  'sports',
  'technology'
] as const;

export const FORMATS = [
  'documentary',
  'entertainment',
  'gameplay',
  'learning',
  'news',
  'podcast',
  'reaction',
  'tutorial'
] as const;

function createMcpServer() {
  const server = new McpServer({
    name: 'rollnroll-handbook-fetcher',
    version: '1.0.0'
  });

  server.tool(
    'get_content_handbooks',
    'Fetches and unifies category and format extraction handbooks dynamically from Latitude for video content segmentation.',
    {
      category: z.enum(CATEGORIES).describe('The detected primary category/niche of the video (e.g. gaming, business, comedy)'),
      format: z.enum(FORMATS).describe('The detected structural format of the video (e.g. gameplay, podcast, reaction, tutorial)')
    },
    async ({ category, format }) => {
      try {
        const categoryPath = `handbooks/category/${category.toLowerCase()}`;
        const formatPath = `handbooks/format/${format.toLowerCase()}`;

        const [categoryContent, formatContent] = await Promise.all([
          fetchHandbookDocument(categoryPath),
          fetchHandbookDocument(formatPath)
        ]);

        const combinedMarkdown = [
          `# CONTENT HANDBOOKS: ${category.toUpperCase()} / ${format.toUpperCase()}`,
          '',
          '---',
          `## 1. CATEGORY HANDBOOK (${category.toUpperCase()})`,
          categoryContent,
          '',
          '---',
          `## 2. FORMAT HANDBOOK (${format.toUpperCase()})`,
          formatContent
        ].join('\n');

        return {
          content: [
            {
              type: 'text',
              text: combinedMarkdown
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error fetching handbooks for category "${category}" and format "${format}": ${err?.message || err}`
            }
          ]
        };
      }
    }
  );

  return server;
}

// Iniciar servidor según el entorno (Cloud Run / SSE vs Stdio)
async function startHttpServer() {
  const app = express();
  app.use(cors());

  // Health check público para Cloud Run
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'rollnroll-handbook-mcp' });
  });

  // Almacenar transportes activos por session id
  const transports = new Map<string, SSEServerTransport>();
  const sessionTimers = new Map<string, NodeJS.Timeout>();

  // Endpoint SSE para Latitude MCP
  app.get('/sse', async (req, res) => {
    console.log(`[${new Date().toISOString()}] New SSE connection from Latitude`);
    
    // Validar token solo en la conexión inicial si está configurado
    const expectedToken = process.env.MCP_AUTH_TOKEN;
    if (expectedToken) {
      const authHeader = req.headers.authorization || (req.headers['x-api-key'] as string);
      const queryToken = req.query.token as string;
      if (
        authHeader !== `Bearer ${expectedToken}` &&
        authHeader !== expectedToken &&
        queryToken !== expectedToken
      ) {
        console.warn(`[${new Date().toISOString()}] SSE connection rejected: Invalid or missing token`);
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing authorization token' });
      }
    }

    const transport = new SSEServerTransport('/messages', res);
    const server = createMcpServer();

    await server.connect(transport);
    
    // Limpiar cualquier timer previo si existía
    if (sessionTimers.has(transport.sessionId)) {
      clearTimeout(sessionTimers.get(transport.sessionId)!);
      sessionTimers.delete(transport.sessionId);
    }
    
    transports.set(transport.sessionId, transport);
    console.log(`[${new Date().toISOString()}] Session registered: ${transport.sessionId}`);

    req.on('close', () => {
      console.log(`[${new Date().toISOString()}] SSE socket disconnected: ${transport.sessionId} (grace period started)`);
      // Dar un margen de 10 minutos antes de limpiar la sesión para que los POST /messages sigan funcionando
      const timer = setTimeout(() => {
        console.log(`[${new Date().toISOString()}] Expiring session after grace period: ${transport.sessionId}`);
        transports.delete(transport.sessionId);
        sessionTimers.delete(transport.sessionId);
      }, 10 * 60 * 1000);
      
      sessionTimers.set(transport.sessionId, timer);
    });
  });

  // Endpoint para recibir mensajes/invocaciones de tools desde el cliente
  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);

    if (!transport) {
      console.warn(`[${new Date().toISOString()}] POST /messages failed: Session ${sessionId} not found in memory`);
      res.status(404).send('Session not found');
      return;
    }

    try {
      await transport.handlePostMessage(req, res);
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}] Error handling POST /messages for session ${sessionId}:`, err);
      if (!res.headersSent) {
        res.status(500).send(err?.message || 'Internal Server Error');
      }
    }
  });

  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`🚀 RollnRoll Handbook MCP Server running on port ${PORT}`);
    console.log(`📡 SSE Endpoint: http://localhost:${PORT}/sse`);
    console.log(`📨 Message Endpoint: http://localhost:${PORT}/messages`);
  });
}

// Si se ejecuta en modo stdio (ej. local agy / cli)
async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.MCP_TRANSPORT === 'stdio') {
  startStdioServer().catch(console.error);
} else {
  startHttpServer().catch(console.error);
}
