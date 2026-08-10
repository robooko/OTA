class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

function createApiClient({ baseUrl, headers }) {
  async function apiRequest(method, path, { query, body } = {}) {
    let url = `${baseUrl}${path}`;
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
        headers: { 'Content-Type': 'application/json', ...headers },
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

  return { apiRequest };
}

module.exports = { createApiClient, ApiError };
