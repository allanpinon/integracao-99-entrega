const express = require('express');
const config = require('./config');
const db = require('./db');
const cw = require('./cw');
const n99 = require('./n99');
const jobs = require('./jobs');
const poller = require('./poller');
const log = require('./log');

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
      jobs: db.jobs.recent(Number(req.query.limit || 50)),
    });
  });

  return app;
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><body style="font-family:system-ui;max-width:560px;margin:48px auto;padding:0 16px">
<h2>${title}</h2><p>${body}</p></body>`;
}

if (require.main === module) {
  for (const k of ['CW_CLIENT_ID', 'N99_CLIENT_ID', 'N99_CLIENT_SECRET', 'BASE_URL']) config.req(k);
  if (!config.n99.webhookKey) log.warn('boot', 'N99_WEBHOOK_KEY vazio: assinatura do webhook da 99 NÃO será validada');
  db.open();
  buildApp().listen(config.port, () => log.info('boot', `Rodando na porta ${config.port} (${config.baseUrl})`));
  poller.startLoops();
}

module.exports = { buildApp };
