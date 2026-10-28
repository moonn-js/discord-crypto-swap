import http from 'node:http';

export async function startHealthServer({ port, health, logger, webhookHandler = null }) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (webhookHandler && await webhookHandler(request, response)) return;
    } catch (error) {
      logger.warn({ errorName: error.name, errorCode: 'WEBHOOK_HANDLER_FAILED' }, 'Webhook request failed');
      if (!response.headersSent) response.writeHead(500);
      response.end(JSON.stringify({ error: 'internal_error' }));
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405);
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    if (request.url === '/healthz') {
      response.writeHead(200);
      response.end(JSON.stringify({ alive: true }));
      return;
    }
    if (request.url === '/readyz') {
      const snapshot = health.snapshot();
      response.writeHead(snapshot.ready ? 200 : 503);
      response.end(JSON.stringify(snapshot));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  logger.info({ port }, 'Health server listening');
  return server;
}
