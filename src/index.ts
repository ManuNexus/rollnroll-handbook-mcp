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

  // Middleware de Autenticación mediante Shared Secret Token
  app.use((req, res, next) => {
    const expectedToken = process.env.MCP_AUTH_TOKEN;
    if (!expectedToken) {
      return next(); // Si no hay token configurado, pasa sin auth
    }

    const authHeader = req.headers.authorization || (req.headers['x-api-key'] as string);
    if (authHeader !== `Bearer ${expectedToken}` && authHeader !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing authorization header' });
    }

    next();
  });

  // Almacenar transportes activos por session id
  const transports = new Map<string, SSEServerTransport>();

  // Endpoint SSE para Latitude MCP
  app.get('/sse', async (req, res) => {
    console.log('New authenticated SSE connection from Latitude');
    const transport = new SSEServerTransport('/messages', res);
    const server = createMcpServer();

    await server.connect(transport);
    transports.set(transport.sessionId, transport);

    req.on('close', () => {
      console.log(`SSE connection closed: ${transport.sessionId}`);
      transports.delete(transport.sessionId);
    });
  });

  // Endpoint para recibir mensajes/invocaciones de tools desde el cliente
  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);

    if (!transport) {
      res.status(404).send('Session not found');
      return;
    }

    await transport.handlePostMessage(req, res);
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
