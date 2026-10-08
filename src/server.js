const express = require('express');
const config = require('./config');
const db = require('./db');
const cw = require('./cw');
const n99 = require('./n99');
const jobs = require('./jobs');
const poller = require('./poller');
const log = require('./log');
const { request } = require('./http');

function buildApp() {
  const app = express();

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // URL de instalação do app no CW: manda o Proprietário para a tela de autorização
  app.get('/cw/install', (_req, res) => {
    if (!config.cw.clientId) return res.status(500).send('CW_CLIENT_ID não configurado');
    res.redirect(cw.buildAuthorizeUrl());
  });

  // Redirect URI do OAuth
  app.get('/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(page('Autorização não concluída', String(error)));
    try {
      const { merchant, driverId } = await cw.exchangeCode(String(code), String(state));
      log.info('oauth', `Loja instalada: ${merchant.name} (${merchant.id})`);
      const driverMsg = driverId
        ? `Entregador "${config.cw.driverName}" encontrado (id ${driverId}).`
        : `Atenção: cadastre um entregador ativo chamado "${config.cw.driverName}" no Cardápio Web.`;
      res.send(page('Integração ativa', `${merchant.name} conectada à 99 Entrega. ${driverMsg}`));
    } catch (e) {
      log.error('oauth', e.message);
      res.status(400).send(page('Falha na instalação', e.message));
    }
  });

  // URL de login do app: status resumido
  app.get('/cw/login', (_req, res) => {
    const list = db.installs.all().map((i) => `${i.name} — entregador 99: ${i.driver99_id ? 'ok' : 'não cadastrado'}`);
    res.send(page('Integração 99 Entrega', list.length ? list.join('<br>') : 'Nenhuma loja instalada.'));
  });

  // Webhook da 99 (corpo bruto para validar a assinatura)
  app.post('/webhooks/99', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    if (!n99.verifySignature(raw, req.get('X-Webhook-Signature'))) {
      log.warn('webhook99', 'assinatura inválida');
      return res.status(401).send('invalid signature');
    }
    let evt;
    try { evt = JSON.parse(raw); } catch { return res.status(400).send('invalid json'); }
    res.status(200).send('ok');
    if (evt.event_id && !db.events.markSeen(evt.event_id)) return; // duplicado
    jobs.handleWebhook(evt).catch((e) => log.error('webhook99', e.message));
  });

  // Painel técnico (JSON). Protegido por ADMIN_TOKEN.
  app.get('/status', (req, res) => {
    if (!config.adminToken || req.query.token !== config.adminToken) return res.status(401).send('unauthorized');
    res.json({
      installs: db.installs.all().map(({ access_token, refresh_token, ...rest }) => rest),
      drivers_seen: Object.fromEntries([...poller.driversSeen.entries()].map(([m, map]) =>
        [m, [...map.entries()].map(([id, v]) => ({ driver_id: id, display_id: v.display_id }))])),
      last_poll: Object.fromEntries(poller.lastPoll.entries()),
      jobs: db.jobs.recent(Number(req.query.limit || 50)),
    });
  });

  // Painel da loja: corridas recentes (atualiza a cada 15 s). Protegido por ADMIN_TOKEN.
  app.get('/painel', (req, res) => {
    const ok = [config.adminToken, config.painelToken].filter(Boolean).includes(req.query.token);
    if (!ok) return res.status(401).send('unauthorized');
    res.send(painel());
  });

  return app;
}

const STATUS_PT = {
  creating: 'Criando corrida', finding: 'Procurando motoboy', waiting: 'Motoboy a caminho da loja',
  delivering: 'Em entrega', sendback: 'Devolvendo à loja', done: 'Concluída',
  failed: 'Sem motoboy / falhou', canceled: 'Cancelada', rejected: 'Recusada',
};
const COLOR = { done: '#0F6E56', failed: '#A32D2D', rejected: '#A32D2D', canceled: '#5F5E5A' };
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const brl = (c) => (c == null ? '—' : `R$ ${(c / 100).toFixed(2).replace('.', ',')}`);
const hora = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

function painel() {
  const installs = db.installs.all();
  const names = Object.fromEntries(installs.map((i) => [i.merchant_id, i.name]));
  const rows = db.jobs.recent(40).map((j) => `
    <tr>
      <td>${hora(j.created_at)}</td>
      <td>${esc(names[j.merchant_id] || j.merchant_id)}</td>
      <td><b>#${esc(j.display_id)}</b></td>
      <td style="color:${COLOR[j.status] || 'inherit'}">${esc(STATUS_PT[j.status] || j.status)}</td>
      <td>${brl(j.final_fee_cents ?? j.quoted_fee_cents)}</td>
      <td>${j.distance_m ? `${(j.distance_m / 1000).toFixed(1).replace('.', ',')} km` : '—'}</td>
      <td>${esc(j.n99_order_id || '—')}</td>
      <td class="m">${esc(j.error && !String(j.error).startsWith('incerto') ? j.error : '')}</td>
    </tr>`).join('');

  const setup = installs.filter((i) => !i.driver99_id).map((i) => {
    const seen = [...(poller.driversSeen.get(i.merchant_id) || new Map()).entries()]
      .map(([id, v]) => `<li>Entregador id <b>${id}</b> — visto no pedido #${esc(v.display_id)}</li>`).join('');
    return `<div class="box"><b>${esc(i.name)}: falta o id do entregador "${esc(config.cw.driverName)}".</b>
      <p>Atribua "${esc(config.cw.driverName)}" a um pedido de delivery em preparo e aguarde 30 s. O id aparece aqui:</p>
      <ul>${seen || '<li>nenhum entregador visto ainda</li>'}</ul></div>`;
  }).join('');

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>Corridas 99 Entrega</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#fafaf8;color:#2c2c2a}
  h2{font-weight:500;margin:0 0 12px} table{border-collapse:collapse;width:100%;background:#fff}
  th,td{padding:8px 10px;border-bottom:1px solid #e8e6df;text-align:left;font-size:14px;white-space:nowrap}
  th{font-weight:500;color:#5f5e5a} td.m{white-space:normal;color:#5f5e5a;font-size:13px}
  .box{background:#faeeda;border:1px solid #ef9f27;border-radius:8px;padding:12px;margin-bottom:12px}
  .wrap{overflow-x:auto}
</style>
<h2>Corridas 99 Entrega</h2>${setup}
<div class="wrap"><table><tr><th>Hora</th><th>Loja</th><th>Pedido</th><th>Status</th><th>Taxa</th><th>Distância</th><th>Corrida 99</th><th>Observação</th></tr>
${rows || '<tr><td colspan="8">Nenhuma corrida ainda.</td></tr>'}</table></div>`;
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><body style="font-family:system-ui;max-width:560px;margin:48px auto;padding:0 16px">
<h2>${title}</h2><p>${body}</p></body>`;
}

function bootLegacyStores() {
  for (const st of config.legacyStores) {
    db.installs.upsertLegacy({ merchant_id: st.merchantId, driver99_id: st.driverId });
    log.info('boot', `Loja ${st.merchantId} no modo token legado${st.driverId ? ` (entregador 99 = id ${st.driverId})` : ' (id do entregador 99 pendente)'}`);
    request(`${config.cw.apiBase}/api/partner/v1/merchant`, { headers: { 'X-API-KEY': st.apiKey } })
      .then((m) => m?.name && db.installs.setName(st.merchantId, m.name))
      .catch((e) => log.warn('boot', `Loja ${st.merchantId}: token não validado (${e.message})`));
  }
}

if (require.main === module) {
  for (const k of ['N99_CLIENT_ID', 'N99_CLIENT_SECRET', 'BASE_URL']) config.req(k);
  if (!config.legacyStores.length) config.req('CW_CLIENT_ID');
  if (!config.n99.webhookKey) log.warn('boot', 'N99_WEBHOOK_KEY vazio: assinatura do webhook da 99 NÃO será validada');
  db.open();
  bootLegacyStores();
  buildApp().listen(config.port, () => log.info('boot', `Rodando na porta ${config.port} (${config.baseUrl})`));
  poller.startLoops();
  if (config.n99Ready()) {
    n99.ping()
      .then(() => log.info('boot', `Credenciais da 99 válidas (${config.n99.apiBase})`))
      .catch((e) => log.error('boot', `Credenciais da 99 recusadas: ${e.message}`));
  } else {
    log.warn('boot', 'Credenciais da 99 não configuradas: nenhuma corrida será chamada');
  }
}

module.exports = { buildApp, bootLegacyStores };
