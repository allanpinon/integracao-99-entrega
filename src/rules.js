const config = require('./config');
const { request } = require('./http');

function normalizeMobile(phone, ddi) {
  if (!phone) return null;
  if (ddi && String(ddi) !== '55') return null;
  let d = String(phone).replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length !== 11 || d[2] !== '9') return null;
  return d;
}

function formatCep(cep) {
  const d = String(cep || '').replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : null;
}

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Busca CEP pelo endereço no ViaCEP quando o CW não envia postal_code
async function lookupCep(addr) {
  const street = String(addr.street || '').replace(/^(rua|r\.|avenida|av\.|travessa|tv\.|alameda|al\.)\s+/i, '');
  if (street.length < 3) return null;
  const url = `https://viacep.com.br/ws/${encodeURIComponent(addr.state)}/${encodeURIComponent(addr.city)}/${encodeURIComponent(street)}/json/`;
  try {
    const list = await request(url, { timeoutMs: 8000 });
    if (!Array.isArray(list) || !list.length) return null;
    const num = parseInt(addr.number, 10);
    const sameHood = list.filter((x) => strip(x.bairro) === strip(addr.neighborhood));
    const pool = sameHood.length ? sameHood : list;
    // Escolhe a faixa de numeração compatível quando o ViaCEP traz "complemento" de faixa
    const byRange = Number.isFinite(num) ? pool.find((x) => inRange(x.complemento, num)) : null;
    return formatCep((byRange || pool[0]).cep);
  } catch {
    return null;
  }
}

function inRange(comp, n) {
  if (!comp) return false;
  const c = strip(comp);
  const odd = n % 2 === 1;
  if (c.includes('lado impar') && !odd) return false;
  if (c.includes('lado par') && odd) return false;
  let m = c.match(/de (\d+) a (\d+)/);
  if (m) return n >= +m[1] && n <= +m[2];
  m = c.match(/de (\d+) ao fim/);
  if (m) return n >= +m[1];
  m = c.match(/ate (\d+)/);
  if (m) return n <= +m[1];
  return false;
}

// Valida o pedido do CW. Retorna { ok, reason }
function checkOrder(order) {
  if (order.order_type !== 'delivery') return { ok: false, reason: 'pedido não é delivery' };
  if (order.delivered_by && order.delivered_by !== 'merchant') {
    return { ok: false, reason: `entrega é responsabilidade de ${order.delivered_by}` };
  }
  if (!['confirmed', 'ready', 'scheduled_confirmed'].includes(order.status)) {
    return { ok: false, reason: `status ${order.status} não permite chamar entregador` };
  }
  const a = order.delivery_address;
  if (!a || !a.street || !a.neighborhood || !a.city || !a.state) {
    return { ok: false, reason: 'endereço de entrega incompleto' };
  }
  if (!normalizeMobile(order.customer?.phone, order.customer?.ddi)) {
    return { ok: false, reason: 'cliente sem celular brasileiro válido' };
  }
  if (!config.rules.allowUnpaidOffline) {
    const pays = order.payments || [];
    const pending = pays.filter((p) => p.payment_type !== 'online' && !['paid', 'authorized'].includes(p.status));
    if (pending.length) return { ok: false, reason: 'pagamento na entrega ou ainda não confirmado' };
  }
  return { ok: true };
}

function pickupInfo(displayId) {
  const p = config.pickup;
  const info = {
    structured_address: {
      street: p.street, number: p.number, complement: p.complement, neighborhood: p.neighborhood,
      city: p.city, state: p.state, country: p.country, cep: p.cep,
    },
  };
  if (p.lat != null && p.lng != null) info.location = { lat: p.lat, lng: p.lng };
  return {
    ...info,
    name: p.name,
    phone: p.phone,
    note: `Pedido CW #${displayId}`.slice(0, 127),
  };
}

async function dropoffInfo(order) {
  const a = order.delivery_address;
  const cep = formatCep(a.postal_code) || await lookupCep(a);
  if (!cep) throw Object.assign(new Error('CEP do cliente não encontrado'), { permanent: true });
  const complement = [a.complement, a.address_block && `Quadra ${a.address_block}`, a.address_lot && `Lote ${a.address_lot}`]
    .filter(Boolean).join(' - ');
  const info = {
    structured_address: {
      street: a.street,
      number: a.number || 'S/N',
      complement: complement || undefined,
      neighborhood: a.neighborhood,
      city: a.city,
      state: a.state,
      country: 'Brasil',
      cep,
    },
  };
  const lat = parseFloat(a.latitude);
  const lng = parseFloat(a.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) info.location = { lat, lng };
  const note = [a.reference && `Ref: ${a.reference}`, order.observation].filter(Boolean).join(' | ');
  return {
    ...info,
    name: order.customer?.name || 'Cliente',
    phone: normalizeMobile(order.customer?.phone, order.customer?.ddi),
    note: note.slice(0, 127),
  };
}

module.exports = { normalizeMobile, formatCep, lookupCep, inRange, checkOrder, pickupInfo, dropoffInfo };
