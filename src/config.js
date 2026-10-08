const env = process.env;

function req(name) {
  const v = env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

const cwEnv = (env.CW_ENV || 'sandbox').toLowerCase();

const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: env.DATA_DIR || './data',
  adminToken: env.ADMIN_TOKEN || '',
  painelToken: env.PAINEL_TOKEN || '',

  cw: {
    apiBase: env.CW_API_BASE || (cwEnv === 'production'
      ? 'https://integracao.cardapioweb.com'
      : 'https://integracao.sandbox.cardapioweb.com'),
    portalAuthUrl: env.CW_PORTAL_AUTH_URL || (cwEnv === 'production'
      ? 'https://portal.cardapioweb.com/cw-apps'
      : 'https://portal.sandbox.cardapioweb.com/cw-apps'),
    clientId: env.CW_CLIENT_ID || '',
    driverName: env.CW_DRIVER_NAME || '99 Entrega',
    pollIntervalMs: Number(env.CW_POLL_INTERVAL_MS || 30000),
    maxDetailCallsPerCycle: Number(env.CW_MAX_DETAIL_PER_CYCLE || 40),
  },

  n99: {
    apiBase: env.N99_API_BASE || 'https://entrega.99app.com',
    clientId: env.N99_CLIENT_ID || '',
    clientSecret: env.N99_CLIENT_SECRET || '',
    webhookKey: env.N99_WEBHOOK_KEY || '',
    vehicleType: env.N99_VEHICLE_TYPE || 'entrega_moto',
    packageType: env.N99_PACKAGE_TYPE || 'food',
    packageWeight: env.N99_PACKAGE_WEIGHT || '5kg',
    needPickupCode: (env.N99_NEED_PICKUP_CODE || 'false') === 'true',
    needDropoffCode: (env.N99_NEED_DROPOFF_CODE || 'false') === 'true',
    returnType: Number(env.N99_RETURN_TYPE || 2),
    reconcileIntervalMs: Number(env.N99_RECONCILE_INTERVAL_MS || 60000),
  },

  pickup: {
    street: env.PICKUP_STREET || 'Rua Bom Pastor',
    number: env.PICKUP_NUMBER || '1899',
    complement: env.PICKUP_COMPLEMENT || 'Vai Um Açaí',
    neighborhood: env.PICKUP_NEIGHBORHOOD || 'Ipiranga',
    city: env.PICKUP_CITY || 'São Paulo',
    state: env.PICKUP_STATE || 'SP',
    country: env.PICKUP_COUNTRY || 'Brasil',
    cep: env.PICKUP_CEP || '04203-052',
    name: env.PICKUP_NAME || 'Vai Um Açaí? - Açaí do Pará Artesanal',
    phone: env.PICKUP_PHONE || '11933393344',
    lat: env.PICKUP_LAT ? Number(env.PICKUP_LAT) : null,
    lng: env.PICKUP_LNG ? Number(env.PICKUP_LNG) : null,
  },

  rules: {
    // false = só despacha pedidos pagos online ou marcados como "pago" no CW
    allowUnpaidOffline: (env.ALLOW_UNPAID_OFFLINE || 'false') === 'true',
  },
};

// Lojas no modo token legado (API Key do Portal), sem app OAuth.
// Formato: "codigoLoja:token:idEntregador99,codigoLoja2:token2:idEntregador99"
// O id do entregador pode ficar vazio no início ("12493:token:"); o painel ajuda a descobrir.
config.legacyStores = (env.CW_LEGACY_STORES || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => {
    const [merchantId, apiKey, driverId] = s.split(':').map((x) => (x || '').trim());
    return { merchantId: Number(merchantId), apiKey, driverId: driverId ? Number(driverId) : null };
  })
  .filter((s) => s.merchantId && s.apiKey);

config.legacyKey = (merchantId) => config.legacyStores.find((s) => s.merchantId === Number(merchantId))?.apiKey;

config.req = req;
module.exports = config;
