// Simula Cardápio Web e 99 Entrega com servidores falsos e roda o fluxo completo.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const WEBHOOK_KEY = 'chave-teste';

// ---------- Estado dos mocks ----------
const calls = [];
const cwOrders = new Map();
const n99Orders = new Map(); // external_id -> { status, order_id, fee }
let feeCents = 1290;

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

const cwServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await readBody(req);
  const legacy = req.headers['x-api-key'] === 'leg';
  const merchant = legacy ? 2 : 1;
  calls.push({ api: 'cw', method: req.method, path: url.pathname, legacy, body: body ? JSON.parse(body) : null });
  const p = url.pathname.replace('/api/partner/v1', '');
  if (p === '/merchant') return json(res, 200, { id: merchant, name: legacy ? 'Loja Legado' : 'Loja OAuth' });
  if (p.endsWith('/driver') && legacy) return json(res, 401, { code: 4010, message: 'API Key não aceita' });
  if (p === '/orders' && req.method === 'GET') {
    return json(res, 200, [...cwOrders.values()].filter((o) => o.merchant_id === merchant)
      .filter((o) => ['confirmed', 'ready', 'scheduled_confirmed', 'released'].includes(o.status))
      .map(({ id, status, order_type }) => ({ id, status, order_type })));
  }
  const m = p.match(/^\/orders\/(\d+)(?:\/(\w+))?$/);
  if (m) {
    const o = cwOrders.get(Number(m[1]));
    if (!o) return json(res, 404, { code: 4041 });
    const action = m[2];
    if (!action) return json(res, 200, o);
    if (action === 'driver' && req.method === 'PUT') { const b = JSON.parse(body); o.driver_id = b.driver_id; if ('driver_fee' in b) o.driver_fee = b.driver_fee; return json(res, 200, o); }
    if (action === 'driver' && req.method === 'DELETE') { o.driver_id = null; o.driver_fee = null; res.writeHead(204); return res.end(); }
    const trans = { prepared: ['confirmed', 'ready'], dispatch: ['ready', 'released'], delivered: ['released', 'delivered'] }[action];
    if (trans) {
      if (o.status !== trans[0]) return json(res, 400, { code: 4003, message: 'transição inválida' });
      o.status = trans[1]; res.writeHead(204); return res.end();
    }
  }
  if (p === '/drivers') return json(res, 200, { data: [{ id: 7, name: 'Juan', status: 'active' }, { id: 99, name: '99 Entrega', status: 'active' }], meta: {} });
  json(res, 404, { code: 4041 });
});

const n99Server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await readBody(req);
  const b = body ? JSON.parse(body) : null;
  const p = url.pathname.replace('/entrega-openplatform', '');
  calls.push({ api: '99', method: req.method, path: p, body: b });
  if (p === '/oauth/v2/token') return json(res, 200, { errno: 0, data: { access_token: 't99', expires_in: 7200 } });
  if (p === '/v2/order/estimate') {
    assert.ok(b.dropoff_info.structured_address.cep, 'cep obrigatório');
    return json(res, 200, { errno: 0, data: { id: `est-${b.external_order_id}`, fee: feeCents, currency: 'R$', delivery_distance: 3200, delivery_duration: 18 } });
  }
  if (p === '/v2/order/create') {
    assert.match(b.dropoff_info.phone, /^\d{11}$/);
    assert.equal(b.pickup_info.structured_address.cep, '04203-052');
    const order_id = `880${n99Orders.size + 1}`;
    n99Orders.set(b.external_order_id, { status: 'finding', order_id, fee: feeCents });
    return json(res, 200, { errno: 0, data: { order_id, external_order_id: b.external_order_id } });
  }
  if (p === '/v2/order/cancel') {
    const o = n99Orders.get(b.external_order_id);
    if (!o) return json(res, 200, { errno: 6201, errmsg: 'not exist' });
    if (o.status === 'delivering') return json(res, 200, { errno: 4001, errmsg: 'not allowed' });
    o.status = 'canceled';
    return json(res, 200, { errno: 0, errmsg: 'success' });
  }
  if (p === '/v2/order/detail') {
    const ext = url.searchParams.get('external_order_id');
    const o = n99Orders.get(ext);
    if (!o) return json(res, 200, { errno: 6201, errmsg: 'not exist' });
    return json(res, 200, { errno: 0, data: { order_id: o.order_id, new_order_id: '', external_order_id: ext, status: o.status, price_info: { fee: o.fee, currency: 'R$' } } });
  }
  json(res, 404, {});
});

const listen = (s) => new Promise((r) => s.listen(0, () => r(s.address().port)));

let app, appServer, appPort, db, poller, jobs, rules;

test.before(async () => {
  const cwPort = await listen(cwServer);
  const n99Port = await listen(n99Server);
  process.env.CW_API_BASE = `http://127.0.0.1:${cwPort}`;
  process.env.N99_API_BASE = `http://127.0.0.1:${n99Port}`;
  process.env.N99_WEBHOOK_KEY = WEBHOOK_KEY;
  process.env.CW_CLIENT_ID = 'cw-test';
  process.env.CW_LEGACY_STORES = '2:leg:';
  db = require('../src/db');
  db.open(':memory:');
  poller = require('../src/poller');
  jobs = require('../src/jobs');
  rules = require('../src/rules');
  app = require('../src/server').buildApp();
  appServer = app.listen(0);
  appPort = appServer.address().port;
  require('../src/server').bootLegacyStores();
  db.installs.upsert({ merchant_id: 1, name: 'Vai Um Açaí CW01', access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3600e3 });
});

test.after(() => { appServer.close(); cwServer.close(); n99Server.close(); });

function order(id, extra = {}) {
  const o = {
    id, display_id: 22000 + id, merchant_id: extra.merchant_id || 1, status: 'confirmed', order_type: 'delivery', delivered_by: 'merchant',
    driver_id: null, driver_fee: null, delivery_fee: 7, observation: null,
    customer: { id: 1, name: 'Allan Pinon', phone: '11933393344', ddi: '55' },
    delivery_address: { street: 'Rua Coronel Francisco Inácio', number: '43', neighborhood: 'Vila Moinho Velho', complement: '', reference: 'Portão azul', postal_code: '04286000', city: 'São Paulo', state: 'SP', latitude: '-23.6040', longitude: '-46.6000' },
    payments: [{ total: 70, payment_type: 'online', payment_method: 'online_credit_card', status: 'paid' }],
    ...extra,
  };
  cwOrders.set(id, o);
  return o;
}

async function webhook(event, external) {
  const raw = JSON.stringify({ event, event_id: crypto.randomUUID(), message: JSON.stringify({ external_order_id: external }), timestamp: 1 });
  const sig = crypto.createHmac('sha256', WEBHOOK_KEY).update(raw).digest('base64');
  const r = await fetch(`http://127.0.0.1:${appPort}/webhooks/99`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig } });
  assert.equal(r.status, 200);
  await new Promise((r2) => setTimeout(r2, 150));
}
const pathsOf = (api) => calls.filter((c) => c.api === api).map((c) => `${c.method} ${c.path}`);

test('regras: celular, CEP por faixa', () => {
  assert.equal(rules.normalizeMobile('(11) 93339-3344'), '11933393344');
  assert.equal(rules.normalizeMobile('5511933393344'), '11933393344');
  assert.equal(rules.normalizeMobile('1133334444'), null);
  assert.equal(rules.normalizeMobile('11933393344', '1'), null);
  assert.ok(rules.inRange('de 1483 a 2401 - lado ímpar', 1899));
  assert.ok(!rules.inRange('de 1482 a 2400 - lado par', 1899));
  assert.ok(rules.inRange('até 931 - lado ímpar', 43));
});

test('fluxo feliz: atribui 99 → cria corrida → taxa no CW → saída → entregue', async () => {
  order(1);
  await poller.pollAll();
  assert.equal(db.installs.byId(1).driver99_id, 99, 'descobre o id do entregador 99');
  let job = db.jobs.latestForOrder(1, 1);
  assert.equal(job, undefined, 'sem atribuição não chama motoboy');

  cwOrders.get(1).driver_id = 99; // loja escolhe "99 Entrega"
  cwOrders.get(1).driver_fee = 6.5;
  await poller.pollAll();
  job = db.jobs.latestForOrder(1, 1);
  assert.equal(job.status, 'finding');
  assert.equal(job.quoted_fee_cents, 1290);
  assert.equal(cwOrders.get(1).driver_fee, 12.9, 'taxa real gravada no CW');
  assert.equal(cwOrders.get(1).driver_id, 99);

  await poller.pollAll(); // segundo ciclo não duplica
  assert.equal(pathsOf('99').filter((p) => p.endsWith('/v2/order/create')).length, 1);

  n99Orders.get(job.external_id).status = 'waiting';
  await webhook('DriverAccepted', job.external_id);
  assert.equal(db.jobs.byId(job.id).status, 'waiting');

  n99Orders.get(job.external_id).status = 'delivering';
  await webhook('DriverBeginCharge', job.external_id);
  assert.equal(cwOrders.get(1).status, 'released', 'CW: saiu para entrega');

  n99Orders.get(job.external_id).status = 'completed';
  n99Orders.get(job.external_id).fee = 1350;
  await webhook('OrderCompleted', job.external_id);
  job = db.jobs.byId(job.id);
  assert.equal(job.status, 'done');
  assert.equal(job.final_fee_cents, 1350);
  assert.equal(cwOrders.get(1).status, 'delivered', 'CW: entregue');
  assert.equal(cwOrders.get(1).driver_fee, 13.5, 'taxa final atualizada');
});

test('pagamento na entrega não pago: recusa e remove o entregador', async () => {
  order(2, { driver_id: 99, payments: [{ total: 30, payment_type: 'offline', payment_method: 'money', status: 'pending' }] });
  await poller.pollAll();
  const job = db.jobs.latestForOrder(1, 2);
  assert.equal(job.status, 'rejected');
  assert.equal(cwOrders.get(2).driver_id, null);
});

test('loja remove o "99 Entrega" antes da coleta: cancela na 99', async () => {
  order(3, { driver_id: 99 });
  await poller.pollAll();
  const job = db.jobs.latestForOrder(1, 3);
  assert.equal(job.status, 'finding');
  cwOrders.get(3).driver_id = 7; // trocou para o Juan
  await poller.pollAll();
  assert.equal(db.jobs.byId(job.id).status, 'canceled');
  assert.equal(n99Orders.get(job.external_id).status, 'canceled');
});

test('pedido cancelado no CW: cancela na 99', async () => {
  order(4, { driver_id: 99 });
  await poller.pollAll();
  const job = db.jobs.latestForOrder(1, 4);
  cwOrders.get(4).status = 'canceled';
  await poller.pollAll();
  assert.equal(db.jobs.byId(job.id).status, 'canceled');
});

test('ninguém aceitou: cancela, devolve ao CW e permite nova tentativa', async () => {
  order(5, { driver_id: 99 });
  await poller.pollAll();
  const job = db.jobs.latestForOrder(1, 5);
  await webhook('BroadcastTimeout', job.external_id);
  assert.equal(db.jobs.byId(job.id).status, 'failed');
  assert.equal(cwOrders.get(5).driver_id, null, 'volta a "Sem entregador"');

  cwOrders.get(5).driver_id = 99; // loja tenta de novo
  await poller.pollAll();
  const retry = db.jobs.latestForOrder(1, 5);
  assert.equal(retry.attempt, 2);
  assert.equal(retry.status, 'finding');
});

test('reconciliação sem webhook: 99 encerrou a corrida', async () => {
  order(6, { driver_id: 99 });
  await poller.pollAll();
  const job = db.jobs.latestForOrder(1, 6);
  n99Orders.get(job.external_id).status = 'closed';
  await poller.reconcileAll();
  assert.equal(db.jobs.byId(job.id).status, 'failed');
  assert.equal(cwOrders.get(6).driver_id, null);
});

test('pedido de marketplace com entrega da plataforma é ignorado', async () => {
  order(7, { driver_id: 99, delivered_by: 'keeta' });
  await poller.pollAll();
  assert.equal(db.jobs.latestForOrder(1, 7).status, 'rejected');
});

test('webhook com assinatura inválida é recusado', async () => {
  const r = await fetch(`http://127.0.0.1:${appPort}/webhooks/99`, { method: 'POST', body: '{"event":"x"}', headers: { 'X-Webhook-Signature': 'errada' } });
  assert.equal(r.status, 401);
});

// ---------- Modo token legado (sem app OAuth) ----------

test('legado: sem id do entregador 99, só observa e mostra no painel', async () => {
  order(101, { merchant_id: 2, driver_id: 55 });
  await poller.pollAll();
  assert.equal(db.jobs.latestForOrder(2, 101), undefined);
  assert.ok(poller.driversSeen.get(2).has(55), 'id 55 aparece para configuração');
  const r = await fetch(`http://127.0.0.1:${appPort}/painel?token=painel`);
  assert.equal(r.status, 401, 'painel exige token');
});

test('legado: chama motoboy, atualiza status e nunca tenta gravar entregador', async () => {
  db.get().prepare('UPDATE installs SET driver99_id=55 WHERE merchant_id=2').run();
  const before = calls.filter((c) => c.legacy && c.path.endsWith('/driver')).length;
  await poller.pollAll();
  let job = db.jobs.latestForOrder(2, 101);
  assert.equal(job.status, 'finding');
  assert.equal(job.external_id, 'CW2-101-1');
  n99Orders.get(job.external_id).status = 'delivering';
  await webhook('DriverBeginCharge', job.external_id);
  assert.equal(cwOrders.get(101).status, 'released');
  n99Orders.get(job.external_id).status = 'completed';
  await webhook('OrderCompleted', job.external_id);
  assert.equal(db.jobs.byId(job.id).status, 'done');
  assert.equal(cwOrders.get(101).status, 'delivered');
  assert.equal(calls.filter((c) => c.legacy && c.path.endsWith('/driver')).length, before, 'nenhuma chamada de entregador');
});

test('legado: após falha não repete sozinho; repete quando a loja troca e volta para 99', async () => {
  order(102, { merchant_id: 2, driver_id: 55 });
  await poller.pollAll();
  const job = db.jobs.latestForOrder(2, 102);
  n99Orders.get(job.external_id).status = 'closed';
  await poller.reconcileAll();
  assert.equal(db.jobs.byId(job.id).status, 'failed');
  assert.equal(cwOrders.get(102).driver_id, 55, 'entregador continua (API Key não remove)');

  await poller.pollAll();
  assert.equal(db.jobs.latestForOrder(2, 102).attempt, 1, 'sem nova tentativa automática');

  cwOrders.get(102).driver_id = 7; await poller.pollAll(); // loja troca
  cwOrders.get(102).driver_id = 55; await poller.pollAll(); // e volta para 99
  const retry = db.jobs.latestForOrder(2, 102);
  assert.equal(retry.attempt, 2);
  assert.equal(retry.status, 'finding');
});
