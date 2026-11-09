const router = require('express').Router();
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createApiClient, ApiError } = require('../../mcp-server/apiClient');
const { createTools, ORG_TOOLS } = require('../../mcp-server/tools');
const { authenticateCaller, clerkClient } = require('../middleware/auth');

// Clerk is the OAuth authorization server for /api/mcp, so an MCP client
// (a claude.ai custom connector) can sign a user in instead of sending a key:
// a 401 points at the protected-resource metadata (RFC 9728), which names
// Clerk's Frontend API. Needs dynamic client registration on in Clerk.
let fapiUrl;
function clerkFrontendApi() {
  fapiUrl ??= clerkClient.domains.list().then((r) => (r.data ?? r).find((d) => !d.isSatellite).frontendApiUrl)
    .catch((err) => { fapiUrl = undefined; throw err; });
  return fapiUrl;
}
const origin = (req) => `${req.protocol}://${req.get('host')}`;

const wellKnown = require('express').Router();
wellKnown.get(['/oauth-protected-resource', '/oauth-protected-resource/api/mcp'], async (req, res, next) => {
  try {
    res.json({
      resource: `${origin(req)}/api/mcp`,
      authorization_servers: [await clerkFrontendApi()],
      bearer_methods_supported: ['header'],
      scopes_supported: ['profile', 'email'],
    });
  } catch (err) {
    next(err);
  }
});
// Older MCP clients read the authorization server's metadata from the resource's own origin.
wellKnown.get('/oauth-authorization-server', async (req, res, next) => {
  try {
    const r = await fetch(`${await clerkFrontendApi()}/.well-known/oauth-authorization-server`);
    res.status(r.status).json(await r.json());
  } catch (err) {
    next(err);
  }
});

function oauthChallenge(req, res, next) {
  res.set('WWW-Authenticate', `Bearer resource_metadata="${origin(req)}/.well-known/oauth-protected-resource/api/mcp"`);
  next();
}

const PROPERTY_ARG = z.string().optional().describe(
  "Which of the organization's hotels to act on (an id from list_properties). Omit when the key or org has one hotel; a per-property key ignores it.");

// Credentials only: the hotel is resolved per tool call by the API it loops
// back to -- property_id, else the selectors the client sent, else the
// org's only hotel. So one org key can work across all its hotels.
router.post('/', oauthChallenge, authenticateCaller, async (req, res, next) => {
  try {
    res.removeHeader('WWW-Authenticate');
    const forwardHeaders = {};
    if (req.headers['x-api-key']) forwardHeaders['X-Api-Key'] = req.headers['x-api-key'];
    if (req.headers.authorization) forwardHeaders['Authorization'] = req.headers.authorization;
    for (const h of ['x-property-id', 'x-property-slug', 'x-site-host']) {
      if (req.headers[h]) forwardHeaders[h] = req.headers[h];
    }

    const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
    // One tool set per hotel asked for in this request; property_id wins
    // over the client's selectors (X-Property-Id outranks slug and host).
    const sets = new Map();
    const toolsFor = (propertyId) => {
      const k = propertyId ?? '';
      if (!sets.has(k)) {
        const headers = propertyId ? { ...forwardHeaders, 'x-property-id': propertyId } : forwardHeaders;
        const tools = createTools(createApiClient({ baseUrl, headers }).apiRequest);
        sets.set(k, new Map(tools.map((t) => [t.name, t])));
      }
      return sets.get(k);
    };

    const server = new McpServer({ name: 'ota', version: '1.0.0' });
    for (const tool of toolsFor(null).values()) {
      const perHotel = !ORG_TOOLS.has(tool.name);
      const inputSchema = perHotel ? { ...tool.inputSchema, property_id: PROPERTY_ARG } : tool.inputSchema;
      server.registerTool(tool.name, { description: tool.description, inputSchema }, async (args) => {
        try {
          const { property_id, ...rest } = args ?? {};
          const result = await toolsFor(perHotel ? property_id : null).get(tool.name).run(perHotel ? rest : args);
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

// Stateless: no SSE stream or session to open/close. Spec says 405 here; a 404
// makes MCP clients report the endpoint as missing.
router.all('/', (req, res) => {
  res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});

module.exports = router;
module.exports.wellKnown = wellKnown;
