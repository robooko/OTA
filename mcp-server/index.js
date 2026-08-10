const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const tools = require('./tools');
const { ApiError } = require('./apiClient');

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

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error('Failed to start OTA MCP server:', err);
  process.exit(1);
});
