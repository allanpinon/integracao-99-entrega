const crypto = require('node:crypto');
const config = require('./config');
const { request, HttpError } = require('./http');

let cached = null; // { token, expiresAt }

async function token() {
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;
  const res = await request(`${config.n99.apiBase}/entrega-openplatform/oauth/v2/token`, {
    method: 'POST',
    json: {
      client_id: config.n99.clientId,
      client_secret: config.n99.clientSecret,
      grant_type: 'client_credentials',
      scope: 'entrega.order',
    },
  });
  check(res);
  cached = { token: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in || 7200) * 1000 };
  return cached.token;
}

class N99Error extends Error {
  constructor(errno, errmsg) {
    super(`99 errno ${errno}: ${errmsg}`);
    this.errno = errno;
  }
}

function check(res) {
  if (!res || typeof res !== 'object') throw new N99Error(-1, 'resposta vazia');
  if (res.errno !== 0) throw new N99Error(res.errno, res.errmsg);
  return res.data;
}

async function call(path, opts = {}) {
  const doCall = async () => request(`${config.n99.apiBase}/entrega-openplatform${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${await token()}` },
  });
  try {
    return check(await doCall());
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      cached = null;
      return check(await doCall());
    }
    if (e instanceof HttpError && e.body && typeof e.body === 'object' && 'errno' in e.body) {
      throw new N99Error(e.body.errno, e.body.errmsg);
    }
    throw e;
  }
}

const estimate = (body) => call('/v2/order/estimate', { method: 'POST', json: body });
const create = (body) => call('/v2/order/create', { method: 'POST', json: body });
const cancel = ({ externalId, reasonId }) =>
  call('/v2/order/cancel', { method: 'POST', json: { external_order_id: externalId, reason_id: String(reasonId) } });
const detail = (externalId) =>
  call(`/v2/order/detail?external_order_id=${encodeURIComponent(externalId)}`);

// A doc diz Base64, o exemplo usa hex: aceita os dois.
function verifySignature(rawBody, signature) {
  if (!config.n99.webhookKey) return true; // sem chave configurada: não valida (só sandbox)
  if (!signature) return false;
  const mac = crypto.createHmac('sha256', config.n99.webhookKey).update(rawBody).digest();
  const candidates = [mac.toString('base64'), mac.toString('hex')];
  return candidates.some((c) => c.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(c), Buffer.from(signature)));
}

const CANCEL_REASON = {
  NO_COURIER: 410013,
  WRONG_ADDRESS: 410016,
  WRONG_CONTACT: 410017,
  NOT_NEEDED: 410018,
};

module.exports = { estimate, create, cancel, detail, verifySignature, N99Error, CANCEL_REASON, _reset: () => { cached = null; } };
