const router = require('express').Router();
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createApiClient, ApiError } = require('../../mcp-server/apiClient');
const { createTools } = require('../../mcp-server/tools');
const { authenticateOrApiKey } = require('../middleware/auth');

router.post('/', authenticateOrApiKey, async (req, res, next) => {
  try {
    const forwardHeaders = {};
    if (req.headers['x-api-key']) forwardHeaders['X-Api-Key'] = req.headers['x-api-key'];
    if (req.headers.authorization) forwardHeaders['Authorization'] = req.headers.authorization;

    const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
    const { apiRequest } = createApiClient({ baseUrl, headers: forwardHeaders });
    const tools = createTools(apiRequest);

    const server = new McpServer({ name: 'ota', version: '1.0.0' });
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args) => {
        try {
          const result = await tool.run(args);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            return { isError: true, content: [{ type: 'text', text: 'API key is invalid, missing, or has been disabled. Contact your property admin.' }] };
          }
          return { isError: true, content: [{ type: 'text', text: err.message }] };
        }
      });
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
