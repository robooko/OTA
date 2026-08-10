const BASE_URL = process.env.OTA_BASE_URL;
const API_KEY = process.env.OTA_API_KEY;

if (!BASE_URL) {
  throw new Error('OTA_BASE_URL is required');
}
if (!API_KEY) {
  throw new Error('OTA_API_KEY is required');
}

class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function apiRequest(method, path, { query, body } = {}) {
  let url = `${BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, value);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Failed to reach the OTA API: ${err.message}`);
  }

  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (err) {
      // non-JSON response body; leave json as null
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, json);
  }
  return json;
}

module.exports = { apiRequest, ApiError };
