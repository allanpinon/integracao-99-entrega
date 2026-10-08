const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const { request, HttpError } = require('./http');
const log = require('./log');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- OAuth (instalação do app privado) ----------

function buildAuthorizeUrl() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  db.states.put(state, verifier);
  const url = new URL(config.cw.portalAuthUrl);
  url.searchParams.set('client_id', config.cw.clientId);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function redirectUri() {
  return `${config.baseUrl}/oauth/callback`;
}

async function exchangeCode(code, state) {
  const st = db.states.take(state);
  if (!st) throw new Error('state inválido ou expirado');
  const tok = await request(`${config.cw.apiBase}/api/partner/oauth/token`, {
    method: 'POST',
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: config.cw.clientId,
      code_verifier: st.verifier,
    },
  });
  const accessToken = tok.access_token;
  const merchant = await request(`${config.cw.apiBase}/api/partner/v1/merchant`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  db.installs.upsert({
    merchant_id: merchant.id,
    name: merchant.name,
    access_token: accessToken,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 7200) * 1000,
  });
  const driverId = await resolveDriver99(merchant.id).catch((e) => {
    log.warn('cw', `Não encontrei o entregador "${config.cw.driverName}" na loja ${merchant.id}: ${e.message}`);
    return null;
  });
  return { merchant, driverId };
}

async function refresh(install) {
  if (!install.refresh_token) throw new Error(`Loja ${install.merchant_id} sem refresh_token; reinstale o app`);
  const tok = await request(`${config.cw.apiBase}/api/partner/oauth/token`, {
    method: 'POST',
    form: { grant_type: 'refresh_token', refresh_token: install.refresh_token, client_id: config.cw.clientId },
  });
  const t = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 7200) * 1000,
  };
  db.installs.updateTokens(install.merchant_id, t);
  return { ...install, ...t };
}

async function tokenFor(merchantId) {
  let inst = db.installs.byId(merchantId);
  if (!inst || !inst.active) throw new Error(`Loja ${merchantId} não instalada`);
  if (inst.expires_at - Date.now() < 5 * 60 * 1000) inst = await refresh(inst);
  return inst.access_token;
}

// Chamada autenticada com 1 nova tentativa em 401 (token revogado/expirado)
async function api(merchantId, path, opts = {}) {
  const call = async () => request(`${config.cw.apiBase}/api/partner/v1${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${await tokenFor(merchantId)}` },
  });
  try {
    return await call();
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      await refresh(db.installs.byId(merchantId));
      return call();
    }
    throw e;
  }
}

// ---------- Entregador "99 Entrega" ----------

async function resolveDriver99(merchantId) {
  const q = new URLSearchParams({ 'filters[name_cont]': config.cw.driverName, per_page: '100' });
  const res = await api(merchantId, `/drivers?${q}`);
  const wanted = config.cw.driverName.trim().toLowerCase();
  const found = (res.data || []).find((d) => d.name.trim().toLowerCase() === wanted && d.status === 'active');
  if (!found) throw new Error('entregador não cadastrado ou inativo');
  db.installs.setDriver(merchantId, found.id);
  return found.id;
}

// ---------- Pedidos ----------

const listActive = (merchantId) => {
  const q = ['confirmed', 'ready', 'scheduled_confirmed', 'released']
    .map((s) => `status[]=${s}`).join('&');
  return api(merchantId, `/orders?${q}`);
};

const getOrder = (merchantId, orderId) => api(merchantId, `/orders/${orderId}`);

const setDriver = (merchantId, orderId, driverId, feeReais) =>
  api(merchantId, `/orders/${orderId}/driver`, {
    method: 'PUT',
    json: feeReais === undefined ? { driver_id: driverId } : { driver_id: driverId, driver_fee: feeReais },
  });

const removeDriver = (merchantId, orderId) =>
  api(merchantId, `/orders/${orderId}/driver`, { method: 'DELETE' });

const prepared = (merchantId, orderId) => api(merchantId, `/orders/${orderId}/prepared`, { method: 'POST' });
const dispatch = (merchantId, orderId) => api(merchantId, `/orders/${orderId}/dispatch`, { method: 'POST' });
const delivered = (merchantId, orderId) => api(merchantId, `/orders/${orderId}/delivered`, { method: 'POST' });

// Leva o pedido até "released" partindo de confirmed/ready
async function ensureReleased(merchantId, orderId) {
  const order = await getOrder(merchantId, orderId);
  if (order.status === 'released' || order.status === 'delivered' || order.status === 'closed') return order.status;
  if (order.status === 'confirmed') await prepared(merchantId, orderId);
  if (['confirmed', 'ready'].includes(order.status)) {
    await dispatch(merchantId, orderId);
    return 'released';
  }
  throw new Error(`Pedido ${orderId} em status ${order.status}; não é possível marcar saída`);
}

async function ensureDelivered(merchantId, orderId) {
  const status = await ensureReleased(merchantId, orderId);
  if (status === 'released') await delivered(merchantId, orderId);
}

module.exports = {
  buildAuthorizeUrl, exchangeCode, refresh, resolveDriver99,
  listActive, getOrder, setDriver, removeDriver, prepared, dispatch, delivered,
  ensureReleased, ensureDelivered,
};
