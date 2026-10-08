class HttpError extends Error {
  constructor(message, { status, body, code } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

async function request(url, { method = 'GET', headers = {}, json, form, timeoutMs = 15000 } = {}) {
  const opts = { method, headers: { Accept: 'application/json', ...headers } };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form !== undefined) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  opts.signal = AbortSignal.timeout(timeoutMs);

  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const code = body && typeof body === 'object' ? (body.code ?? body.errno) : undefined;
    const msg = body && typeof body === 'object' ? (body.details || body.message || body.errmsg) : text;
    throw new HttpError(`${method} ${url} → ${res.status} ${msg || ''}`.trim(), { status: res.status, body, code });
  }
  return body;
}

module.exports = { request, HttpError };
