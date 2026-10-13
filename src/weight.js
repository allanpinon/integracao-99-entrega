// Estimativa de peso do pedido a partir dos itens do Cardápio Web.
//
// Ordem de decisão para cada item/opção:
//  1. Regra manual (WEIGHT_RULES): trecho do nome → kg. Ex.: "Açaí 10L=10.5;Caldo=0.6"
//  2. Medida no nome: "500ml", "1L", "2 litros", "250g", "1kg" (açaí/líquidos: 1 ml ≈ 1 g)
//  3. Padrão: item sem medida = WEIGHT_DEFAULT_ITEM_KG; complemento = WEIGHT_DEFAULT_OPTION_KG
//
// Se o item não tem medida no nome mas uma opção tem (ex.: item "Açaí", opção "500ml"),
// a medida da opção vira o peso base do item. As demais opções somam como complementos.

const env = process.env;

const DEFAULT_ITEM_KG = Number(env.WEIGHT_DEFAULT_ITEM_KG || 0.5);
const DEFAULT_OPTION_KG = Number(env.WEIGHT_DEFAULT_OPTION_KG || 0.03);
const PACKAGING_KG = Number(env.WEIGHT_PACKAGING_KG || 0.1);   // sacola/embalagem por pedido
const MARGIN = Number(env.WEIGHT_MARGIN || 0.1);               // +10% de folga

const TIERS = [1, 5, 10, 20, 30];

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function parseRules(raw) {
  return String(raw || '').split(/[;\n]/).map((r) => r.trim()).filter(Boolean)
    .map((r) => {
      const i = r.lastIndexOf('=');
      if (i < 1) return null;
      const kg = Number(r.slice(i + 1).replace(',', '.'));
      return Number.isFinite(kg) ? { text: strip(r.slice(0, i).trim()), kg } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.text.length - a.text.length); // regra mais específica primeiro
}

const RULES = parseRules(env.WEIGHT_RULES);

// Lê a medida do nome. Retorna kg ou null.
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(kg|kilos?|quilos?|gr?|gramas?|ml|l|lts?|litros?)(?![a-z])/g;

function sizeFromName(name) {
  const s = strip(name);
  let best = null;
  for (const m of s.matchAll(SIZE_RE)) {
    const n = Number(m[1].replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) continue;
    const u = m[2];
    let kg;
    if (/^(kg|kilo|kilos|quilo|quilos)$/.test(u)) kg = n;
    else if (/^(g|gr|grama|gramas)$/.test(u)) kg = n / 1000;
    else if (u === 'ml') kg = n / 1000;
    else kg = n; // l, lt, lts, litro(s)
    if (kg > 50) continue; // valor absurdo, ignora
    best = best == null ? kg : Math.max(best, kg);
  }
  return best;
}

function ruleFor(name) {
  const s = strip(name);
  return RULES.find((r) => s.includes(r.text))?.kg ?? null;
}

function optionKg(opt) {
  return ruleFor(opt.name) ?? sizeFromName(opt.name);
}

// Peso de 1 unidade do item (sem multiplicar pela quantidade)
function unitKg(item, trail) {
  if (item.kind === 'combo' && Array.isArray(item.items) && item.items.length) {
    return item.items.reduce((sum, sub) => sum + (Number(sub.quantity) || 1) * unitKg(sub, trail), 0);
  }
  const options = Array.isArray(item.options) ? item.options : [];
  let base = ruleFor(item.name);
  let source = base != null ? 'regra' : null;
  if (base == null) { base = sizeFromName(item.name); source = base != null ? 'nome' : null; }

  // Medida vinda de uma opção (ex.: "Tamanho: 500ml")
  let sizeOpt = null;
  if (base == null) {
    for (const o of options) {
      const kg = optionKg(o);
      if (kg != null && (sizeOpt == null || kg > sizeOpt.kg)) sizeOpt = { o, kg };
    }
    if (sizeOpt) { base = sizeOpt.kg; source = `opção "${sizeOpt.o.name}"`; }
  }
  if (base == null) { base = DEFAULT_ITEM_KG; source = 'padrão'; }

  let extras = 0;
  for (const o of options) {
    if (sizeOpt && o === sizeOpt.o) continue;
    const q = Number(o.quantity) || 1;
    extras += q * (optionKg(o) ?? DEFAULT_OPTION_KG);
  }
  trail.push(`${item.name} = ${base.toFixed(2)}kg (${source})${extras ? ` + ${extras.toFixed(2)}kg complementos` : ''}`);
  return base + extras;
}

function estimate(order) {
  const trail = [];
  const items = (order.items || []).filter((i) => i.status !== 'canceled');
  const net = items.reduce((sum, it) => sum + (Number(it.quantity) || 1) * unitKg(it, trail), 0);
  const kg = Math.round((net * (1 + MARGIN) + PACKAGING_KG) * 100) / 100;
  const tier = TIERS.find((t) => kg <= t);
  return {
    kg,
    packageWeight: tier ? `${tier}kg` : null, // null = acima de 30 kg (moto não leva)
    trail,
  };
}

module.exports = { estimate, sizeFromName, parseRules, TIERS };
