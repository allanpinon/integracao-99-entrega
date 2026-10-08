const config = require('./config');
const db = require('./db');
const cw = require('./cw');
const n99 = require('./n99');
const rules = require('./rules');
const log = require('./log');

const TERMINAL = ['done', 'failed', 'canceled', 'rejected'];
const locks = new Set();

async function withLock(key, fn) {
  if (locks.has(key)) return;
  locks.add(key);
  try { return await fn(); } finally { locks.delete(key); }
}

const cents = (v) => (v == null ? null : Math.round(Number(v)));
const reais = (c) => Math.round(c) / 100;

async function safe(label, fn) {
  try { return await fn(); } catch (e) { log.warn('jobs', `${label}: ${e.message}`); return undefined; }
}

// ---------- Início: loja atribuiu "99 Entrega" ----------

async function start(install, order) {
  return withLock(`${install.merchant_id}:${order.id}`, async () => {
    const latest = db.jobs.latestForOrder(install.merchant_id, order.id);
    if (latest && !TERMINAL.includes(latest.status)) return latest;
    const attempt = (latest?.attempt || 0) + 1;
    const job = db.jobs.create({
      merchant_id: install.merchant_id,
      cw_order_id: order.id,
      display_id: order.display_id,
      attempt,
      external_id: `CW${install.merchant_id}-${order.id}-${attempt}`,
      cw_delivery_fee: order.delivery_fee,
    });
    const tag = `pedido #${order.display_id} (${job.external_id})`;

    const check = rules.checkOrder(order);
    if (!check.ok) {
      db.jobs.update(job.id, { status: 'rejected', error: check.reason });
      log.warn('jobs', `${tag} recusado: ${check.reason}. Entregador removido no CW.`);
      await safe(`${tag} remover entregador`, () => cw.removeDriver(install.merchant_id, order.id));
      return db.jobs.byId(job.id);
    }

    try {
      const pickup_info = rules.pickupInfo(order.display_id);
      const dropoff_info = await rules.dropoffInfo(order);
      const base = {
        vehicle_type: config.n99.vehicleType,
        external_order_id: job.external_id,
        return_type: config.n99.returnType,
      };
      const addrOnly = (x) => ({ structured_address: x.structured_address, ...(x.location ? { location: x.location } : {}) });

      let est;
      const doEstimate = async () => {
        est = await n99.estimate({ ...base, pickup_info: addrOnly(pickup_info), dropoff_info: addrOnly(dropoff_info) });
      };
      await doEstimate();

      const createBody = () => ({
        ...base,
        pickup_info,
        dropoff_info,
        package_info: { package_type: config.n99.packageType, package_weight: config.n99.packageWeight },
        estimate_id: est.id,
        need_pickup_code: config.n99.needPickupCode,
        need_dropoff_code: config.n99.needDropoffCode,
        return_handover_method: config.n99.returnType === 1 ? 2 : 1,
      });

      let created;
      try {
        created = await n99.create(createBody());
      } catch (e) {
        if (e.errno === 4002 || e.errno === 6101) { // cotação vencida ou endereço divergente: cota de novo
          await doEstimate();
          created = await n99.create(createBody());
        } else throw e;
      }

      db.jobs.update(job.id, {
        status: 'finding',
        n99_status: 'finding',
        n99_order_id: created.order_id,
        quoted_fee_cents: cents(est.fee),
        distance_m: est.delivery_distance,
      });
      log.info('jobs', `${tag} corrida criada na 99 (${created.order_id}), cotação R$ ${reais(est.fee).toFixed(2)}`);
      await safe(`${tag} gravar taxa no CW`, () =>
        cw.setDriver(install.merchant_id, order.id, install.driver99_id, reais(est.fee)));
    } catch (e) {
      const isNetwork = !(e instanceof n99.N99Error) && !e.permanent;
      if (isNetwork) {
        // Pode ter sido criada mesmo assim: o reconciliador confirma pelo external_order_id
        db.jobs.update(job.id, { error: `incerto: ${e.message}` });
        log.warn('jobs', `${tag} falha de rede na criação; reconciliador vai confirmar. ${e.message}`);
        return db.jobs.byId(job.id);
      }
      db.jobs.update(job.id, { status: 'failed', error: e.message });
      log.warn('jobs', `${tag} não criado: ${e.message}. Entregador removido no CW.`);
      await safe(`${tag} remover entregador`, () => cw.removeDriver(install.merchant_id, order.id));
    }
    return db.jobs.byId(job.id);
  });
}

// ---------- Loja tirou o "99 Entrega" ou cancelou o pedido ----------

async function cancelByStore(job, why) {
  return withLock(`${job.merchant_id}:${job.cw_order_id}`, async () => {
    const fresh = db.jobs.byId(job.id);
    if (TERMINAL.includes(fresh.status)) return;
    if (['delivering', 'sendback'].includes(fresh.status)) {
      log.warn('jobs', `${fresh.external_id}: ${why}, mas o motoboy já coletou; cancelamento não é permitido pela 99`);
      return;
    }
    try {
      await n99.cancel({ externalId: fresh.external_id, reasonId: n99.CANCEL_REASON.NOT_NEEDED });
      db.jobs.update(fresh.id, { status: 'canceled', error: why });
      log.info('jobs', `${fresh.external_id}: corrida cancelada na 99 (${why})`);
    } catch (e) {
      if (e.errno === 6201) { // não existe na 99
        db.jobs.update(fresh.id, { status: 'canceled', error: why });
        return;
      }
      db.jobs.update(fresh.id, { error: `cancelamento falhou: ${e.message}` });
      log.warn('jobs', `${fresh.external_id}: cancelamento falhou: ${e.message}`);
    }
  });
}

// ---------- Sincroniza com a 99 (webhook ou reconciliação) ----------

async function sync(job) {
  return withLock(`${job.merchant_id}:${job.cw_order_id}`, async () => {
    const j = db.jobs.byId(job.id);
    if (TERMINAL.includes(j.status)) return j;
    const install = db.installs.byId(j.merchant_id);

    let d;
    try {
      d = await n99.detail(j.external_id);
    } catch (e) {
      if (e.errno === 6201 && j.status === 'creating' && Date.now() - j.created_at > 2 * 60 * 1000) {
        db.jobs.update(j.id, { status: 'failed', error: 'corrida não foi criada na 99' });
        await safe(`${j.external_id} remover entregador`, () => cw.removeDriver(j.merchant_id, j.cw_order_id));
      }
      return db.jobs.byId(j.id);
    }

    const patch = { n99_status: d.status, n99_order_id: d.new_order_id || d.order_id };
    if (j.status === 'creating') {
      patch.status = 'finding';
      patch.quoted_fee_cents = cents(d.price_info?.fee);
      await safe(`${j.external_id} gravar taxa no CW`, () =>
        cw.setDriver(j.merchant_id, j.cw_order_id, install.driver99_id, reais(d.price_info?.fee || 0)));
    }
    const finalFee = cents(d.price_info?.fee);

    switch (d.status) {
      case 'finding':
      case 'waiting':
        patch.status = d.status;
        break;

      case 'delivering':
        if (j.status !== 'delivering') {
          await safe(`${j.external_id} marcar saída no CW`, () => cw.ensureReleased(j.merchant_id, j.cw_order_id));
          log.info('jobs', `${j.external_id}: motoboy saiu com o pedido`);
        }
        patch.status = 'delivering';
        break;

      case 'completed':
        await safe(`${j.external_id} marcar entregue no CW`, () => cw.ensureDelivered(j.merchant_id, j.cw_order_id));
        Object.assign(patch, { status: 'done', final_fee_cents: finalFee });
        if (finalFee != null && finalFee !== j.quoted_fee_cents) {
          await safe(`${j.external_id} atualizar taxa final`, () =>
            cw.setDriver(j.merchant_id, j.cw_order_id, install.driver99_id, reais(finalFee)));
        }
        log.info('jobs', `${j.external_id}: entregue. Taxa final R$ ${reais(finalFee || 0).toFixed(2)}`);
        break;

      case 'sendback':
        patch.status = 'sendback';
        break;

      case 'sendbackCompleted':
        Object.assign(patch, { status: 'done', final_fee_cents: finalFee, error: 'pedido devolvido à loja' });
        await safe(`${j.external_id} atualizar taxa final`, () =>
          cw.setDriver(j.merchant_id, j.cw_order_id, install.driver99_id, reais(finalFee || 0)));
        log.warn('jobs', `${j.external_id}: devolução concluída. Taxa final R$ ${reais(finalFee || 0).toFixed(2)}`);
        break;

      case 'canceled':
      case 'closed':
        Object.assign(patch, { status: 'failed', error: d.status === 'closed' ? 'nenhum motoboy aceitou / encerrada pela 99' : 'cancelada pela 99' });
        await safe(`${j.external_id} remover entregador`, () => cw.removeDriver(j.merchant_id, j.cw_order_id));
        log.warn('jobs', `${j.external_id}: ${patch.error}. Pedido voltou para "Sem entregador" no CW.`);
        break;

      default:
        log.warn('jobs', `${j.external_id}: status desconhecido da 99: ${d.status}`);
    }
    db.jobs.update(j.id, patch);
    return db.jobs.byId(j.id);
  });
}

// ---------- Webhook da 99 ----------

async function handleWebhook(evt) {
  let msg = evt.message;
  if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch { msg = {}; } }
  msg = msg || {};
  const job = (msg.external_order_id && db.jobs.byExternal(msg.external_order_id))
    || db.jobs.byN99(msg.order_id || msg.old_order_id)
    || db.jobs.byN99(msg.new_order_id);
  if (!job) {
    log.warn('webhook99', `evento ${evt.event} sem corrida correspondente`);
    return;
  }
  const after = await sync(job);
  if (evt.event === 'BroadcastTimeout' && after && after.status === 'finding') {
    // A 99 avisou que ninguém aceitou mas a corrida segue aberta: encerra e devolve ao CW
    await giveUp(after, 'nenhum motoboy aceitou no prazo');
  }
}

async function giveUp(job, why) {
  return withLock(`${job.merchant_id}:${job.cw_order_id}`, async () => {
    const j = db.jobs.byId(job.id);
    if (j.status !== 'finding') return;
    await safe(`${j.external_id} cancelar na 99`, () =>
      n99.cancel({ externalId: j.external_id, reasonId: n99.CANCEL_REASON.NO_COURIER }));
    db.jobs.update(j.id, { status: 'failed', error: why });
    await safe(`${j.external_id} remover entregador`, () => cw.removeDriver(j.merchant_id, j.cw_order_id));
    log.warn('jobs', `${j.external_id}: ${why}. Pedido voltou para "Sem entregador" no CW.`);
  });
}

module.exports = { start, cancelByStore, sync, giveUp, handleWebhook, TERMINAL };
