export class ApiError extends Error {
  constructor(message, { status = 0, code = null, details = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Small same-origin API client shared by auth and the VPS data adapters.
 * Session cookies are always included. A CSRF token returned in either the
 * response body or x-csrf-token header is retained and sent on mutations.
 */
export function createApiClient({ baseUrl = '/api', fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');

  const origin = globalThis.location?.origin || 'http://localhost';
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`, origin);
  if (base.origin !== origin) {
    throw new TypeError('Edgebook API base must be same-origin');
  }

  let csrfToken = null;

  function setCsrfToken(value) {
    if (typeof value === 'string' && value.trim()) csrfToken = value.trim();
  }

  function urlFor(path) {
    const relative = String(path || '').replace(/^\/+/, '');
    const url = new URL(relative, base);
    if (url.origin !== origin || !url.pathname.startsWith(base.pathname)) {
      throw new TypeError('Refusing a request outside the configured Edgebook API base');
    }
    return url;
  }

  async function request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    let body = options.body;

    if (!SAFE_METHODS.has(method) && csrfToken && !headers.has('x-csrf-token')) {
      headers.set('x-csrf-token', csrfToken);
    }
    if (body != null && typeof body === 'object' && !(body instanceof FormData) &&
        !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
      headers.set('content-type', headers.get('content-type') || 'application/json');
      body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(urlFor(path), {
        ...options,
        method,
        headers,
        body,
        credentials: 'same-origin',
      });
    } catch (cause) {
      throw new ApiError('Unable to reach the Edgebook API', { code: 'NETWORK_ERROR', cause });
    }

    const contentType = response.headers.get('content-type') || '';
    let payload = null;
    if (response.status !== 204) {
      try {
        payload = contentType.includes('application/json')
          ? await response.json()
          : await response.text();
      } catch {
        payload = null;
      }
    }

    setCsrfToken(response.headers.get('x-csrf-token'));
    if (payload && typeof payload === 'object') setCsrfToken(payload.csrfToken);

    if (!response.ok) {
      const message = payload?.error?.message || payload?.error || payload?.message ||
        `Edgebook API request failed (${response.status})`;
      throw new ApiError(String(message), {
        status: response.status,
        code: payload?.error?.code || payload?.code || null,
        details: payload,
      });
    }
    return payload;
  }

  return {
    request,
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
    setCsrfToken,
    getCsrfToken: () => csrfToken,
  };
}
