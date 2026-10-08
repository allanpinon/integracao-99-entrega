const config = require('./config');
const db = require('./db');
const cw = require('./cw');
const jobs = require('./jobs');
const log = require('./log');

const ACTIVE_FOR_CANCEL = ['creating', 'finding', 'waiting'];

// Entregadores vistos em pedidos ativos (ajuda a descobrir o id do "99 Entrega" no modo legado)
const driversSeen = new Map(); // merchantId -> Map(driverId -> { display_id, at })
const lastDiag = new Map();
const warnedNoCreds = new Set();
const lastPoll = new Map();    // merchantId -> resumo do último ciclo (diagnóstico)

function noteDriver(merchantId, order) {
  if (!order.driver_id) return;
  if (!driversSeen.has(merchantId)) driversSeen.set(merchantId, new Map());
  driversSeen.get(merchantId).set(order.driver_id, { display_id: order.display_id, at: Date.now() });
}

// Um ciclo de leitura do CW para uma loja
async function pollMerchant(install) {
  const legacy = cw.isLegacy(install.merchant_id);
  if (!install.driver99_id && !legacy) {
    try {
      install.driver99_id = await cw.resolveDriver99(install.merchant_id);
      log.info('poller', `Loja ${install.name}: entregador "${config.cw.driverName}" = id ${install.driver99_id}`);
    } catch (e) {
      log.warn('poller', `Loja ${install.name}: cadastre o entregador "${config.cw.driverName}" no CW (${e.message})`);
      return;
    }
  }

  const list = await cw.listActive(install.merchant_id);
  const delivery = (list || []).filter((o) => o.order_type === 'delivery');
  const summary = { at: new Date().toISOString(), listed: (list || []).length, delivery: delivery.length, orders: [] };
  lastPoll.set(install.merchant_id, summary);
  const seen = new Set();
  let calls = 0;

  for (const lite of delivery) {
    if (calls >= config.cw.maxDetailCallsPerCycle) break;
    const job = db.jobs.latestForOrder(install.merchant_id, lite.id);
    const jobActive = job && !jobs.TERMINAL.includes(job.status);
    // Pedido já em rota com a 99: o acompanhamento vem pela 99, não precisa ler o CW
    if (jobActive && ['delivering', 'sendback'].includes(job.status)) { seen.add(lite.id); continue; }
    // Pedido já saiu com outro entregador e não é nosso: ignora
    if (!jobActive && lite.status === 'released') continue;

    calls += 1;
    let order;
    try { order = await cw.getOrder(install.merchant_id, lite.id); } catch (e) {
      log.warn('poller', `detalhe do pedido ${lite.id}: ${e.message}`);
      continue;
    }
    seen.add(order.id);
    noteDriver(install.merchant_id, order);
    summary.orders.push({ id: order.id, display_id: order.display_id, status: order.status,
      driver_id: order.driver_id ?? null, delivered_by: order.delivered_by ?? null });
    if (!install.driver99_id) continue; // modo legado ainda sem o id do entregador 99
    const is99 = order.driver_id && order.driver_id === install.driver99_id;

    // Depois de falha/recusa, libera nova tentativa quando a loja mexe no pedido:
    // troca o entregador, ou altera o pedido (ex.: marca o pagamento como pago)
    if (job && ['failed', 'rejected'].includes(job.status) && !job.rearm) {
      const touched = Date.parse(order.updated_at) > job.updated_at + 1000;
      if (!is99 || touched) {
        db.jobs.update(job.id, { rearm: 1 });
        job.rearm = 1;
      }
    }

    if (is99 && (!job || jobs.canStartAfter(install, job)) && !config.n99Ready()) {
      if (!warnedNoCreds.has(order.id)) {
        warnedNoCreds.add(order.id);
        log.warn('poller', `Pedido #${order.display_id} com "${config.cw.driverName}", mas as credenciais da 99 não estão configuradas. Nada foi chamado.`);
      }
    } else if (is99 && (!job || jobs.canStartAfter(install, job))) {
      log.info('poller', `Pedido #${order.display_id}: "${config.cw.driverName}" atribuído. Chamando motoboy.`);
      await jobs.start(install, order);
    } else if (!is99 && jobActive && ACTIVE_FOR_CANCEL.includes(job.status)) {
      await jobs.cancelByStore(job, 'loja removeu o entregador 99 no CW');
    }
  }

  // Diagnóstico enquanto falta o id do entregador 99: registra o que foi lido (só quando muda)
  if (!install.driver99_id) {
    const line = `listados=${summary.listed} delivery=${summary.delivery} ` +
      summary.orders.map((o) => `#${o.display_id}:${o.status}:entregador=${o.driver_id}`).join(' ');
    if (lastDiag.get(install.merchant_id) !== line) {
      lastDiag.set(install.merchant_id, line);
      log.info('diag', `Loja ${install.merchant_id}: ${line}`);
    }
  }

  // Corridas ativas cujo pedido sumiu da lista (cancelado/finalizado no CW)
  for (const job of db.jobs.active().filter((j) => j.merchant_id === install.merchant_id)) {
    if (seen.has(job.cw_order_id) || !ACTIVE_FOR_CANCEL.includes(job.status)) continue;
    try {
      const order = await cw.getOrder(install.merchant_id, job.cw_order_id);
      if (['canceled', 'canceling'].includes(order.status)) {
        await jobs.cancelByStore(job, 'pedido cancelado no CW');
      } else if (order.driver_id !== install.driver99_id) {
        await jobs.cancelByStore(job, 'loja removeu o entregador 99 no CW');
      }
    } catch (e) {
      log.warn('poller', `verificação do pedido ${job.cw_order_id}: ${e.message}`);
    }
  }
}

async function pollAll() {
  for (const install of db.installs.all()) {
    try { await pollMerchant(install); } catch (e) {
      log.error('poller', `Loja ${install.name || install.merchant_id}: ${e.message}`);
    }
  }
}

// Fallback do webhook da 99 (que não tem entrega garantida)
async function reconcileAll() {
  for (const job of db.jobs.active()) {
    try { await jobs.sync(job); } catch (e) { log.warn('reconcile', `${job.external_id}: ${e.message}`); }
  }
}

function loop(fn, ms, name) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (e) { log.error(name, e.message); } finally { running = false; }
  };
  setTimeout(tick, 2000);
  return setInterval(tick, ms);
}

function startLoops() {
  return [
    loop(pollAll, config.cw.pollIntervalMs, 'poller'),
    loop(reconcileAll, config.n99.reconcileIntervalMs, 'reconcile'),
    setInterval(() => db.events.prune(), 6 * 3600 * 1000),
  ];
}

module.exports = { lastPoll, driversSeen, pollMerchant, pollAll, reconcileAll, startLoops };
