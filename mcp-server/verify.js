const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function main() {
  const apiKey = process.env.OTA_API_KEY;
  const baseUrl = process.env.OTA_BASE_URL;
  if (!apiKey || !baseUrl) {
    console.error('Set OTA_API_KEY and OTA_BASE_URL before running this script.');
    process.exit(1);
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, 'index.js')],
    env: { ...process.env, OTA_API_KEY: apiKey, OTA_BASE_URL: baseUrl },
  });
  const client = new Client({ name: 'ota-mcp-verify', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log('TOOL_COUNT:', tools.length);
  console.log('TOOL_NAMES:', JSON.stringify(tools.map((t) => t.name)));

  console.log('--- create_guest ---');
  const guestResult = await client.callTool({
    name: 'create_guest',
    arguments: { first_name: 'MCP', last_name: 'Verify', email: `mcp.verify.${Date.now()}@example.com` },
  });
  console.log(JSON.stringify(guestResult));
  const guest = JSON.parse(guestResult.content[0].text);

  console.log('--- search_availability (no property_id needed) ---');
  const searchResult = await client.callTool({
    name: 'search_availability',
    arguments: { check_in: '2026-09-01', check_out: '2026-09-03', guests: 2 },
  });
  console.log(JSON.stringify(searchResult));

  console.log('--- list_bookings ---');
  const listResult = await client.callTool({ name: 'list_bookings', arguments: {} });
  console.log(JSON.stringify(listResult));

  console.log('--- create_room_type with missing required field (expect isError) ---');
  const badResult = await client.callTool({
    name: 'create_room_type',
    arguments: { name: 'Bad Type', max_occupancy: 2 },
  });
  console.log(JSON.stringify(badResult));

  console.log('--- get_booking with a fake id (expect isError, Booking not found) ---');
  const notFoundResult = await client.callTool({
    name: 'get_booking',
    arguments: { id: '00000000-0000-0000-0000-000000000000' },
  });
  console.log(JSON.stringify(notFoundResult));

  console.log('GUEST_ID:', guest.id);
  process.exit(0);
}

main().catch((err) => {
  console.error('VERIFY_FAILED', err);
  process.exit(1);
});
