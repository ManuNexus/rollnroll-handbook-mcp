import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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

/**
 * Serves one JSON-RPC request over the Streamable HTTP transport in *stateless* mode.
 *
 * Stateless is the whole point: a fresh McpServer + transport is built for this single
 * request and torn down with it, so nothing is kept in the instance's memory between
 * requests. Cloud Run is therefore free to route every request to any instance it likes,
 * and there is no long-lived request that can hit the 300s request timeout.
 *
 * The previous SSE-only design could not survive that: the session lived in a per-instance
 * Map, while the client's POSTs were load-balanced across instances, so most of them
 * answered "404 Session not found".
 */
async function handleStatelessRequest(req: Request, res: Response) {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('Error handling stateless MCP request:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
}

// Iniciar servidor según el entorno (Cloud Run / SSE vs Stdio)
async function startHttpServer() {
  const app = express();
  app.use(cors({ exposedHeaders: ['Mcp-Session-Id'] }));
  app.use(express.json({ limit: '4mb' }));

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
    const queryToken = req.query.token as string | undefined;
    if (
      authHeader !== `Bearer ${expectedToken}` &&
      authHeader !== expectedToken &&
      queryToken !== expectedToken
    ) {
      console.warn(`Rejected ${req.method} ${req.path}: invalid or missing token`);
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing authorization token' });
    }

    next();
  });

  // ---------------------------------------------------------------------------
  // Streamable HTTP (recomendado) — sin estado, seguro con cualquier número de
  // instancias de Cloud Run. Este es el endpoint que debe usar Latitude.
  // ---------------------------------------------------------------------------
  app.post(['/mcp', '/'], handleStatelessRequest);

  // En modo stateless no hay stream iniciado por el servidor ni sesión que borrar.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed. This endpoint is stateless: send JSON-RPC over POST /mcp.'
      },
      id: null
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // ---------------------------------------------------------------------------
  // Legacy HTTP+SSE (protocolo 2024-11-05). Se mantiene sólo por compatibilidad.
  //
  // ATENCIÓN: la sesión vive en la memoria de *esta* instancia, así que sólo
  // funciona si el servicio corre con una única instancia (o si el cliente
  // devuelve la cookie de afinidad de sesión de Cloud Run, cosa que Latitude no
  // hace). Los clientes nuevos deben usar POST /mcp.
  // ---------------------------------------------------------------------------
  const transports = new Map<string, SSEServerTransport>();
  const SSE_KEEPALIVE_MS = 25_000;

  app.get('/sse', async (req, res) => {
    console.log('New authenticated SSE connection (legacy transport)');
    const transport = new SSEServerTransport('/messages', res);
    const server = createMcpServer();

    await server.connect(transport);
    transports.set(transport.sessionId, transport);

    // Evita que proxies intermedios corten un stream inactivo.
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), SSE_KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(keepAlive);
      console.log(`SSE connection closed: ${transport.sessionId}`);
      transports.delete(transport.sessionId);
      void server.close();
    });
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;

    // Sin sessionId no hay nada que enrutar: trátalo como Streamable HTTP.
    if (!sessionId) {
      return handleStatelessRequest(req, res);
    }

    const transport = transports.get(sessionId);

    if (!transport) {
      console.warn(
        `Unknown SSE session ${sessionId}. This instance holds ${transports.size} session(s). ` +
          'If the service runs more than one instance, the SSE stream is on another instance: use POST /mcp instead.'
      );
      res.status(404).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message:
            'Session not found. The legacy SSE transport requires the POST to reach the same instance that holds the SSE stream. ' +
            'Use the stateless POST /mcp endpoint instead.'
        },
        id: (req.body as any)?.id ?? null
      });
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  });

  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`🚀 RollnRoll Handbook MCP Server running on port ${PORT}`);
    console.log(`📡 Streamable HTTP endpoint (recommended): POST http://localhost:${PORT}/mcp`);
    console.log(`📨 Legacy SSE endpoint (single-instance only): GET http://localhost:${PORT}/sse`);
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
