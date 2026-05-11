/* =============================================================
   STRIX · finanças sob comando
   PWA standalone — IndexedDB, otimizações, undo, export/import
   ============================================================= */
(function () {
'use strict';

const { useState, useEffect, useRef, useMemo, useCallback, memo, createElement: h, Fragment } = React;
const {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} = Recharts;

/* ===================== UTILS ===================== */
const fmt = (n) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
const startOfWeek = (d = new Date()) => {
  const x = new Date(d);
  const day = x.getDay();
  const diff = x.getDate() - day + (day === 0 ? -6 : 1);
  x.setDate(diff); x.setHours(0,0,0,0);
  return x;
};
const stripAccents = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const sameNamePerson = (a, b) => stripAccents((a||'').toLowerCase().trim()) === stripAccents((b||'').toLowerCase().trim());
const uid = () => {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
};
const parseAmount = (s) => {
  if (!s) return null;
  const cleaned = String(s).replace(/r\$|reais?|brl/gi, '').trim();
  const norm = cleaned.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(norm);
  return isNaN(n) ? null : n;
};
const haptic = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} };
const debounce = (fn, ms = 300) => {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

// Calcula saldo atual de uma conta: saldo inicial + receitas vinculadas − despesas vinculadas
function computeAccountBalance(account, transactions) {
  if (!account) return 0;
  let balance = Number(account.initialBalance) || 0;
  for (const tx of transactions) {
    if (tx.accountId !== account.id) continue;
    if (tx.type === 'income') balance += Number(tx.amount) || 0;
    else if (tx.type === 'expense') balance -= Number(tx.amount) || 0;
  }
  return balance;
}

// Cartão: dada uma compra, retorna array de meses afetados [{month: 'YYYY-MM', installment: 1, amount: x}, ...]
function cardInstallmentsFor(purchase) {
  const result = [];
  const [yy, mm] = purchase.startMonth.split('-').map(Number);
  const perMonth = purchase.amount / purchase.installments;
  for (let i = 0; i < purchase.installments; i++) {
    const d = new Date(yy, mm - 1 + i, 1);
    result.push({
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      installment: i + 1,
      of: purchase.installments,
      amount: perMonth,
    });
  }
  return result;
}

// Soma todas as parcelas ativas de cartão que caem num mês específico
function cardTotalForMonth(purchases, month) {
  let total = 0;
  const items = [];
  for (const p of purchases) {
    if (!p.active) continue;
    for (const inst of cardInstallmentsFor(p)) {
      if (inst.month === month) {
        total += inst.amount;
        items.push({ ...inst, purchaseId: p.id, description: p.description });
      }
    }
  }
  return { total, items };
}

// Próximo mês relativo a YYYY-MM
function nextMonth(monthStr) {
  const [yy, mm] = monthStr.split('-').map(Number);
  const d = new Date(yy, mm, 1); // mm já é 1-indexed, então isso vai pra mm+1 efetivamente
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function prevMonth(monthStr) {
  const [yy, mm] = monthStr.split('-').map(Number);
  const d = new Date(yy, mm - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(monthStr) {
  const [yy, mm] = monthStr.split('-').map(Number);
  const d = new Date(yy, mm - 1, 1);
  return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

/* ===================== INDEXEDDB STORAGE =====================
   Schema versionado, transações ACID, índices por data/mês/pessoa.
   Objeto stores:
   - transactions  (id, date, type, amount, category, ...)  índices: by-date, by-month, by-type
   - debts         (id, person, amount, paid, ...)          índices: by-person, by-paid
   - bills         (id, name, dueDate, paid, ...)           índices: by-due, by-paid
   - meta          (key, value)  para budget e settings
   - audit         (id, ts, action, payload) trilha p/ undo
================================================================= */
const DB_NAME = 'strix-db';
const DB_VERSION = 3;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion || 0;
      // transactions
      if (!db.objectStoreNames.contains('transactions')) {
        const s = db.createObjectStore('transactions', { keyPath: 'id' });
        s.createIndex('by-date', 'date');
        s.createIndex('by-month', 'month');
        s.createIndex('by-type', 'type');
      }
      // debts
      if (!db.objectStoreNames.contains('debts')) {
        const s = db.createObjectStore('debts', { keyPath: 'id' });
        s.createIndex('by-person', 'personKey');
        s.createIndex('by-paid', 'paid');
        s.createIndex('by-direction', 'direction');
      }
      // bills
      if (!db.objectStoreNames.contains('bills')) {
        const s = db.createObjectStore('bills', { keyPath: 'id' });
        s.createIndex('by-due', 'dueDate');
        s.createIndex('by-paid', 'paid');
      }
      // meta
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // audit
      if (!db.objectStoreNames.contains('audit')) {
        const s = db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
        s.createIndex('by-ts', 'ts');
      }
      // v2: accounts
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('accounts')) {
          const s = db.createObjectStore('accounts', { keyPath: 'id' });
          s.createIndex('by-name', 'nameKey');
          s.createIndex('by-archived', 'archived');
        }
        if (db.objectStoreNames.contains('transactions')) {
          const txStore = e.target.transaction.objectStore('transactions');
          if (!txStore.indexNames.contains('by-account')) {
            txStore.createIndex('by-account', 'accountId');
          }
        }
      }
      // v3: cartão de crédito
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains('cardPurchases')) {
          const s = db.createObjectStore('cardPurchases', { keyPath: 'id' });
          s.createIndex('by-startMonth', 'startMonth');
          s.createIndex('by-active', 'active');
        }
        if (!db.objectStoreNames.contains('cardPayments')) {
          const s = db.createObjectStore('cardPayments', { keyPath: 'id' });
          s.createIndex('by-month', 'month');
        }
      }
    };
  });
  return dbPromise;
}

async function dbExec(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const dbGetAll = (store) => dbExec(store, 'readonly', (s) => new Promise((res, rej) => {
  const r = s.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));
const dbPut = (store, value) => dbExec(store, 'readwrite', (s) => s.put(value));
const dbDelete = (store, key) => dbExec(store, 'readwrite', (s) => s.delete(key));
const dbGet = (store, key) => dbExec(store, 'readonly', (s) => new Promise((res, rej) => {
  const r = s.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));

const dbAudit = (action, payload) => dbExec('audit', 'readwrite', (s) => s.add({ ts: Date.now(), action, payload }));

/* Quota check */
async function getStorageEstimate() {
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  }
  return { used: 0, quota: 0 };
}

/* Persist storage (evita evicção) */
async function requestPersistence() {
  if (navigator.storage?.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}

/* ===================== PARSER NLP ===================== */
function parseCommand(input) {
  const text = input.trim();
  const lower = stripAccents(text.toLowerCase());

  // Datas
  const today = new Date();
  let date = todayISO();
  if (/\bontem\b/.test(lower)) { const d = new Date(); d.setDate(d.getDate()-1); date = d.toISOString().split('T')[0]; }
  else if (/\banteontem\b/.test(lower)) { const d = new Date(); d.setDate(d.getDate()-2); date = d.toISOString().split('T')[0]; }
  else if (/\bamanha\b/.test(lower)) { const d = new Date(); d.setDate(d.getDate()+1); date = d.toISOString().split('T')[0]; }

  const dayMatch = lower.match(/\bdia\s+(\d{1,2})\b/);
  if (dayMatch) {
    const d = new Date(today.getFullYear(), today.getMonth(), parseInt(dayMatch[1]));
    date = d.toISOString().split('T')[0];
  }
  const dmMatch = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (dmMatch) {
    const dd = parseInt(dmMatch[1]), mm = parseInt(dmMatch[2]) - 1;
    const yy = dmMatch[3] ? (dmMatch[3].length === 2 ? 2000 + parseInt(dmMatch[3]) : parseInt(dmMatch[3])) : today.getFullYear();
    date = new Date(yy, mm, dd).toISOString().split('T')[0];
  }

  // Valor: tenta primeiro formato com milhar (1.234,56) e cai para inteiro grande
  const valueMatch =
    text.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?)/i) ||
    text.match(/(?:r\$\s*)?(\d+(?:,\d{1,2}))/i) ||
    text.match(/(?:r\$\s*)?(\d+(?:\.\d{1,2}))/i) ||
    text.match(/(?:r\$\s*)?(\d+)/i);
  const amount = valueMatch ? parseAmount(valueMatch[1] || valueMatch[0]) : null;

  // Correção
  if (/\bnao\s+(sao|e)\b.*?\be\s+sim\b/.test(lower)) {
    const nums = [...text.matchAll(/(?:r\$\s*)?(\d+(?:[,.]\d{1,2})?)/gi)].map(m => parseAmount(m[0]));
    const day = lower.match(/dia\s+(\d{1,2})/);
    return { type: 'correction', oldAmount: nums[0] ?? null, newAmount: nums[nums.length-1] ?? null,
      day: day ? parseInt(day[1]) : null, raw: text };
  }

  // ============ EXCLUSÃO ============
  // "apaga/exclui/remove o último gasto/lançamento"
  const delUltimo = lower.match(/^(?:apaga|exclui|remove|deleta|tira)\s+(?:o|a|um|uma)?\s*(?:ultim[oa]|recente)\s+(gasto|lan[çc]amento|transa[çc][ãa]o|d[íi]vida|conta|local|despesa|receita|entrada)?/i);
  if (delUltimo) {
    return { type: 'delete_last', target: delUltimo[1] || 'any', raw: text };
  }
  // "apaga gasto de 30 em gasolina" / "exclui gasto de gasolina" / "apaga conta da tim"
  const delEspec = lower.match(/^(?:apaga|exclui|remove|deleta|tira)\s+(?:o|a|um|uma)?\s*(gasto|lan[çc]amento|despesa|receita|entrada|d[íi]vida|conta|local|transa[çc][ãa]o)?\s*(?:de|com|do|da|em|no|na)?\s*(.+)$/i);
  if (delEspec) {
    return {
      type: 'delete_match',
      target: delEspec[1] || 'any',
      query: delEspec[2].trim(),
      amount, raw: text,
    };
  }

  // ============ EDIÇÃO ============
  // "muda/altera/edita gasto de gasolina para 40" / "renomeia nubank para nu bank"
  const editaValor = lower.match(/^(?:muda|altera|edita|corrige|atualiza)\s+(?:o|a)?\s*(gasto|lan[çc]amento|despesa|receita|d[íi]vida|conta|local|transa[çc][ãa]o)?\s*(?:de|do|da|em|com)?\s*(.+?)\s+(?:para|pra)\s+(?:r\$\s*)?[\d.,]+/i);
  if (editaValor) {
    return {
      type: 'edit_amount',
      target: editaValor[1] || 'any',
      query: editaValor[2].trim(),
      newAmount: amount, raw: text,
    };
  }
  // "renomeia X para Y" (foco em contas/locais)
  const renomeia = lower.match(/^(?:renomeia|renomear)\s+(.+?)\s+(?:para|pra)\s+(.+)$/i);
  if (renomeia) {
    return { type: 'rename', from: renomeia[1].trim(), to: renomeia[2].trim(), raw: text };
  }

  // Orçamentos
  if (/(esse|este)\s+mes.*(posso|vou|consigo)\s+gastar/.test(lower)
      || /orcamento\s+(do\s+)?mes/.test(lower)
      || /limite\s+mensal/.test(lower)) {
    return { type: 'budget_monthly', amount, raw: text };
  }
  if (/(essa|esta)\s+semana.*(posso|vou|consigo)\s+gastar/.test(lower)
      || /orcamento\s+(da\s+)?semana/.test(lower)
      || /limite\s+semanal/.test(lower)) {
    return { type: 'budget_weekly', amount, raw: text };
  }

  // Devedores
  const meDeve = lower.match(/^([a-z\s]+?)\s+me\s+devem?\s+(?:r\$\s*)?[\d.,]+/i);
  const vendi = lower.match(/vendi\s+(?:r\$\s*)?[\d.,]+(?:\s+reais?)?(?:\s+(?:de|em)\s+([a-z\s]+?))?\s+(?:para|pra|pro)(?:\s+(?:o|a))?\s+([a-z]+)/i);
  if (meDeve) return { type: 'debt_owed_to_me', amount, person: meDeve[1].trim(), description: 'empréstimo', date, raw: text };
  if (vendi) return { type: 'debt_owed_to_me', amount, person: vendi[2].trim(),
    description: vendi[1] ? vendi[1].trim() : 'venda', date, raw: text };

  // ============ INVENTÁRIO / CONTAS ============
  // "tenho 500 no nubank" / "tenho 1500 na conta do itaú" / "tenho 300 na carteira"
  const tenho = lower.match(/^(?:eu\s+)?tenho\s+(?:r\$\s*)?[\d.,]+(?:\s+reais?)?\s+(?:no|na|em|guardado(?:s)?\s+(?:no|na|em))\s+(?:conta\s+(?:do|da|de)\s+)?([a-z\s]+)$/i);
  if (tenho) {
    return { type: 'account_set', name: tenho[1].trim(), amount, raw: text };
  }
  // "ajusta nubank para 450" / "atualiza saldo do itaú para 1200"
  const ajusta = lower.match(/^(?:ajusta|atualiza|corrige)(?:\s+(?:saldo|conta)(?:\s+(?:do|da|de))?)?\s+([a-z\s]+?)\s+(?:para|pra)\s+(?:r\$\s*)?[\d.,]+/i);
  if (ajusta) {
    return { type: 'account_adjust', name: ajusta[1].trim(), amount, raw: text };
  }
  // "transferi 500 do itaú pro nubank" / "transferi 200 da carteira para o nubank"
  const transferi = lower.match(/transferi\s+(?:r\$\s*)?[\d.,]+(?:\s+reais?)?\s+(?:do|da|de)\s+([a-z\s]+?)\s+(?:para|pra|pro)(?:\s+(?:o|a))?\s+([a-z\s]+)$/i);
  if (transferi) {
    return { type: 'transfer', from: transferi[1].trim(), to: transferi[2].trim(), amount, raw: text };
  }
  // "caiu 3000 de salário no itaú" / "recebi salário de 3000 no nubank"
  const salarioMatch = lower.match(/(?:caiu|recebi|entrou)\s+(?:r\$\s*)?[\d.,]+(?:\s+reais?)?(?:\s+de\s+(salario|sal[áa]rio|adiantamento|13|13o|pix|bonus))?(?:\s+(?:no|na|em)\s+(?:conta\s+(?:do|da|de)\s+)?([a-z\s]+))?$/i);
  if (salarioMatch && /caiu|salario|entrou/.test(lower)) {
    const isSalary = /salario|sal[áa]rio|adiantamento|13/.test(lower);
    return {
      type: 'income',
      amount,
      description: isSalary ? 'Salário' : (salarioMatch[1] || 'Receita'),
      category: isSalary ? 'Salário' : 'Renda',
      account: salarioMatch[2] ? salarioMatch[2].trim() : null,
      date, raw: text,
    };
  }

  // Pagamentos recebidos
  const mePagou = lower.match(/^([a-z\s]+?)\s+me\s+pagou\s+(?:r\$\s*)?[\d.,]+(?:\s+reais?)?(?:\s+(?:no|na|em)\s+([a-z\s]+))?$/i);
  const recebi = lower.match(/recebi\s+(?:r\$\s*)?[\d.,]+\s+(?:de|do|da)\s+([a-z]+)(?:\s+(?:no|na|em)\s+([a-z\s]+))?$/i);
  if (mePagou) return { type: 'debt_payment_received', amount, person: mePagou[1].trim(),
    account: mePagou[2] ? mePagou[2].trim() : null, date, raw: text };
  if (recebi) return { type: 'debt_payment_received', amount, person: recebi[1].trim(),
    account: recebi[2] ? recebi[2].trim() : null, date, raw: text };

  // Eu devo
  const devo = lower.match(/(?:eu\s+)?devo\s+(?:r\$\s*)?[\d.,]+\s+(?:para|pra|pro|ao|a)\s+([a-z]+)/i);
  if (devo) return { type: 'debt_i_owe', amount, person: devo[1].trim(), date, raw: text };

  // Contas
  const conta = lower.match(/conta\s+(?:da|do|de)\s+([a-z]+)/i);
  if (conta) {
    const naoPago = /ainda\s+nao\s+paguei|nao\s+paguei|vence|vencimento/.test(lower);
    const paguei = /^paguei|ja\s+paguei/.test(lower);
    const venceMatch = lower.match(/vence(?:\s+em)?\s+(?:dia\s+)?(\d{1,2})(?:\/(\d{1,2}))?/);
    let dueDate = null;
    if (venceMatch) {
      const dd = parseInt(venceMatch[1]);
      const mm = venceMatch[2] ? parseInt(venceMatch[2]) - 1 : today.getMonth();
      dueDate = new Date(today.getFullYear(), mm, dd).toISOString().split('T')[0];
    }
    if (paguei) return { type: 'bill_paid', name: conta[1].trim(), amount, date, raw: text };
    return { type: 'bill', name: conta[1].trim(), amount, dueDate, paid: !naoPago && paguei, raw: text };
  }

  // ============ CARTÃO DE CRÉDITO ============
  // "paguei o cartão" / "paguei a fatura do cartão" / "paguei 590 do cartão"
  if (/^(paguei|quitei)\s+(?:a\s+fatura\s+(?:do\s+)?)?(?:o\s+)?cart[ao]o/.test(lower)
      || /paguei\s+(?:r\$\s*)?[\d.,]+\s+(?:do|da|de)\s+cart[ao]o/.test(lower)
      || /paguei\s+(?:r\$\s*)?[\d.,]+\s+(?:de|da)\s+fatura/.test(lower)) {
    return { type: 'card_payment', amount, date, raw: text };
  }
  // "comprei algo de 600 no cartão em 3x" / "passei 300 no cartão em 6x"
  // "300 no cartão" / "gastei 300 no cartão em 2x"
  const parcelMatch = lower.match(/(?:comprei|passei|gastei)?\s*(?:r\$\s*)?[\d.,]+(?:\s+reais?)?(?:\s+(?:em|com|de)\s+(.+?))?\s+(?:no|com|pelo)\s+cart[ao]o(?:\s+em\s+(\d+)\s*x)?/i);
  if (parcelMatch && /cart[ao]o/.test(lower)) {
    const installments = parcelMatch[2] ? parseInt(parcelMatch[2]) : 1;
    const description = parcelMatch[1] ? parcelMatch[1].trim() : 'Compra no cartão';
    return {
      type: 'card_purchase',
      amount, installments,
      description: description.replace(/^em\s+/, '').trim(),
      date, raw: text,
    };
  }

  // Renda
  if (/^(recebi|ganhei|caiu|entrou)\s+/.test(lower) && !recebi) {
    return { type: 'income', amount, description: text, date, raw: text };
  }

  // Gasto: aceita "no/na X" no final como conta vinculada
  const gastei = lower.match(/gastei\s+(?:r\$\s*)?[\d.,]+\s+(?:em|com|no|na|de)\s+(.+)/i);
  if (gastei) {
    let desc = gastei[1].trim();
    let account = null;
    const payMatch = desc.match(/^(.+?)\s+(?:pago|paguei)\s+(?:com|no|na|pelo|pela)\s+([a-z\s]+)$/i);
    if (payMatch) {
      desc = payMatch[1].trim();
      account = payMatch[2].trim();
    }
    return { type: 'expense', amount, category: categorize(desc), description: desc, account, date, raw: text };
  }

  if (amount !== null) return { type: 'expense', amount, category: 'Outros', description: text, date, raw: text };
  return { type: 'unknown', raw: text };
}

function categorize(desc) {
  const d = stripAccents(desc.toLowerCase());
  if (/gasolina|combustivel|posto|uber|99|taxi|onibus|metro/.test(d)) return 'Transporte';
  if (/mercado|comida|restaurante|lanche|ifood|rappi|almoco|jantar|cafe|padaria/.test(d)) return 'Alimentação';
  if (/conta|luz|agua|internet|tim|vivo|claro|oi|netflix|spotify/.test(d)) return 'Contas';
  if (/farmacia|remedio|medico|consulta|exame/.test(d)) return 'Saúde';
  if (/cinema|show|bar|festa|jogo|game/.test(d)) return 'Lazer';
  if (/roupa|sapato|calcado|loja/.test(d)) return 'Vestuário';
  if (/cartao/.test(d)) return 'Cartão';
  return 'Outros';
}

/* ===================== MASCOTE ===================== */
const StrixOwl = memo(function StrixOwl({ size = 64, mood = 'default', theme = 'dark' }) {
  const stroke = theme === 'dark' ? '#ff453a' : '#d70015';
  const fill = theme === 'dark' ? '#1c1c1e' : '#fff';
  const inner = theme === 'dark' ? '#0a0a0c' : '#fff';
  return h('svg', { width: size, height: size, viewBox: '0 0 100 100', fill: 'none' },
    h('ellipse', { cx: 50, cy: 58, rx: 30, ry: 34, fill, stroke, strokeWidth: 2.2 }),
    h('path', { d: 'M25 32 L22 18 L34 28 Z', fill, stroke, strokeWidth: 2.2, strokeLinejoin: 'round' }),
    h('path', { d: 'M75 32 L78 18 L66 28 Z', fill, stroke, strokeWidth: 2.2, strokeLinejoin: 'round' }),
    h('path', { d: 'M30 42 Q50 30 70 42 Q70 60 50 65 Q30 60 30 42 Z', fill, stroke, strokeWidth: 1.5, opacity: 0.9 }),
    h('circle', { cx: 40, cy: 48, r: 7, fill: stroke }),
    h('circle', { cx: 60, cy: 48, r: 7, fill: stroke }),
    mood === 'sleep'
      ? h(Fragment, null,
          h('path', { d: 'M34 48 Q40 50 46 48', stroke: inner, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' }),
          h('path', { d: 'M54 48 Q60 50 66 48', stroke: inner, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' })
        )
      : h(Fragment, null,
          h('circle', { cx: 40, cy: 48, r: 2.5, fill: inner }),
          h('circle', { cx: 60, cy: 48, r: 2.5, fill: inner }),
          h('circle', { cx: 41, cy: 47, r: 0.8, fill }),
          h('circle', { cx: 61, cy: 47, r: 0.8, fill })
        ),
    h('path', { d: 'M50 54 L46 60 L54 60 Z', fill: stroke, stroke, strokeWidth: 1, strokeLinejoin: 'round' }),
    h('path', { d: 'M40 70 Q50 76 60 70', stroke, strokeWidth: 1.2, fill: 'none', opacity: 0.5 }),
    h('path', { d: 'M37 78 Q50 84 63 78', stroke, strokeWidth: 1.2, fill: 'none', opacity: 0.4 }),
    h('path', { d: 'M22 56 Q18 70 26 84', stroke, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' }),
    h('path', { d: 'M78 56 Q82 70 74 84', stroke, strokeWidth: 2, fill: 'none', strokeLinecap: 'round' })
  );
});

/* ===================== TEMA ===================== */
const themes = {
  dark: {
    bg: '#0a0a0c',
    bgGrad: 'radial-gradient(ellipse at top, #1a0608 0%, #0a0a0c 50%)',
    surface: '#16161a', surfaceHi: '#1f1f24',
    border: 'rgba(255,255,255,0.08)',
    text: '#f5f5f7', textDim: '#8e8e93', textFaint: '#48484a',
    accent: '#ff453a', accentDim: '#ff6961', accentSoft: 'rgba(255,69,58,0.12)',
    success: '#30d158', warning: '#ff9f0a', danger: '#ff453a',
  },
  light: {
    bg: '#f2f2f7',
    bgGrad: 'radial-gradient(ellipse at top, #ffe5e3 0%, #f2f2f7 60%)',
    surface: '#ffffff', surfaceHi: '#f5f5f7',
    border: 'rgba(0,0,0,0.08)',
    text: '#1d1d1f', textDim: '#6e6e73', textFaint: '#aeaeb2',
    accent: '#d70015', accentDim: '#ff3b30', accentSoft: 'rgba(215,0,21,0.08)',
    success: '#28a745', warning: '#ff9500', danger: '#d70015',
  },
};

/* ===================== APP ===================== */
function App() {
  const [theme, setTheme] = useState('dark');
  const [tab, setTab] = useState('home');
  const [transactions, setTransactions] = useState([]);
  const [debts, setDebts] = useState([]);
  const [bills, setBills] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [cardPurchases, setCardPurchases] = useState([]);
  const [cardPayments, setCardPayments] = useState([]);
  const [budget, setBudget] = useState({ monthly: 0, weekly: 0, month: monthKey() });
  const [feedback, setFeedback] = useState(null);
  const [pendingUndo, setPendingUndo] = useState(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [editing, setEditing] = useState(null); // { kind, item }

  const recogRef = useRef(null);
  const t = themes[theme];

  /* ----- Load inicial ----- */
  useEffect(() => {
    (async () => {
      try {
        const [txs, dbs, bls, accs, cps, cpays, settings, bdg] = await Promise.all([
          dbGetAll('transactions'),
          dbGetAll('debts'),
          dbGetAll('bills'),
          dbGetAll('accounts'),
          dbGetAll('cardPurchases'),
          dbGetAll('cardPayments'),
          dbGet('meta', 'settings'),
          dbGet('meta', 'budget'),
        ]);
        setTransactions(txs || []);
        setDebts(dbs || []);
        setBills(bls || []);
        setAccounts(accs || []);
        setCardPurchases(cps || []);
        setCardPayments(cpays || []);
        if (settings?.value) setTheme(settings.value.theme || 'dark');
        if (bdg?.value) setBudget(bdg.value);

        // Pede persistência (evita o navegador limpar dados)
        await requestPersistence();
        // Hide splash
        document.querySelector('.strix-splash')?.remove();
      } catch (e) {
        console.error('Erro carregando DB:', e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  /* ----- Persistência (debounced para meta) ----- */
  const saveBudget = useMemo(() => debounce(async (b) => {
    await dbPut('meta', { key: 'budget', value: b });
  }, 250), []);
  const saveSettings = useMemo(() => debounce(async (s) => {
    await dbPut('meta', { key: 'settings', value: s });
  }, 100), []);

  useEffect(() => { if (loaded) saveBudget(budget); }, [budget, loaded, saveBudget]);
  useEffect(() => { if (loaded) saveSettings({ theme }); }, [theme, loaded, saveSettings]);

  /* ----- Speech recognition ----- */
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.lang = 'pt-BR'; r.continuous = false; r.interimResults = false;
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recogRef.current = r;
  }, []);

  const flash = useCallback((msg, kind = 'ok', undoData = null) => {
    setFeedback({ msg, kind });
    if (undoData) setPendingUndo(undoData);
    setTimeout(() => { setFeedback(null); setPendingUndo(null); }, undoData ? 5000 : 2500);
  }, []);

  /* ----- Notification scheduling via SW ----- */
  const scheduleNotification = useCallback(async (title, body, when, tag) => {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.ready;
    if (!reg) return;
    reg.active?.postMessage({
      type: 'SCHEDULE_NOTIFICATION',
      payload: { title, body, when, tag }
    });
  }, []);

  /* ----- Mutadores indo direto pro IndexedDB ----- */
  const addTx = async (tx) => {
    const full = { ...tx, id: tx.id || uid(), month: tx.date?.slice(0, 7) };
    await dbPut('transactions', full);
    setTransactions(p => [...p, full]);
    return full;
  };
  const removeTx = async (id) => {
    const tx = transactions.find(x => x.id === id);
    await dbDelete('transactions', id);
    setTransactions(p => p.filter(x => x.id !== id));
    return tx;
  };
  const updateTx = async (id, patch) => {
    const cur = transactions.find(x => x.id === id);
    if (!cur) return;
    const upd = { ...cur, ...patch, month: (patch.date || cur.date)?.slice(0,7) };
    await dbPut('transactions', upd);
    setTransactions(p => p.map(x => x.id === id ? upd : x));
  };

  const addDebt = async (d) => {
    const full = { ...d, id: d.id || uid(), personKey: stripAccents((d.person||'').toLowerCase().trim()) };
    await dbPut('debts', full);
    setDebts(p => [...p, full]);
    return full;
  };
  const updateDebt = async (id, patch) => {
    const cur = debts.find(x => x.id === id);
    if (!cur) return;
    const upd = { ...cur, ...patch };
    await dbPut('debts', upd);
    setDebts(p => p.map(x => x.id === id ? upd : x));
  };
  const removeDebt = async (id) => {
    const cur = debts.find(x => x.id === id);
    await dbDelete('debts', id);
    setDebts(p => p.filter(x => x.id !== id));
    return cur;
  };

  const addBill = async (b) => {
    const full = { ...b, id: b.id || uid() };
    await dbPut('bills', full);
    setBills(p => [...p, full]);
    // Notificação 1 dia antes do vencimento
    if (full.dueDate && !full.paid) {
      const due = new Date(full.dueDate + 'T09:00:00');
      due.setDate(due.getDate() - 1);
      if (due.getTime() > Date.now()) {
        scheduleNotification(
          `Strix · ${full.name} vence amanhã`,
          full.amount ? `${fmt(full.amount)} pendente` : 'Conta pendente',
          due.getTime(),
          `bill-${full.id}`
        );
      }
    }
    return full;
  };
  const updateBill = async (id, patch) => {
    const cur = bills.find(x => x.id === id);
    if (!cur) return;
    const upd = { ...cur, ...patch };
    await dbPut('bills', upd);
    setBills(p => p.map(x => x.id === id ? upd : x));
  };
  const removeBill = async (id) => {
    const cur = bills.find(x => x.id === id);
    await dbDelete('bills', id);
    setBills(p => p.filter(x => x.id !== id));
    return cur;
  };

  /* ----- Accounts (carteiras/contas/locais com dinheiro) ----- */
  const addAccount = async (a) => {
    const full = {
      ...a,
      id: a.id || uid(),
      nameKey: stripAccents((a.name || '').toLowerCase().trim()),
      initialBalance: a.initialBalance || 0,
      createdAt: a.createdAt || Date.now(),
      archived: !!a.archived,
    };
    await dbPut('accounts', full);
    setAccounts(p => [...p, full]);
    return full;
  };
  const updateAccount = async (id, patch) => {
    const cur = accounts.find(x => x.id === id);
    if (!cur) return;
    const upd = { ...cur, ...patch };
    if (patch.name) upd.nameKey = stripAccents(patch.name.toLowerCase().trim());
    await dbPut('accounts', upd);
    setAccounts(p => p.map(x => x.id === id ? upd : x));
  };
  const removeAccount = async (id) => {
    await dbDelete('accounts', id);
    setAccounts(p => p.filter(x => x.id !== id));
  };

  // Resolve nome livre → account (fuzzy: exato, prefixo, substring)
  const resolveAccount = useCallback((name) => {
    if (!name) return null;
    const key = stripAccents(name.toLowerCase().trim()).replace(/^(conta\s+(?:do|da|de)\s+)/, '');
    const active = accounts.filter(a => !a.archived);
    return active.find(a => a.nameKey === key)
        || active.find(a => a.nameKey.startsWith(key))
        || active.find(a => a.nameKey.includes(key))
        || active.find(a => key.includes(a.nameKey))
        || null;
  }, [accounts]);

  // Cria conta se não existir, retorna full
  const ensureAccount = useCallback(async (name) => {
    const found = resolveAccount(name);
    if (found) return found;
    return await addAccount({ name: name.replace(/^(conta\s+(?:do|da|de)\s+)/i, '').trim(), initialBalance: 0 });
  }, [accounts, resolveAccount]);

  /* ----- Cartão de crédito ----- */
  const addCardPurchase = async (p) => {
    const full = {
      ...p, id: p.id || uid(),
      startMonth: p.startMonth || monthKey(),
      installments: p.installments || 1,
      active: p.active !== false,
      createdAt: Date.now(),
    };
    await dbPut('cardPurchases', full);
    setCardPurchases(prev => [...prev, full]);
    return full;
  };
  const updateCardPurchase = async (id, patch) => {
    const cur = cardPurchases.find(p => p.id === id);
    if (!cur) return;
    const upd = { ...cur, ...patch };
    await dbPut('cardPurchases', upd);
    setCardPurchases(prev => prev.map(p => p.id === id ? upd : p));
  };
  const removeCardPurchase = async (id) => {
    await dbDelete('cardPurchases', id);
    setCardPurchases(prev => prev.filter(p => p.id !== id));
  };

  // Pagamento de fatura: registra payment, marca parcelas do mês como "pagas"
  // (na verdade, "pagar fatura" só registra payment + cria transaction de despesa.
  // O contador automaticamente avança porque ele soma só as parcelas ativas a partir
  // do mês atual / sem payment registrado nesse mês.)
  const payCard = async (amount, month) => {
    const mKey = month || monthKey();
    const id = uid();
    const payment = { id, month: mKey, amount, date: todayISO(), createdAt: Date.now() };
    await dbPut('cardPayments', payment);
    setCardPayments(prev => [...prev, payment]);
    // Registra como transação para entrar no gasto do mês
    await addTx({
      type: 'expense', amount,
      category: 'Cartão',
      description: `Fatura cartão · ${monthLabel(mKey)}`,
      date: todayISO(), paid: true, cardPaymentId: id,
    });
    return payment;
  };

  /* ----- Comando ----- */
  const handleCommand = useCallback(async (rawText) => {
    if (!rawText.trim()) return;
    haptic(10);
    const cmd = parseCommand(rawText);

    if (cmd.type === 'unknown') {
      flash('Não entendi. Tente: "gastei 30 em gasolina"', 'warn'); return;
    }
    if (cmd.amount === null && cmd.type !== 'correction' && cmd.type !== 'bill_paid') {
      flash('Não consegui identificar o valor.', 'warn'); return;
    }

    switch (cmd.type) {
      case 'expense':
      case 'income': {
        // Resolve conta vinculada (se vier do parser)
        let accountId = null;
        if (cmd.account) {
          const acc = await ensureAccount(cmd.account);
          accountId = acc.id;
        }
        const tx = await addTx({
          type: cmd.type, amount: cmd.amount,
          category: cmd.category || (cmd.type === 'income' ? 'Renda' : 'Outros'),
          description: cmd.description || cmd.raw,
          accountId,
          date: cmd.date, paid: true,
        });
        await dbAudit('add_tx', tx);
        const acc = accountId ? accounts.find(a => a.id === accountId) : null;
        flash(`${cmd.type === 'expense' ? 'Gasto' : 'Receita'}: ${fmt(cmd.amount)}${acc ? ` · ${acc.name}` : ''}`, 'ok',
          { kind: 'tx', id: tx.id });
        break;
      }
      case 'budget_monthly':
        setBudget(b => ({ ...b, monthly: cmd.amount, month: monthKey() }));
        flash(`Orçamento mensal: ${fmt(cmd.amount)}`); break;
      case 'budget_weekly':
        setBudget(b => ({ ...b, weekly: cmd.amount }));
        flash(`Orçamento semanal: ${fmt(cmd.amount)}`); break;
      case 'debt_owed_to_me': {
        const d = await addDebt({
          person: cmd.person, amount: cmd.amount,
          description: cmd.description, date: cmd.date,
          paid: false, direction: 'owes_me',
        });
        flash(`${cmd.person} te deve ${fmt(cmd.amount)}`, 'ok', { kind: 'debt', id: d.id });
        break;
      }
      case 'debt_i_owe': {
        const d = await addDebt({
          person: cmd.person, amount: cmd.amount,
          description: cmd.raw, date: cmd.date,
          paid: false, direction: 'i_owe',
        });
        flash(`Você deve ${fmt(cmd.amount)} a ${cmd.person}`, 'ok', { kind: 'debt', id: d.id });
        break;
      }
      case 'debt_payment_received': {
        let remaining = cmd.amount;
        for (const d of debts) {
          if (remaining <= 0 || d.paid || d.direction !== 'owes_me') continue;
          if (sameNamePerson(d.person, cmd.person)) {
            await updateDebt(d.id, { paid: true, paidDate: cmd.date });
            remaining -= d.amount;
          }
        }
        let accountId = null;
        if (cmd.account) {
          const acc = await ensureAccount(cmd.account);
          accountId = acc.id;
        }
        await addTx({
          type: 'income', amount: cmd.amount,
          category: 'Pagamento recebido',
          description: `Pagamento de ${cmd.person}`,
          accountId,
          date: cmd.date, paid: true,
        });
        flash(`${cmd.person} pagou ${fmt(cmd.amount)}`); break;
      }
      // ============ INVENTÁRIO ============
      case 'account_set': {
        // "tenho X no nubank" — define saldo inicial se for nova; senão cria ajuste
        const existing = resolveAccount(cmd.name);
        if (!existing) {
          const acc = await addAccount({ name: cmd.name, initialBalance: cmd.amount });
          flash(`${acc.name}: ${fmt(cmd.amount)}`, 'ok', { kind: 'account', id: acc.id });
        } else {
          // Calcula saldo atual e cria transação de ajuste
          const curBalance = computeAccountBalance(existing, transactions);
          const delta = cmd.amount - curBalance;
          if (Math.abs(delta) < 0.01) {
            flash(`${existing.name} já está em ${fmt(cmd.amount)}`); break;
          }
          const tx = await addTx({
            type: delta > 0 ? 'income' : 'expense',
            amount: Math.abs(delta),
            category: 'Ajuste',
            description: `Ajuste de saldo · ${existing.name}`,
            accountId: existing.id,
            date: cmd.date || todayISO(), paid: true,
          });
          flash(`${existing.name}: ${fmt(curBalance)} → ${fmt(cmd.amount)}`, 'ok', { kind: 'tx', id: tx.id });
        }
        break;
      }
      case 'account_adjust': {
        // Alias semântico — mesmo comportamento de account_set sobre conta existente
        const existing = resolveAccount(cmd.name);
        if (!existing) { flash(`Conta "${cmd.name}" não existe. Diga "tenho X no ${cmd.name}" primeiro.`, 'warn'); break; }
        const curBalance = computeAccountBalance(existing, transactions);
        const delta = cmd.amount - curBalance;
        if (Math.abs(delta) < 0.01) { flash(`${existing.name} já está em ${fmt(cmd.amount)}`); break; }
        const tx = await addTx({
          type: delta > 0 ? 'income' : 'expense',
          amount: Math.abs(delta),
          category: 'Ajuste',
          description: `Ajuste de saldo · ${existing.name}`,
          accountId: existing.id,
          date: cmd.date || todayISO(), paid: true,
        });
        flash(`${existing.name}: ${fmt(curBalance)} → ${fmt(cmd.amount)}`, 'ok', { kind: 'tx', id: tx.id });
        break;
      }
      case 'transfer': {
        const from = await ensureAccount(cmd.from);
        const to = await ensureAccount(cmd.to);
        if (from.id === to.id) { flash('Origem e destino iguais', 'warn'); break; }
        const transferGroup = uid();
        // Saída
        await addTx({
          type: 'expense', amount: cmd.amount,
          category: 'Transferência',
          description: `Para ${to.name}`,
          accountId: from.id, transferGroup,
          date: cmd.date || todayISO(), paid: true,
        });
        // Entrada
        await addTx({
          type: 'income', amount: cmd.amount,
          category: 'Transferência',
          description: `De ${from.name}`,
          accountId: to.id, transferGroup,
          date: cmd.date || todayISO(), paid: true,
        });
        flash(`${fmt(cmd.amount)}: ${from.name} → ${to.name}`);
        break;
      }
      case 'bill': {
        const b = await addBill({ name: cmd.name, amount: cmd.amount, dueDate: cmd.dueDate, paid: cmd.paid });
        flash(`Conta ${cmd.name} ${cmd.paid ? 'paga' : 'pendente'}`, 'ok', { kind: 'bill', id: b.id });
        break;
      }
      case 'bill_paid': {
        const found = bills.find(b => stripAccents(b.name.toLowerCase()) === stripAccents(cmd.name.toLowerCase()) && !b.paid);
        if (found) await updateBill(found.id, { paid: true, paidDate: cmd.date });
        if (cmd.amount) {
          await addTx({
            type: 'expense', amount: cmd.amount,
            category: 'Contas', description: `Conta ${cmd.name}`,
            date: cmd.date, paid: true,
          });
        }
        flash(`Conta ${cmd.name} paga`); break;
      }
      case 'correction': {
        if (!cmd.oldAmount || !cmd.newAmount) { flash('Correção precisa de valor antigo e novo', 'warn'); return; }
        const reversed = [...transactions].reverse();
        const target = reversed.find(tx => {
          if (Math.abs(tx.amount - cmd.oldAmount) > 0.01) return false;
          if (cmd.day) return new Date(tx.date + 'T00:00:00').getDate() === cmd.day;
          return true;
        });
        if (target) {
          await updateTx(target.id, { amount: cmd.newAmount });
          flash(`Corrigido: ${fmt(cmd.oldAmount)} → ${fmt(cmd.newAmount)}`);
        } else {
          flash('Não encontrei transação para corrigir', 'warn');
        }
        break;
      }
      // ============ EXCLUSÃO ============
      case 'delete_last': {
        // Decide qual coleção olhar
        const t = cmd.target;
        let removed = null, kind = null;
        if (/d[íi]vida/.test(t) && debts.length) {
          const last = [...debts].sort((a,b) => (b.id > a.id ? 1 : -1))[0];
          if (last) { await removeDebt(last.id); removed = last; kind = 'debt'; }
        } else if (/(conta|local)/.test(t) && accounts.length) {
          // Última conta criada
          const last = [...accounts].sort((a,b) => (b.createdAt||0) - (a.createdAt||0))[0];
          if (last) { await removeAccount(last.id); removed = last; kind = 'account'; }
        } else if (transactions.length) {
          // Última transação (por id, que tem timestamp)
          const last = transactions[transactions.length - 1];
          if (last) { await removeTx(last.id); removed = last; kind = 'tx'; }
        }
        if (removed) flash(`Removido: ${removed.description || removed.name || removed.person}`, 'ok', { kind, restore: removed });
        else flash('Nada para excluir', 'warn');
        break;
      }
      case 'delete_match': {
        const query = stripAccents(cmd.query.toLowerCase());
        const matchesTx = (tx) => {
          const desc = stripAccents((tx.description || '').toLowerCase());
          const cat = stripAccents((tx.category || '').toLowerCase());
          const amountOk = !cmd.amount || Math.abs(tx.amount - cmd.amount) < 0.01;
          return amountOk && (desc.includes(query) || cat.includes(query) || query.includes(desc) || query.includes(cat));
        };
        const matchesDebt = (d) => {
          const person = stripAccents((d.person || '').toLowerCase());
          const desc = stripAccents((d.description || '').toLowerCase());
          return person.includes(query) || query.includes(person) || desc.includes(query);
        };
        const matchesBill = (b) => stripAccents((b.name || '').toLowerCase()).includes(query);
        const matchesAcc = (a) => stripAccents((a.name || '').toLowerCase()).includes(query);

        let candidatesTx = [], candidatesDebt = [], candidatesBill = [], candidatesAcc = [];
        if (/gasto|despesa|receita|entrada|lan[çc]amento|transa[çc][ãa]o|any/.test(cmd.target)) {
          candidatesTx = transactions.filter(matchesTx);
        }
        if (/d[íi]vida|any/.test(cmd.target)) candidatesDebt = debts.filter(matchesDebt);
        if (/conta|any/.test(cmd.target)) candidatesBill = bills.filter(matchesBill);
        if (/conta|local|any/.test(cmd.target)) candidatesAcc = accounts.filter(matchesAcc);

        // Prioridade: tx → debt → bill → account
        const totalCount = candidatesTx.length + candidatesDebt.length + candidatesBill.length + candidatesAcc.length;
        if (totalCount === 0) { flash(`Não encontrei "${cmd.query}"`, 'warn'); break; }
        if (totalCount > 1 && candidatesTx.length > 1) {
          // Pega o mais recente
          const last = candidatesTx[candidatesTx.length - 1];
          await removeTx(last.id);
          flash(`Removido o mais recente · ${last.description}`, 'ok', { kind: 'tx', restore: last });
          if (candidatesTx.length > 1) {
            // Avisa que há outros parecidos (não-bloqueante)
            setTimeout(() => flash(`Há mais ${candidatesTx.length - 1} parecidos — repita para excluir`, 'warn'), 3200);
          }
          break;
        }
        if (candidatesTx.length === 1) {
          await removeTx(candidatesTx[0].id);
          flash(`Removido: ${candidatesTx[0].description || candidatesTx[0].category}`, 'ok', { kind: 'tx', restore: candidatesTx[0] });
        } else if (candidatesDebt.length >= 1) {
          await removeDebt(candidatesDebt[0].id);
          flash(`Dívida removida: ${candidatesDebt[0].person}`, 'ok', { kind: 'debt', restore: candidatesDebt[0] });
        } else if (candidatesBill.length >= 1) {
          await removeBill(candidatesBill[0].id);
          flash(`Conta removida: ${candidatesBill[0].name}`, 'ok', { kind: 'bill', restore: candidatesBill[0] });
        } else if (candidatesAcc.length >= 1) {
          await removeAccount(candidatesAcc[0].id);
          flash(`Local removido: ${candidatesAcc[0].name}`, 'ok', { kind: 'account', restore: candidatesAcc[0] });
        }
        break;
      }
      // ============ EDIÇÃO ============
      case 'edit_amount': {
        if (cmd.newAmount === null) { flash('Valor novo não identificado', 'warn'); break; }
        const query = stripAccents(cmd.query.toLowerCase());
        const matches = transactions.filter(tx => {
          const desc = stripAccents((tx.description || '').toLowerCase());
          const cat = stripAccents((tx.category || '').toLowerCase());
          return desc.includes(query) || cat.includes(query) || query.includes(desc);
        });
        if (matches.length === 0) { flash(`Não encontrei "${cmd.query}"`, 'warn'); break; }
        const target = matches[matches.length - 1]; // mais recente
        const oldAmt = target.amount;
        await updateTx(target.id, { amount: cmd.newAmount });
        flash(`${target.description}: ${fmt(oldAmt)} → ${fmt(cmd.newAmount)}`);
        if (matches.length > 1) {
          setTimeout(() => flash(`Há ${matches.length - 1} outros parecidos — repita para editar`, 'warn'), 3200);
        }
        break;
      }
      case 'rename': {
        // Tenta renomear conta primeiro (caso mais comum)
        const fromKey = stripAccents(cmd.from.toLowerCase());
        const acc = accounts.find(a => a.nameKey === fromKey || a.nameKey.includes(fromKey));
        if (acc) {
          await updateAccount(acc.id, { name: cmd.to });
          flash(`${acc.name} → ${cmd.to}`);
          break;
        }
        // Tenta renomear conta (bill)
        const bill = bills.find(b => stripAccents(b.name.toLowerCase()).includes(fromKey));
        if (bill) {
          await updateBill(bill.id, { name: cmd.to });
          flash(`Conta ${bill.name} → ${cmd.to}`);
          break;
        }
        flash(`Não encontrei "${cmd.from}" para renomear`, 'warn');
        break;
      }
      case 'card_purchase': {
        const p = await addCardPurchase({
          amount: cmd.amount,
          description: cmd.description,
          installments: cmd.installments,
          startMonth: nextMonth(monthKey()), // próxima fatura
        });
        const per = (cmd.amount / cmd.installments);
        flash(`Cartão · ${cmd.installments}x ${fmt(per)} · ${cmd.description}`, 'ok', { kind: 'card', id: p.id });
        break;
      }
      case 'card_payment': {
        // Calcula automaticamente o valor da fatura do mês se não foi dito
        const mKey = monthKey();
        let amt = cmd.amount;
        if (!amt) {
          const { total } = cardTotalForMonth(cardPurchases, mKey);
          amt = total;
        }
        if (!amt || amt === 0) { flash('Sem fatura de cartão para pagar', 'warn'); break; }
        await payCard(amt, mKey);
        flash(`Fatura paga: ${fmt(amt)} ✓`);
        break;
      }
      default: flash('Comando reconhecido mas não tratado', 'warn');
    }
  }, [debts, bills, transactions, accounts, cardPurchases, flash, scheduleNotification, resolveAccount, ensureAccount]);

  /* ----- Undo ----- */
  const doUndo = useCallback(async () => {
    if (!pendingUndo) return;
    // Caso 1: criação recente → remove
    if (pendingUndo.id && !pendingUndo.restore) {
      if (pendingUndo.kind === 'tx') await removeTx(pendingUndo.id);
      if (pendingUndo.kind === 'debt') await removeDebt(pendingUndo.id);
      if (pendingUndo.kind === 'bill') await removeBill(pendingUndo.id);
      if (pendingUndo.kind === 'account') await removeAccount(pendingUndo.id);
    }
    // Caso 2: exclusão recente → restaura
    if (pendingUndo.restore) {
      const r = pendingUndo.restore;
      if (pendingUndo.kind === 'tx') await addTx(r);
      if (pendingUndo.kind === 'debt') await addDebt(r);
      if (pendingUndo.kind === 'bill') await addBill(r);
      if (pendingUndo.kind === 'account') await addAccount(r);
    }
    setPendingUndo(null); setFeedback({ msg: 'Desfeito', kind: 'ok' });
    setTimeout(() => setFeedback(null), 1500);
    haptic(15);
  }, [pendingUndo, transactions, debts, bills, accounts]);

  /* ----- Voz ----- */
  const startVoice = useCallback((onResult) => {
    const r = recogRef.current;
    if (!r) { flash('Reconhecimento de voz não disponível', 'warn'); return; }
    r.onresult = (e) => onResult(e.results[0][0].transcript);
    try { r.start(); setListening(true); haptic(20); } catch {}
  }, [flash]);

  /* ----- Resumos memoizados com Map indexado ----- */
  const summary = useMemo(() => {
    const todayStr = todayISO();
    const mKey = monthKey();
    const weekStart = startOfWeek();
    let spentMonth = 0, spentWeek = 0, spentToday = 0, incomeMonth = 0;
    for (const tx of transactions) {
      const sameMonth = tx.month === mKey;
      const isToday = tx.date === todayStr;
      const d = new Date(tx.date + 'T00:00:00');
      const isThisWeek = d >= weekStart;
      if (tx.type === 'expense') {
        if (sameMonth) spentMonth += tx.amount;
        if (isThisWeek) spentWeek += tx.amount;
        if (isToday) spentToday += tx.amount;
      } else if (tx.type === 'income') {
        if (sameMonth) incomeMonth += tx.amount;
      }
    }
    let owedToMe = 0, iOwe = 0;
    for (const d of debts) {
      if (d.paid) continue;
      if (d.direction === 'owes_me') owedToMe += d.amount;
      else if (d.direction === 'i_owe') iOwe += d.amount;
    }
    let billsPending = 0;
    for (const b of bills) if (!b.paid) billsPending += (b.amount || 0);

    // Patrimônio = soma dos saldos das contas ativas + te devem − você deve − contas pendentes
    let accountsTotal = 0;
    for (const a of accounts) {
      if (a.archived) continue;
      accountsTotal += computeAccountBalance(a, transactions);
    }
    const netWorth = accountsTotal + owedToMe - iOwe - billsPending;

    // Cartão: fatura atual e próxima
    const cardThisMonth = cardTotalForMonth(cardPurchases, mKey);
    const cardNextMonthData = cardTotalForMonth(cardPurchases, nextMonth(mKey));
    // Detecta se a fatura do mês atual já foi paga
    const cardPaidThisMonth = cardPayments.some(p => p.month === mKey);

    return {
      spentMonth, spentWeek, spentToday, incomeMonth,
      remainingMonth: budget.monthly - spentMonth,
      remainingWeek: budget.weekly - spentWeek,
      owedToMe, iOwe, billsPending,
      accountsTotal, netWorth,
      cardThisMonth: cardThisMonth.total,
      cardThisMonthItems: cardThisMonth.items,
      cardNextMonth: cardNextMonthData.total,
      cardNextMonthItems: cardNextMonthData.items,
      cardPaidThisMonth,
      currentMonth: mKey,
    };
  }, [transactions, debts, bills, budget, accounts, cardPurchases, cardPayments]);

  /* ----- Export / Import ----- */
  const exportData = useCallback(async () => {
    const data = {
      version: 3, exportedAt: new Date().toISOString(),
      transactions, debts, bills, accounts, cardPurchases, cardPayments, budget,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `strix-backup-${todayISO()}.json`;
    a.click(); URL.revokeObjectURL(url);
    flash('Backup baixado');
  }, [transactions, debts, bills, accounts, cardPurchases, cardPayments, budget, flash]);

  const importData = useCallback(async (file) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.version) throw new Error('Arquivo inválido');
      // Limpa tudo
      const db = await openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(['transactions','debts','bills','accounts','cardPurchases','cardPayments','meta'], 'readwrite');
        tx.objectStore('transactions').clear();
        tx.objectStore('debts').clear();
        tx.objectStore('bills').clear();
        tx.objectStore('accounts').clear();
        tx.objectStore('cardPurchases').clear();
        tx.objectStore('cardPayments').clear();
        tx.objectStore('meta').delete('budget');
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      for (const t of (data.transactions || [])) await dbPut('transactions', { ...t, month: t.date?.slice(0,7) });
      for (const d of (data.debts || [])) await dbPut('debts', { ...d, personKey: stripAccents((d.person||'').toLowerCase()) });
      for (const b of (data.bills || [])) await dbPut('bills', b);
      for (const a of (data.accounts || [])) await dbPut('accounts', { ...a, nameKey: stripAccents((a.name||'').toLowerCase()) });
      for (const c of (data.cardPurchases || [])) await dbPut('cardPurchases', c);
      for (const cp of (data.cardPayments || [])) await dbPut('cardPayments', cp);
      if (data.budget) await dbPut('meta', { key: 'budget', value: data.budget });
      setTransactions(data.transactions || []);
      setDebts(data.debts || []);
      setBills(data.bills || []);
      setAccounts(data.accounts || []);
      setCardPurchases(data.cardPurchases || []);
      setCardPayments(data.cardPayments || []);
      if (data.budget) setBudget(data.budget);
      flash('Dados restaurados');
    } catch (e) {
      console.error(e); flash('Erro ao importar', 'warn');
    }
  }, [flash]);

  /* ----- Install PWA ----- */
  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const promptInstall = useCallback(async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') setInstallPrompt(null);
  }, [installPrompt]);

  /* ----- Notificações: pede permissão na primeira visita após primeira ação ----- */
  const askNotifPermission = useCallback(async () => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch {}
    }
  }, []);

  /* ----- Notificações periódicas: orçamento da semana ----- */
  useEffect(() => {
    if (!loaded || !budget.weekly) return;
    if (Notification?.permission !== 'granted') return;
    // Notifica se já gastou >80% do semanal
    if (summary.spentWeek > budget.weekly * 0.8 && !sessionStorage.getItem('strix-warned-week')) {
      scheduleNotification('Strix · alerta de orçamento',
        `Você já gastou ${fmt(summary.spentWeek)} dos ${fmt(budget.weekly)} semanais.`,
        Date.now() + 1000, 'budget-week');
      sessionStorage.setItem('strix-warned-week', '1');
    }
  }, [summary.spentWeek, budget.weekly, loaded, scheduleNotification]);

  /* ----- Render ----- */
  if (!loaded) return null;

  const styles = makeStyles(t, theme);

  return h('div', { style: styles.app },
    h(GlobalStyles, { t, theme }),
    // Header
    h('div', { style: styles.header },
      h('div', { style: styles.brand },
        h(StrixOwl, { size: 44, theme }),
        h('div', null,
          h('div', { style: styles.brandName }, 'strix'),
          h('div', { style: { fontSize: 11, color: t.textDim, letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: -2 } },
            'finanças sob comando')
        )
      ),
      h('div', { style: { display: 'flex', gap: 8 } },
        installPrompt && h('button', {
          style: { ...styles.iconBtn, background: t.accent, color: '#fff', border: 'none', width: 'auto', padding: '0 14px', fontSize: 13, fontWeight: 600 },
          onClick: promptInstall,
        }, 'Instalar'),
        h('button', {
          style: styles.iconBtn,
          onClick: () => { setTheme(theme === 'dark' ? 'light' : 'dark'); haptic(); },
          'aria-label': 'Tema',
        }, theme === 'dark' ? '☾' : '☀')
      )
    ),

    // Conteúdo
    h('div', { style: { maxWidth: 480, margin: '0 auto', padding: '0 16px' } },
      tab === 'home' && h(HomeTab, {
        t, theme, styles, summary, budget, transactions, accounts,
        onCommand: handleCommand, startVoice,
        onRemoveTx: async (id) => { await removeTx(id); flash('Removido'); },
        onEditTx: (tx) => setEditing({ kind: 'tx', item: tx }),
        onEditBudget: (val) => { setBudget(b => ({ ...b, monthly: val, month: monthKey() })); flash(`Orçamento: ${fmt(val)}`); },
        onPayCard: async () => {
          if (summary.cardThisMonth === 0) return;
          if (!confirm(`Pagar fatura de ${fmt(summary.cardThisMonth)}?`)) return;
          await payCard(summary.cardThisMonth, summary.currentMonth);
          flash(`Fatura paga: ${fmt(summary.cardThisMonth)} ✓`);
        },
        onViewCard: () => setTab('card'),
        askNotifPermission,
      }),
      tab === 'card' && h(CardTab, {
        t, styles, cardPurchases, cardPayments, summary,
        onCommand: handleCommand,
        onPayCard: async () => {
          if (summary.cardThisMonth === 0) return;
          if (!confirm(`Pagar fatura de ${fmt(summary.cardThisMonth)}?`)) return;
          await payCard(summary.cardThisMonth, summary.currentMonth);
          flash(`Fatura paga: ${fmt(summary.cardThisMonth)} ✓`);
        },
        removeCardPurchase: async (id) => {
          if (!confirm('Apagar esta compra do cartão? Todas as parcelas serão removidas.')) return;
          await removeCardPurchase(id); flash('Compra removida');
        },
        toggleActive: (id) => {
          const p = cardPurchases.find(x => x.id === id);
          if (p) updateCardPurchase(id, { active: !p.active });
        },
      }),
      tab === 'wealth' && h(WealthTab, {
        t, styles, accounts, transactions, summary,
        onCommand: handleCommand,
        toggleArchive: (id) => updateAccount(id, { archived: !accounts.find(a=>a.id===id)?.archived }),
        onEdit: (acc) => setEditing({ kind: 'account', item: acc }),
        removeAccount: async (id) => {
          const acc = accounts.find(a => a.id === id);
          if (!acc) return;
          const linked = transactions.filter(tx => tx.accountId === id).length;
          if (linked > 0) {
            if (!confirm(`${linked} transaçōes estão vinculadas a "${acc.name}". Apagar conta vai desvincular (transaçōes ficam). Continuar?`)) return;
          } else {
            if (!confirm(`Apagar conta "${acc.name}"?`)) return;
          }
          await removeAccount(id);
          // Desvincula transações
          for (const tx of transactions.filter(t => t.accountId === id)) {
            await updateTx(tx.id, { accountId: null });
          }
          flash('Conta removida');
        },
      }),
      tab === 'dashboard' && h(DashboardTab, {
        t, theme, styles, transactions, summary,
      }),
      tab === 'details' && h(DetailsTab, {
        t, styles, debts, bills, transactions, accounts,
        toggleDebt: (id) => updateDebt(id, { paid: !debts.find(d=>d.id===id)?.paid, paidDate: todayISO() }),
        toggleBill: (id) => updateBill(id, { paid: !bills.find(b=>b.id===id)?.paid, paidDate: todayISO() }),
        removeDebt: async (id) => { await removeDebt(id); flash('Removido'); },
        removeBill: async (id) => { await removeBill(id); flash('Removido'); },
        removeTx: async (id) => { await removeTx(id); flash('Removido'); },
        onEditTx: (tx) => setEditing({ kind: 'tx', item: tx }),
        onEditDebt: (d) => setEditing({ kind: 'debt', item: d }),
        onEditBill: (b) => setEditing({ kind: 'bill', item: b }),
      }),
      tab === 'settings' && h(SettingsTab, {
        t, styles, theme, setTheme, exportData, importData, askNotifPermission,
      })
    ),

    // EDIT MODAL
    editing && h(EditModal, {
      t, theme, editing, setEditing, accounts,
      onSave: async (patch) => {
        const { kind, item } = editing;
        if (kind === 'tx') await updateTx(item.id, patch);
        if (kind === 'debt') await updateDebt(item.id, patch);
        if (kind === 'bill') await updateBill(item.id, patch);
        if (kind === 'account') await updateAccount(item.id, patch);
        setEditing(null);
        flash('Atualizado');
      },
    }),

    // Toast com undo
    feedback && h('div', {
      style: {
        position: 'fixed', top: 'calc(env(safe-area-inset-top) + 70px)',
        left: '50%', transform: 'translateX(-50%)',
        background: feedback.kind === 'warn' ? t.warning : t.success,
        color: '#000', padding: '10px 14px', borderRadius: 12,
        fontWeight: 600, fontSize: 13, zIndex: 100,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        animation: 'fadeIn 0.3s ease', maxWidth: 360,
        display: 'flex', alignItems: 'center', gap: 10,
      }
    },
      h('span', null, feedback.msg),
      pendingUndo && h('button', {
        onClick: doUndo,
        style: { background: 'rgba(0,0,0,0.2)', border: 'none', borderRadius: 8, padding: '4px 10px', fontWeight: 700, fontSize: 12, cursor: 'pointer', color: '#000' }
      }, 'desfazer')
    ),

    // Floating assistant
    h(FloatingAssistant, {
      t, theme, open: assistantOpen, setOpen: setAssistantOpen,
      onSubmit: (txt) => { handleCommand(txt); setAssistantOpen(false); },
      startVoice, listening,
    }),

    // Tab bar
    h('div', { style: styles.tabBar },
      [
        ['home', '◐', 'Capturar'],
        ['wealth', '◈', 'Patrimônio'],
        ['dashboard', '▦', 'Painel'],
        ['details', '◎', 'Detalhes'],
        ['settings', '⚙', 'Ajustes'],
      ].map(([id, icon, label]) =>
        h('button', {
          key: id, style: styles.tab(tab === id),
          onClick: () => { setTab(id); haptic(5); }
        },
          h('span', { style: { fontSize: 17 } }, icon),
          h('span', null, label)
        )
      )
    )
  );
}

/* ===================== STYLES FACTORY ===================== */
function makeStyles(t, theme) {
  return {
    app: {
      minHeight: '100vh',
      background: t.bgGrad,
      color: t.text,
      paddingBottom: `calc(env(safe-area-inset-bottom) + 100px)`,
      transition: 'background 0.4s, color 0.3s',
    },
    header: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '20px 16px 12px', maxWidth: 480, margin: '0 auto',
    },
    brand: { display: 'flex', alignItems: 'center', gap: 12 },
    brandName: {
      fontSize: 28, fontWeight: 700, letterSpacing: '-0.03em',
      background: `linear-gradient(135deg, ${t.text} 0%, ${t.accent} 120%)`,
      WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
      backgroundClip: 'text', color: 'transparent',
      lineHeight: 1,
    },
    iconBtn: {
      minWidth: 40, height: 40, borderRadius: 12,
      background: t.surface, border: `1px solid ${t.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', color: t.text, fontSize: 18,
    },
    card: {
      background: t.surface, borderRadius: 18, padding: '16px 18px',
      border: `1px solid ${t.border}`,
    },
    cardTitle: {
      fontSize: 11, fontWeight: 500, color: t.textDim,
      textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10,
    },
    bigNumber: {
      fontSize: 34, fontWeight: 600, letterSpacing: '-0.025em',
      lineHeight: 1.1, fontVariantNumeric: 'tabular-nums',
    },
    tabBar: {
      position: 'fixed',
      bottom: `calc(env(safe-area-inset-bottom) + 12px)`,
      left: 12, right: 12, maxWidth: 456, margin: '0 auto',
      background: theme === 'dark' ? 'rgba(28,28,30,0.85)' : 'rgba(255,255,255,0.85)',
      backdropFilter: 'blur(20px) saturate(180%)',
      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      border: `1px solid ${t.border}`, borderRadius: 22, padding: 5,
      display: 'flex', justifyContent: 'space-around',
      boxShadow: '0 8px 32px rgba(0,0,0,0.3)', zIndex: 50,
    },
    tab: (active) => ({
      flex: 1, padding: '8px 2px', borderRadius: 16,
      background: active ? t.accentSoft : 'transparent',
      color: active ? t.accent : t.textDim,
      fontWeight: active ? 600 : 500, fontSize: 9,
      border: 'none', cursor: 'pointer',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      minWidth: 0,
    }),
    input: {
      width: '100%', padding: '13px 14px', borderRadius: 14,
      background: t.surfaceHi, border: `1px solid ${t.border}`,
      color: t.text, fontSize: 15, outline: 'none',
      fontFamily: 'inherit', boxSizing: 'border-box',
    },
    primaryBtn: {
      padding: '12px 20px', borderRadius: 14,
      background: t.accent, color: '#fff',
      border: 'none', fontWeight: 600, fontSize: 15,
      cursor: 'pointer', fontFamily: 'inherit',
    },
  };
}

/* ===================== GLOBAL STYLES ===================== */
const GlobalStyles = memo(function GlobalStyles({ t, theme }) {
  return h('style', null, `
    * { box-sizing: border-box; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    @keyframes pulseRed {
      0%,100% { box-shadow: 0 0 0 0 ${t.accent}66; }
      50% { box-shadow: 0 0 0 12px ${t.accent}00; }
    }
    .strix-fade { animation: fadeIn 0.35s ease; }
    .strix-listening { animation: pulseRed 1.5s infinite; }
    input::placeholder { color: ${t.textFaint}; }
    button { font-family: inherit; -webkit-appearance: none; }
    button:active { opacity: 0.7; }
  `);
});

/* ===================== HOME ===================== */
const HomeTab = memo(function HomeTab({ t, theme, styles, summary, budget, transactions, accounts, onCommand, startVoice, onRemoveTx, onEditTx, onEditBudget, askNotifPermission, onPayCard, onViewCard }) {
  const [input, setInput] = useState('');
  const [listening, setListening] = useState(false);
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState('');

  const todayTx = useMemo(() => {
    const today = todayISO();
    return transactions.filter(tx => tx.date === today).slice().reverse();
  }, [transactions]);

  const recentTx = useMemo(() => {
    const today = todayISO();
    return transactions.slice(-12).reverse().filter(tx => tx.date !== today).slice(0, 8);
  }, [transactions]);

  const submit = () => {
    if (!input.trim()) return;
    onCommand(input);
    setInput('');
    askNotifPermission();
  };

  const remainingPct = budget.monthly > 0
    ? Math.max(0, Math.min(100, (summary.remainingMonth / budget.monthly) * 100)) : 0;

  const saveBudget = () => {
    const val = parseAmount(budgetDraft);
    if (val !== null && val >= 0) {
      onEditBudget(val);
      setEditingBudget(false);
    }
  };

  const examples = useMemo(() => [
    'gastei 30 em gasolina',
    'comprei algo de 600 no cartão em 3x',
    'paguei o cartão',
    'joão me deve 50',
  ], []);

  const handleVoice = useCallback(() => {
    setListening(true);
    startVoice((transcript) => { setInput(transcript); setListening(false); });
  }, [startVoice]);

  return h('div', { className: 'strix-fade' },
    // Hero: orçamento + saldo disponível (EDITÁVEL)
    h('div', { style: { ...styles.card, marginBottom: 12, position: 'relative', overflow: 'hidden' } },
      h('div', {
        style: {
          position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%',
          background: `radial-gradient(circle, ${t.accentSoft} 0%, transparent 70%)`,
          pointerEvents: 'none',
        }
      }),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        h('div', { style: styles.cardTitle }, 'Disponível este mês'),
        h('button', {
          onClick: () => { setBudgetDraft(String(budget.monthly || '')); setEditingBudget(true); },
          style: {
            background: 'transparent', border: 'none', color: t.accent,
            fontSize: 11, fontWeight: 600, cursor: 'pointer',
            textTransform: 'uppercase', letterSpacing: '0.06em',
          }
        }, budget.monthly > 0 ? '✎ ajustar' : '+ definir')
      ),
      editingBudget
        ? h('div', { style: { marginTop: 8 } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', { style: { fontSize: 24, fontWeight: 600, color: t.textDim } }, 'R$'),
              h('input', {
                autoFocus: true,
                type: 'text',
                inputMode: 'decimal',
                value: budgetDraft,
                onChange: (e) => setBudgetDraft(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') saveBudget(); if (e.key === 'Escape') setEditingBudget(false); },
                style: {
                  flex: 1, fontSize: 28, fontWeight: 600, color: t.text,
                  background: 'transparent', border: 'none', outline: 'none',
                  fontVariantNumeric: 'tabular-nums',
                  fontFamily: 'inherit', letterSpacing: '-0.02em',
                  borderBottom: `2px solid ${t.accent}`, paddingBottom: 2,
                },
              })
            ),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
              h('button', {
                onClick: saveBudget,
                style: { ...styles.primaryBtn, flex: 1, padding: '10px' }
              }, 'Salvar'),
              h('button', {
                onClick: () => setEditingBudget(false),
                style: {
                  flex: 1, padding: '10px', borderRadius: 12,
                  background: t.surfaceHi, color: t.text, border: `1px solid ${t.border}`,
                  fontWeight: 500, fontSize: 14, cursor: 'pointer',
                }
              }, 'Cancelar')
            )
          )
        : h(Fragment, null,
            h('div', {
              style: {
                ...styles.bigNumber, color: summary.remainingMonth >= 0 ? t.text : t.danger,
                fontVariantNumeric: 'tabular-nums',
              }
            }, budget.monthly > 0 ? fmt(summary.remainingMonth) : 'R$ 0,00'),
            budget.monthly > 0 && h('div', { style: { marginTop: 14 } },
              h('div', { style: { height: 6, borderRadius: 3, background: t.surfaceHi, overflow: 'hidden' } },
                h('div', {
                  style: {
                    height: '100%', width: `${remainingPct}%`,
                    background: `linear-gradient(90deg, ${t.accent}, ${t.accentDim})`,
                    borderRadius: 3, transition: 'width 0.5s ease',
                  }
                })
              ),
              h('div', {
                style: {
                  display: 'flex', justifyContent: 'space-between',
                  marginTop: 8, fontSize: 12, color: t.textDim,
                  fontVariantNumeric: 'tabular-nums',
                }
              },
                h('span', null, `Gastei ${fmt(summary.spentMonth)}`),
                h('span', null, `Limite ${fmt(budget.monthly)}`)
              )
            ),
            !budget.monthly && h('div', { style: { fontSize: 12, color: t.textDim, marginTop: 8 } },
              'Toque em "+ definir" ou diga "esse mês posso gastar X"'
            )
          )
    ),
    // Stat row: Hoje + Semana
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 } },
      h('div', { style: styles.card },
        h('div', { style: styles.cardTitle }, 'Hoje'),
        h('div', { style: { ...styles.bigNumber, fontSize: 22, fontVariantNumeric: 'tabular-nums' } }, fmt(summary.spentToday))
      ),
      h('div', { style: styles.card },
        h('div', { style: styles.cardTitle }, budget.weekly > 0 ? 'Restam na semana' : 'Gasto na semana'),
        h('div', {
          style: {
            ...styles.bigNumber, fontSize: 22,
            color: budget.weekly > 0 && summary.remainingWeek < 0 ? t.danger : t.text,
            fontVariantNumeric: 'tabular-nums',
          }
        }, budget.weekly > 0 ? fmt(summary.remainingWeek) : fmt(summary.spentWeek))
      )
    ),
    // CARD CARTÃO DE CRÉDITO (sempre visível, separado do orçamento)
    h(CardSummaryBlock, {
      t, styles, summary,
      onPayCard, onViewCard,
    }),
    // Captura
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, 'Captura rápida'),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('input', {
          style: styles.input, placeholder: 'Ex: "gastei 30 em gasolina"',
          value: input, onChange: (e) => setInput(e.target.value),
          onKeyDown: (e) => e.key === 'Enter' && submit(),
        }),
        h('button', {
          style: { ...styles.iconBtn, background: listening ? t.accent : t.surfaceHi,
            color: listening ? '#fff' : t.text, width: 48, height: 48, flexShrink: 0 },
          className: listening ? 'strix-listening' : '',
          onClick: handleVoice, 'aria-label': 'Falar'
        }, '🎙')
      ),
      h('button', {
        style: { ...styles.primaryBtn, marginTop: 10, width: '100%', opacity: input.trim() ? 1 : 0.5 },
        onClick: submit, disabled: !input.trim(),
      }, 'Registrar'),
      h('div', { style: { marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 } },
        examples.map(s => h('button', {
          key: s, onClick: () => setInput(s),
          style: {
            fontSize: 11, padding: '6px 10px', borderRadius: 10,
            background: t.surfaceHi, color: t.textDim,
            border: `1px solid ${t.border}`, cursor: 'pointer',
          }
        }, s))
      )
    ),
    // Devedores resumo
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 } },
      h('div', { style: styles.card },
        h('div', { style: styles.cardTitle }, 'Te devem'),
        h('div', { style: { fontSize: 22, fontWeight: 600, color: t.success, fontVariantNumeric: 'tabular-nums' } }, fmt(summary.owedToMe))
      ),
      h('div', { style: styles.card },
        h('div', { style: styles.cardTitle }, 'Você deve'),
        h('div', { style: { fontSize: 22, fontWeight: 600, color: t.danger, fontVariantNumeric: 'tabular-nums' } }, fmt(summary.iOwe + summary.billsPending))
      )
    ),
    // Hoje
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, `Hoje · ${todayTx.length} ${todayTx.length === 1 ? 'lançamento' : 'lançamentos'}`),
      todayTx.length === 0
        ? h('div', { style: { padding: '24px 8px', textAlign: 'center', color: t.textFaint, fontSize: 14 } },
            'Nenhum lançamento hoje. Capture um agora.')
        : todayTx.map(tx => h(TxRow, { key: tx.id, tx, t, onDelete: () => onRemoveTx(tx.id), onEdit: () => onEditTx && onEditTx(tx) }))
    ),
    // Recentes
    recentTx.length > 0 && h('div', { style: styles.card },
      h('div', { style: styles.cardTitle }, 'Recentes'),
      recentTx.map(tx => h(TxRow, { key: tx.id, tx, t, onDelete: () => onRemoveTx(tx.id), onEdit: () => onEditTx && onEditTx(tx) }))
    )
  );
});

// Bloco de cartão de crédito — sempre visível na home
const CardSummaryBlock = memo(function CardSummaryBlock({ t, styles, summary, onPayCard, onViewCard }) {
  const { cardThisMonth, cardNextMonth, cardPaidThisMonth, currentMonth } = summary;
  // Se não há compras ativas em nenhum mês, mostra um card mais sutil
  if (cardThisMonth === 0 && cardNextMonth === 0) {
    return h('div', {
      style: {
        ...styles.card, marginBottom: 12,
        borderStyle: 'dashed', borderColor: t.border,
        cursor: 'pointer',
      },
      onClick: onViewCard,
    },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('div', null,
          h('div', { style: styles.cardTitle }, 'Cartão de crédito'),
          h('div', { style: { fontSize: 13, color: t.textDim, marginTop: 4 } },
            'Nenhuma compra parcelada')
        ),
        h('div', { style: { color: t.accent, fontSize: 20 } }, '+')
      )
    );
  }
  return h('div', {
    style: { ...styles.card, marginBottom: 12, cursor: 'pointer' },
    onClick: onViewCard,
  },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
      h('div', { style: styles.cardTitle }, 'Cartão de crédito'),
      cardPaidThisMonth && h('span', {
        style: {
          fontSize: 10, fontWeight: 600, padding: '3px 8px',
          background: 'rgba(48,209,88,0.15)', color: t.success,
          borderRadius: 8, textTransform: 'uppercase', letterSpacing: '0.04em',
        }
      }, '✓ paga')
    ),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
      h('div', null,
        h('div', { style: { fontSize: 10, color: t.textDim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 } },
          cardPaidThisMonth ? `${monthLabel(currentMonth)} (paga)` : `${monthLabel(currentMonth)}`),
        h('div', {
          style: {
            fontSize: 22, fontWeight: 600,
            color: cardPaidThisMonth ? t.textDim : t.text,
            textDecoration: cardPaidThisMonth ? 'line-through' : 'none',
            fontVariantNumeric: 'tabular-nums',
          }
        }, fmt(cardThisMonth))
      ),
      h('div', null,
        h('div', { style: { fontSize: 10, color: t.textDim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 } },
          monthLabel(nextMonth(currentMonth))),
        h('div', {
          style: {
            fontSize: 22, fontWeight: 600, color: t.accent,
            fontVariantNumeric: 'tabular-nums',
          }
        }, fmt(cardNextMonth))
      )
    ),
    !cardPaidThisMonth && cardThisMonth > 0 && h('button', {
      onClick: (e) => { e.stopPropagation(); onPayCard(); },
      style: {
        marginTop: 12, width: '100%', padding: '10px',
        borderRadius: 12, border: `1px solid ${t.accent}`,
        background: 'transparent', color: t.accent,
        fontSize: 13, fontWeight: 600, cursor: 'pointer',
      }
    }, `Pagar fatura ${fmt(cardThisMonth)}`)
  );
});

const TxRow = memo(function TxRow({ tx, t, onDelete, onEdit }) {
  const isExp = tx.type === 'expense';
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 0', borderBottom: `1px solid ${t.border}`,
    }
  },
    h('div', {
      style: {
        width: 36, height: 36, borderRadius: 12,
        background: isExp ? t.accentSoft : 'rgba(48,209,88,0.12)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: isExp ? t.accent : t.success, fontSize: 16, fontWeight: 700,
      }
    }, isExp ? '−' : '+'),
    h('div', {
      onClick: onEdit,
      style: { flex: 1, minWidth: 0, cursor: onEdit ? 'pointer' : 'default' }
    },
      h('div', {
        style: {
          fontSize: 14, fontWeight: 500, color: t.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }
      }, tx.description || tx.category),
      h('div', { style: { fontSize: 11, color: t.textDim, marginTop: 2 } },
        `${tx.category} · ${new Date(tx.date + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`)
    ),
    h('div', { style: { fontSize: 15, fontWeight: 600, color: isExp ? t.text : t.success } }, fmt(tx.amount)),
    onEdit && h('button', {
      onClick: onEdit,
      style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 14, padding: 4 },
      title: 'Editar',
    }, '✎'),
    h('button', {
      onClick: () => { if (confirm('Remover este lançamento?')) onDelete(); },
      style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 18, padding: 4 }
    }, '×')
  );
});

/* ===================== WEALTH (Patrimônio) ===================== */
const WealthTab = memo(function WealthTab({ t, styles, accounts, transactions, summary, onCommand, toggleArchive, removeAccount, onEdit }) {
  const [input, setInput] = useState('');

  const activeAccounts = useMemo(() =>
    accounts.filter(a => !a.archived)
      .map(a => ({ ...a, balance: computeAccountBalance(a, transactions) }))
      .sort((a, b) => b.balance - a.balance),
  [accounts, transactions]);

  const archivedAccounts = useMemo(() =>
    accounts.filter(a => a.archived)
      .map(a => ({ ...a, balance: computeAccountBalance(a, transactions) })),
  [accounts, transactions]);

  const unassignedTotal = useMemo(() => {
    let inc = 0, exp = 0;
    for (const tx of transactions) {
      if (tx.accountId) continue;
      if (tx.type === 'income') inc += tx.amount;
      else if (tx.type === 'expense') exp += tx.amount;
    }
    return inc - exp;
  }, [transactions]);

  const submit = () => {
    if (!input.trim()) return;
    onCommand(input);
    setInput('');
  };

  const examples = [
    'tenho 500 no nubank',
    'tenho 1500 na conta do itaú',
    'tenho 300 na carteira',
    'caiu 3000 de salário no nubank',
    'transferi 200 do itaú pro nubank',
    'ajusta nubank para 450',
  ];

  return h('div', { className: 'strix-fade' },
    // Hero: patrimônio líquido
    h('div', { style: { ...styles.card, marginBottom: 12, position: 'relative', overflow: 'hidden' } },
      h('div', {
        style: {
          position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%',
          background: `radial-gradient(circle, ${t.accentSoft} 0%, transparent 70%)`, pointerEvents: 'none',
        }
      }),
      h('div', { style: styles.cardTitle }, 'Patrimônio líquido'),
      h('div', { style: { ...styles.bigNumber, color: summary.netWorth >= 0 ? t.text : t.danger } },
        fmt(summary.netWorth)),
      h('div', { style: { fontSize: 11, color: t.textDim, marginTop: 6 } },
        'soma das contas + te devem − você deve − contas pendentes')
    ),

    // Breakdown
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 } },
      h(KPI, { t, label: 'Em contas', value: fmt(summary.accountsTotal), accent: t.text }),
      h(KPI, { t, label: 'A receber', value: fmt(summary.owedToMe), accent: t.success }),
      h(KPI, { t, label: 'A pagar', value: fmt(summary.iOwe + summary.billsPending), accent: t.danger }),
      h(KPI, { t, label: 'Não atribuído', value: fmt(unassignedTotal), accent: t.textDim })
    ),

    // Captura
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, 'Adicionar local ou registrar saldo'),
      h('input', {
        style: styles.input,
        placeholder: 'Ex: "tenho 500 no nubank"',
        value: input,
        onChange: (e) => setInput(e.target.value),
        onKeyDown: (e) => e.key === 'Enter' && submit(),
      }),
      h('button', {
        style: { ...styles.primaryBtn, marginTop: 10, width: '100%', opacity: input.trim() ? 1 : 0.5 },
        onClick: submit, disabled: !input.trim(),
      }, 'Registrar'),
      h('div', { style: { marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 } },
        examples.map(s => h('button', {
          key: s, onClick: () => setInput(s),
          style: {
            fontSize: 11, padding: '6px 10px', borderRadius: 10,
            background: t.surfaceHi, color: t.textDim,
            border: `1px solid ${t.border}`, cursor: 'pointer',
          }
        }, s))
      )
    ),

    // Lista de contas
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, `Locais · ${activeAccounts.length}`),
      activeAccounts.length === 0
        ? h('div', { style: { padding: '24px 8px', textAlign: 'center', color: t.textFaint, fontSize: 14 } },
            'Nenhum local cadastrado. Diga "tenho X no nubank" para começar.')
        : activeAccounts.map(a => h(AccountRow, {
            key: a.id, account: a, t,
            onArchive: () => toggleArchive(a.id),
            onDelete: () => removeAccount(a.id),
            onEdit: () => onEdit && onEdit(a),
          }))
    ),

    // Arquivadas
    archivedAccounts.length > 0 && h('div', { style: styles.card },
      h('div', { style: styles.cardTitle }, `Arquivadas · ${archivedAccounts.length}`),
      archivedAccounts.map(a => h(AccountRow, {
        key: a.id, account: a, t, archived: true,
        onArchive: () => toggleArchive(a.id),
        onDelete: () => removeAccount(a.id),
        onEdit: () => onEdit && onEdit(a),
      }))
    )
  );
});

const AccountRow = memo(function AccountRow({ account, t, archived, onArchive, onDelete, onEdit }) {
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 0', borderBottom: `1px solid ${t.border}`,
      opacity: archived ? 0.5 : 1,
    }
  },
    h('div', {
      style: {
        width: 36, height: 36, borderRadius: 12,
        background: account.balance >= 0 ? 'rgba(48,209,88,0.12)' : t.accentSoft,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: account.balance >= 0 ? t.success : t.accent, fontSize: 14, fontWeight: 600, flexShrink: 0,
      }
    }, '◈'),
    h('div', {
      onClick: onEdit,
      style: { flex: 1, minWidth: 0, cursor: onEdit ? 'pointer' : 'default' }
    },
      h('div', {
        style: {
          fontSize: 14, fontWeight: 600, color: t.text, textTransform: 'capitalize',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }
      }, account.name),
      h('div', { style: { fontSize: 11, color: t.textDim, marginTop: 2 } },
        `inicial ${fmt(account.initialBalance)}`)
    ),
    h('div', {
      style: { fontSize: 15, fontWeight: 700, color: account.balance >= 0 ? t.text : t.danger }
    }, fmt(account.balance)),
    onEdit && h('button', {
      onClick: onEdit,
      style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 14, padding: 4 },
      title: 'Editar',
    }, '✎'),
    h('button', {
      onClick: onArchive,
      style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 14, padding: 4 },
      title: archived ? 'Desarquivar' : 'Arquivar',
    }, archived ? '↑' : '↓'),
    h('button', {
      onClick: onDelete,
      style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 18, padding: 4 }
    }, '×')
  );
});

/* ===================== CARD (Cartão de crédito) ===================== */
const CardTab = memo(function CardTab({ t, styles, cardPurchases, cardPayments, summary, onCommand, onPayCard, removeCardPurchase, toggleActive }) {
  const [input, setInput] = useState('');
  const [viewMonth, setViewMonth] = useState(summary.currentMonth);

  const monthData = useMemo(() => cardTotalForMonth(cardPurchases, viewMonth), [cardPurchases, viewMonth]);
  const monthPayment = useMemo(() => cardPayments.find(p => p.month === viewMonth), [cardPayments, viewMonth]);

  // Próximos 6 meses para navegação
  const nextSixMonths = useMemo(() => {
    const arr = [];
    let m = summary.currentMonth;
    for (let i = 0; i < 6; i++) { arr.push(m); m = nextMonth(m); }
    return arr;
  }, [summary.currentMonth]);

  const activePurchases = cardPurchases.filter(p => p.active);
  const archivedPurchases = cardPurchases.filter(p => !p.active);

  const submit = () => {
    if (!input.trim()) return;
    onCommand(input); setInput('');
  };

  return h('div', { className: 'strix-fade' },
    // Hero
    h('div', { style: { ...styles.card, marginBottom: 12, position: 'relative', overflow: 'hidden' } },
      h('div', {
        style: {
          position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%',
          background: `radial-gradient(circle, ${t.accentSoft} 0%, transparent 70%)`, pointerEvents: 'none',
        }
      }),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        h('div', { style: styles.cardTitle }, `Fatura · ${monthLabel(viewMonth)}`),
        monthPayment && h('span', {
          style: {
            fontSize: 10, fontWeight: 600, padding: '3px 8px',
            background: 'rgba(48,209,88,0.15)', color: t.success,
            borderRadius: 8, textTransform: 'uppercase', letterSpacing: '0.04em',
          }
        }, '✓ paga')
      ),
      h('div', {
        style: {
          ...styles.bigNumber,
          color: monthPayment ? t.textDim : t.text,
          textDecoration: monthPayment ? 'line-through' : 'none',
          fontVariantNumeric: 'tabular-nums',
        }
      }, fmt(monthData.total)),
      h('div', { style: { fontSize: 12, color: t.textDim, marginTop: 6 } },
        `${monthData.items.length} ${monthData.items.length === 1 ? 'parcela' : 'parcelas'}`
      ),
      !monthPayment && viewMonth === summary.currentMonth && monthData.total > 0 && h('button', {
        onClick: onPayCard,
        style: {
          marginTop: 14, width: '100%', padding: '12px',
          borderRadius: 12, background: t.accent, color: '#fff',
          border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer',
        }
      }, `Pagar ${fmt(monthData.total)}`)
    ),

    // Navegação por mês
    h('div', { style: { ...styles.card, marginBottom: 12, padding: 8 } },
      h('div', {
        style: {
          display: 'flex', gap: 4, overflowX: 'auto',
          scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch',
        }
      },
        nextSixMonths.map(m => {
          const data = cardTotalForMonth(cardPurchases, m);
          const isPaid = cardPayments.some(p => p.month === m);
          const active = m === viewMonth;
          return h('button', {
            key: m, onClick: () => setViewMonth(m),
            style: {
              flexShrink: 0, padding: '8px 12px', borderRadius: 10,
              background: active ? t.accent : t.surfaceHi,
              color: active ? '#fff' : t.text,
              border: 'none', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              minWidth: 72,
            },
          },
            h('div', { style: { fontSize: 10, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase' } },
              monthLabel(m).split(' ')[0].slice(0, 3)),
            h('div', { style: { fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } },
              data.total > 0 ? fmt(data.total).replace('R$ ', '') : '—'),
            isPaid && h('div', { style: { fontSize: 8, opacity: 0.7 } }, '✓')
          );
        })
      )
    ),

    // Parcelas do mês visto
    monthData.items.length > 0 && h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, 'Parcelas neste mês'),
      monthData.items.map(item => {
        const p = cardPurchases.find(x => x.id === item.purchaseId);
        return h('div', {
          key: item.purchaseId,
          style: {
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 0', borderBottom: `1px solid ${t.border}`,
          }
        },
          h('div', {
            style: {
              width: 36, height: 36, borderRadius: 12,
              background: t.accentSoft, color: t.accent,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
            }
          }, `${item.installment}/${item.of}`),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', {
              style: {
                fontSize: 14, fontWeight: 500, color: t.text,
                textTransform: 'capitalize', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }
            }, item.description),
            h('div', { style: { fontSize: 11, color: t.textDim, marginTop: 2 } },
              `Total ${fmt(p?.amount || 0)} em ${item.of}x`)
          ),
          h('div', {
            style: { fontSize: 15, fontWeight: 600, color: t.text, fontVariantNumeric: 'tabular-nums' }
          }, fmt(item.amount))
        );
      })
    ),

    // Adicionar
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, 'Lançar compra no cartão'),
      h('input', {
        style: styles.input,
        placeholder: 'Ex: "comprei tênis de 600 no cartão em 3x"',
        value: input, onChange: (e) => setInput(e.target.value),
        onKeyDown: (e) => e.key === 'Enter' && submit(),
      }),
      h('button', {
        style: { ...styles.primaryBtn, marginTop: 10, width: '100%', opacity: input.trim() ? 1 : 0.5 },
        onClick: submit, disabled: !input.trim(),
      }, 'Registrar'),
      h('div', { style: { marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 } },
        [
          'comprei tênis de 600 no cartão em 3x',
          'passei 1200 no cartão em 6x',
          'paguei o cartão',
        ].map(s => h('button', {
          key: s, onClick: () => setInput(s),
          style: {
            fontSize: 11, padding: '6px 10px', borderRadius: 10,
            background: t.surfaceHi, color: t.textDim,
            border: `1px solid ${t.border}`, cursor: 'pointer',
          }
        }, s))
      )
    ),

    // Compras ativas (todas, com indicador de progresso)
    activePurchases.length > 0 && h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, `Compras ativas · ${activePurchases.length}`),
      activePurchases.slice().reverse().map(p => h(CardPurchaseRow, {
        key: p.id, purchase: p, t, currentMonth: summary.currentMonth,
        onToggle: () => toggleActive(p.id),
        onDelete: () => removeCardPurchase(p.id),
      }))
    ),

    // Compras arquivadas
    archivedPurchases.length > 0 && h('div', { style: styles.card },
      h('div', { style: styles.cardTitle }, `Arquivadas · ${archivedPurchases.length}`),
      archivedPurchases.slice().reverse().map(p => h(CardPurchaseRow, {
        key: p.id, purchase: p, t, currentMonth: summary.currentMonth, archived: true,
        onToggle: () => toggleActive(p.id),
        onDelete: () => removeCardPurchase(p.id),
      }))
    )
  );
});

const CardPurchaseRow = memo(function CardPurchaseRow({ purchase, t, currentMonth, archived, onToggle, onDelete }) {
  // Quantas parcelas já passaram em relação ao mês atual
  const installments = cardInstallmentsFor(purchase);
  const idx = installments.findIndex(i => i.month === currentMonth);
  const paidCount = idx >= 0 ? idx : (currentMonth > installments[installments.length - 1].month ? purchase.installments : 0);
  const pct = (paidCount / purchase.installments) * 100;

  return h('div', {
    style: {
      padding: '12px 0', borderBottom: `1px solid ${t.border}`,
      opacity: archived ? 0.5 : 1,
    }
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 } },
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', {
          style: {
            fontSize: 14, fontWeight: 600, color: t.text, textTransform: 'capitalize',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }
        }, purchase.description),
        h('div', { style: { fontSize: 11, color: t.textDim, marginTop: 2 } },
          `${fmt(purchase.amount)} em ${purchase.installments}x de ${fmt(purchase.amount / purchase.installments)}`)
      ),
      h('button', {
        onClick: onToggle,
        style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 14 },
        title: archived ? 'Reativar' : 'Arquivar',
      }, archived ? '↑' : '↓'),
      h('button', {
        onClick: onDelete,
        style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 18 }
      }, '×')
    ),
    h('div', { style: { height: 3, borderRadius: 2, background: t.surfaceHi, overflow: 'hidden' } },
      h('div', {
        style: {
          height: '100%', width: `${pct}%`,
          background: t.accent, borderRadius: 2,
        }
      })
    ),
    h('div', { style: { fontSize: 10, color: t.textDim, marginTop: 4, fontVariantNumeric: 'tabular-nums' } },
      `${paidCount}/${purchase.installments} pagas`)
  );
});

/* ===================== DASHBOARD ===================== */
const DashboardTab = memo(function DashboardTab({ t, theme, styles, transactions, summary }) {
  const [chartType, setChartType] = useState('area');
  const [period, setPeriod] = useState('30');
  const [drillCategory, setDrillCategory] = useState(null); // null ou nome categoria
  const [compareMonths, setCompareMonths] = useState(false);

  const days = parseInt(period);

  // Lista de meses com dados (decrescente)
  const monthsWithData = useMemo(() => {
    const set = new Set();
    for (const tx of transactions) if (tx.month) set.add(tx.month);
    return [...set].sort().reverse();
  }, [transactions]);

  // Dados para o gráfico principal — filtra por categoria se em drill
  const chartData = useMemo(() => {
    const byDate = new Map();
    for (const tx of transactions) {
      if (drillCategory && tx.category !== drillCategory) continue;
      if (!byDate.has(tx.date)) byDate.set(tx.date, { exp: 0, inc: 0 });
      const slot = byDate.get(tx.date);
      if (tx.type === 'expense') slot.exp += tx.amount;
      else if (tx.type === 'income') slot.inc += tx.amount;
    }
    const result = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      const s = byDate.get(key) || { exp: 0, inc: 0 };
      result.push({
        date: d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
        Gastos: s.exp, Receitas: s.inc,
      });
    }
    return result;
  }, [transactions, days, drillCategory]);

  // Categorias do mês atual (para drill-down)
  const categoryData = useMemo(() => {
    const map = new Map();
    const mKey = summary.currentMonth;
    for (const tx of transactions) {
      if (tx.type !== 'expense') continue;
      if (tx.month !== mKey) continue;
      const c = tx.category || 'Outros';
      map.set(c, (map.get(c) || 0) + tx.amount);
    }
    return [...map.entries()].map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [transactions, summary.currentMonth]);

  // Comparação: mês atual vs anterior
  const monthCompare = useMemo(() => {
    const cur = summary.currentMonth;
    const prev = prevMonth(cur);
    const curByCat = new Map();
    const prevByCat = new Map();
    let curTotal = 0, prevTotal = 0;
    for (const tx of transactions) {
      if (tx.type !== 'expense') continue;
      const c = tx.category || 'Outros';
      if (tx.month === cur) { curByCat.set(c, (curByCat.get(c) || 0) + tx.amount); curTotal += tx.amount; }
      else if (tx.month === prev) { prevByCat.set(c, (prevByCat.get(c) || 0) + tx.amount); prevTotal += tx.amount; }
    }
    const cats = new Set([...curByCat.keys(), ...prevByCat.keys()]);
    const rows = [...cats].map(c => ({
      name: c,
      cur: curByCat.get(c) || 0,
      prev: prevByCat.get(c) || 0,
      delta: (curByCat.get(c) || 0) - (prevByCat.get(c) || 0),
    })).sort((a, b) => b.cur - a.cur);
    return { rows, curTotal, prevTotal, prev, cur };
  }, [transactions, summary.currentMonth]);

  // Transações da categoria em drill
  const drillTransactions = useMemo(() => {
    if (!drillCategory) return [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - days);
    return transactions
      .filter(tx => tx.type === 'expense' && tx.category === drillCategory && new Date(tx.date) >= cutoff)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, drillCategory, days]);

  // Gasto por dia da semana
  const byWeekday = useMemo(() => {
    const labels = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    const sums = [0, 0, 0, 0, 0, 0, 0];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - days);
    for (const tx of transactions) {
      if (tx.type !== 'expense') continue;
      if (drillCategory && tx.category !== drillCategory) continue;
      const d = new Date(tx.date + 'T00:00:00');
      if (d < cutoff) continue;
      sums[d.getDay()] += tx.amount;
    }
    return labels.map((l, i) => ({ day: l, value: sums[i] }));
  }, [transactions, days, drillCategory]);

  const COLORS = useMemo(() => [t.accent, t.accentDim, '#ff8a80', '#ffb3a7', '#ffd0c2', '#ffe5dd', '#8e8e93'],
    [t.accent, t.accentDim]);
  const gradId = `g-${theme}`;

  return h('div', { className: 'strix-fade' },
    // KPIs
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 } },
      h(KPI, { t, label: 'Gasto mês', value: fmt(summary.spentMonth), accent: t.accent }),
      h(KPI, { t, label: 'Receita mês', value: fmt(summary.incomeMonth), accent: t.success }),
      h(KPI, { t, label: 'A receber', value: fmt(summary.owedToMe), accent: t.success }),
      h(KPI, { t, label: 'A pagar', value: fmt(summary.iOwe + summary.billsPending), accent: t.danger })
    ),

    // Drill-down indicator
    drillCategory && h('div', {
      style: {
        ...styles.card, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8,
        borderColor: t.accent, background: t.accentSoft,
      }
    },
      h('button', {
        onClick: () => setDrillCategory(null),
        style: { background: 'transparent', border: 'none', color: t.accent, fontSize: 16, cursor: 'pointer' }
      }, '←'),
      h('div', { style: { flex: 1 } },
        h('div', { style: { fontSize: 10, color: t.textDim, textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'Filtrado por categoria'),
        h('div', { style: { fontSize: 16, fontWeight: 600, color: t.accent } }, drillCategory)
      )
    ),

    // Controles
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, 'Período'),
      h('div', { style: { display: 'flex', gap: 6, marginBottom: 14 } },
        ['7', '30', '90'].map(p => h('button', {
          key: p, onClick: () => setPeriod(p),
          style: {
            flex: 1, padding: '8px', borderRadius: 10, fontSize: 12,
            border: `1px solid ${t.border}`, cursor: 'pointer',
            background: period === p ? t.accent : t.surfaceHi,
            color: period === p ? '#fff' : t.textDim, fontWeight: 600,
          }
        }, `${p} dias`))
      ),
      h('div', { style: styles.cardTitle }, 'Visualização'),
      h('div', { style: { display: 'flex', gap: 6 } },
        [['area', 'Linha'], ['bar', 'Barras'], ['pie', 'Pizza']].map(([v, l]) => h('button', {
          key: v, onClick: () => setChartType(v),
          style: {
            flex: 1, padding: '8px', borderRadius: 10, fontSize: 12,
            border: `1px solid ${t.border}`, cursor: 'pointer',
            background: chartType === v ? t.accent : t.surfaceHi,
            color: chartType === v ? '#fff' : t.textDim, fontWeight: 600,
          }
        }, l))
      )
    ),

    // Gráfico principal
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: { ...styles.cardTitle, marginBottom: 4 } },
        chartType === 'pie' ? `Por categoria · ${monthLabel(summary.currentMonth)}` : `Movimento · ${period} dias`),
      h('div', { style: { width: '100%', height: 240, marginTop: 8 } },
        h(ResponsiveContainer, null,
          chartType === 'area'
            ? h(AreaChart, { data: chartData, margin: { top: 5, right: 8, bottom: 0, left: 0 } },
                h('defs', null,
                  h('linearGradient', { id: `${gradId}E`, x1: 0, y1: 0, x2: 0, y2: 1 },
                    h('stop', { offset: '0%', stopColor: t.accent, stopOpacity: 0.6 }),
                    h('stop', { offset: '100%', stopColor: t.accent, stopOpacity: 0 })
                  ),
                  h('linearGradient', { id: `${gradId}I`, x1: 0, y1: 0, x2: 0, y2: 1 },
                    h('stop', { offset: '0%', stopColor: t.success, stopOpacity: 0.5 }),
                    h('stop', { offset: '100%', stopColor: t.success, stopOpacity: 0 })
                  )
                ),
                h(CartesianGrid, { stroke: t.border, vertical: false }),
                h(XAxis, { dataKey: 'date', stroke: t.textFaint, fontSize: 10, tickLine: false, axisLine: false,
                  tick: { fill: t.textDim }, interval: Math.max(0, Math.floor(days / 6)) }),
                h(YAxis, { stroke: t.textFaint, fontSize: 10, tickLine: false, axisLine: false, tick: { fill: t.textDim } }),
                h(Tooltip, { contentStyle: { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, fontSize: 12 },
                  formatter: (v) => fmt(v) }),
                h(Area, { type: 'monotone', dataKey: 'Gastos', stroke: t.accent, strokeWidth: 2, fill: `url(#${gradId}E)` }),
                !drillCategory && h(Area, { type: 'monotone', dataKey: 'Receitas', stroke: t.success, strokeWidth: 2, fill: `url(#${gradId}I)` })
              )
            : chartType === 'bar'
              ? h(BarChart, { data: chartData, margin: { top: 5, right: 8, bottom: 0, left: 0 } },
                  h(CartesianGrid, { stroke: t.border, vertical: false }),
                  h(XAxis, { dataKey: 'date', stroke: t.textFaint, fontSize: 10, tickLine: false, axisLine: false,
                    tick: { fill: t.textDim }, interval: Math.max(0, Math.floor(days / 6)) }),
                  h(YAxis, { stroke: t.textFaint, fontSize: 10, tickLine: false, axisLine: false, tick: { fill: t.textDim } }),
                  h(Tooltip, { contentStyle: { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, fontSize: 12 },
                    formatter: (v) => fmt(v) }),
                  h(Bar, { dataKey: 'Gastos', fill: t.accent, radius: [4, 4, 0, 0] }),
                  !drillCategory && h(Bar, { dataKey: 'Receitas', fill: t.success, radius: [4, 4, 0, 0] })
                )
              : h(PieChart, null,
                  h(Pie, {
                    data: categoryData, dataKey: 'value', nameKey: 'name',
                    cx: '50%', cy: '50%', outerRadius: 80, innerRadius: 45, paddingAngle: 2,
                    onClick: (data) => data?.name && setDrillCategory(data.name),
                    cursor: 'pointer',
                  },
                    categoryData.map((_, i) => h(Cell, { key: i, fill: COLORS[i % COLORS.length], stroke: t.surface, strokeWidth: 2 }))
                  ),
                  h(Tooltip, { contentStyle: { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, fontSize: 12 },
                    formatter: (v) => fmt(v) })
                )
        )
      ),
      chartType === 'pie' && h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } },
        categoryData.map((c, i) => h('button', {
          key: c.name, onClick: () => setDrillCategory(c.name),
          style: {
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, color: t.textDim, padding: '4px 8px',
            background: t.surfaceHi, borderRadius: 8, border: `1px solid ${t.border}`,
            cursor: 'pointer',
          }
        },
          h('div', { style: { width: 8, height: 8, borderRadius: 2, background: COLORS[i % COLORS.length] } }),
          `${c.name} · ${fmt(c.value)}`
        ))
      )
    ),

    // Comparação com mês anterior
    !drillCategory && h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
        h('div', { style: styles.cardTitle }, 'Mês a mês'),
        h('button', {
          onClick: () => setCompareMonths(!compareMonths),
          style: { background: 'transparent', border: 'none', color: t.accent, fontSize: 11, fontWeight: 600, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em' }
        }, compareMonths ? 'ocultar' : 'detalhar')
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: compareMonths ? 16 : 0 } },
        h('div', null,
          h('div', { style: { fontSize: 10, color: t.textDim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 } },
            monthLabel(monthCompare.prev)),
          h('div', { style: { fontSize: 18, fontWeight: 600, color: t.text, fontVariantNumeric: 'tabular-nums' } },
            fmt(monthCompare.prevTotal))
        ),
        h('div', null,
          h('div', { style: { fontSize: 10, color: t.textDim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 } },
            monthLabel(monthCompare.cur)),
          h('div', null,
            h('span', { style: { fontSize: 18, fontWeight: 600, color: t.text, fontVariantNumeric: 'tabular-nums' } },
              fmt(monthCompare.curTotal)),
            monthCompare.prevTotal > 0 && h('div', {
              style: {
                fontSize: 10, fontWeight: 600, marginTop: 2,
                color: monthCompare.curTotal > monthCompare.prevTotal ? t.danger : t.success,
              }
            },
              `${monthCompare.curTotal > monthCompare.prevTotal ? '↑' : '↓'} ${
                Math.abs((monthCompare.curTotal - monthCompare.prevTotal) / monthCompare.prevTotal * 100).toFixed(0)
              }%`
            )
          )
        )
      ),
      compareMonths && monthCompare.rows.length > 0 && h('div', null,
        monthCompare.rows.slice(0, 10).map(r => h('div', {
          key: r.name,
          style: {
            display: 'grid', gridTemplateColumns: '1fr auto auto auto',
            gap: 8, alignItems: 'center', padding: '8px 0',
            borderTop: `1px solid ${t.border}`, fontSize: 13,
          }
        },
          h('span', { style: { color: t.text } }, r.name),
          h('span', { style: { color: t.textDim, fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, fmt(r.prev)),
          h('span', { style: { color: t.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, fmt(r.cur)),
          h('span', {
            style: {
              fontSize: 11, fontWeight: 600,
              color: r.delta > 0 ? t.danger : r.delta < 0 ? t.success : t.textDim,
              minWidth: 50, textAlign: 'right',
            }
          },
            r.delta > 0 ? `+${fmt(r.delta).replace('R$ ', '')}` :
            r.delta < 0 ? `−${fmt(-r.delta).replace('R$ ', '')}` : '0,00'
          )
        ))
      )
    ),

    // Drill-down: lista de transações se houver categoria selecionada
    drillCategory && drillTransactions.length > 0 && h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, `${drillCategory} · ${drillTransactions.length} lançamentos · ${period} dias`),
      drillTransactions.slice(0, 15).map(tx => h(TxRow, { key: tx.id, tx, t, onDelete: () => {}, onEdit: () => {} })),
      drillTransactions.length > 15 && h('div', {
        style: { textAlign: 'center', padding: 8, fontSize: 11, color: t.textDim }
      }, `+ ${drillTransactions.length - 15} mais`)
    ),

    // Gasto por dia da semana
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, `Por dia da semana${drillCategory ? ` · ${drillCategory}` : ''}`),
      h('div', { style: { width: '100%', height: 140, marginTop: 8 } },
        h(ResponsiveContainer, null,
          h(BarChart, { data: byWeekday, margin: { top: 5, right: 8, bottom: 0, left: 0 } },
            h(XAxis, { dataKey: 'day', stroke: t.textFaint, fontSize: 10, tickLine: false, axisLine: false, tick: { fill: t.textDim } }),
            h(YAxis, { hide: true }),
            h(Tooltip, { contentStyle: { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, fontSize: 12 },
              formatter: (v) => fmt(v) }),
            h(Bar, { dataKey: 'value', fill: t.accent, radius: [4, 4, 0, 0] })
          )
        )
      )
    ),

    // Top categorias (com clique para drill-down)
    !drillCategory && h('div', { style: styles.card },
      h('div', { style: styles.cardTitle }, `Top categorias · ${monthLabel(summary.currentMonth)}`),
      categoryData.slice(0, 8).map((c, i) => {
        const pct = (c.value / (categoryData[0]?.value || 1)) * 100;
        return h('button', {
          key: c.name,
          onClick: () => setDrillCategory(c.name),
          style: {
            width: '100%', display: 'block', textAlign: 'left',
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '8px 0', marginBottom: 4,
          }
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 } },
            h('span', { style: { color: t.text } }, c.name),
            h('span', { style: { color: t.textDim, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, fmt(c.value))
          ),
          h('div', { style: { height: 4, borderRadius: 2, background: t.surfaceHi, overflow: 'hidden' } },
            h('div', {
              style: {
                height: '100%', width: `${pct}%`,
                background: COLORS[i % COLORS.length], borderRadius: 2,
                transition: 'width 0.6s ease',
              }
            })
          )
        );
      }),
      categoryData.length === 0 && h('div', {
        style: { padding: 16, textAlign: 'center', color: t.textFaint, fontSize: 13 }
      }, 'Sem gastos neste mês ainda')
    )
  );
});

const KPI = memo(function KPI({ t, label, value, accent }) {
  return h('div', {
    style: {
      background: t.surface, border: `1px solid ${t.border}`,
      borderRadius: 16, padding: 14,
    }
  },
    h('div', { style: { fontSize: 11, color: t.textDim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 } }, label),
    h('div', {
      style: {
        fontSize: 17, fontWeight: 600, color: accent,
        letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums',
      }
    }, value)
  );
});

/* ===================== DETAILS ===================== */
const DetailsTab = memo(function DetailsTab({ t, styles, debts, bills, transactions, accounts, toggleDebt, toggleBill, removeDebt, removeBill, removeTx, onEditTx, onEditDebt, onEditBill }) {
  const [search, setSearch] = useState('');

  const owesMe = debts.filter(d => d.direction === 'owes_me');
  const iOwe = debts.filter(d => d.direction === 'i_owe');
  const pendingBills = bills.filter(b => !b.paid).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const paidBills = bills.filter(b => b.paid);

  const filteredHist = useMemo(() => {
    const q = stripAccents(search.toLowerCase());
    let list = transactions.slice().reverse();
    if (q) {
      list = list.filter(tx =>
        stripAccents((tx.description || '').toLowerCase()).includes(q) ||
        stripAccents((tx.category || '').toLowerCase()).includes(q)
      );
    }
    return list.slice(0, 50);
  }, [transactions, search]);

  return h('div', { className: 'strix-fade' },
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, `Te devem · ${owesMe.filter(d => !d.paid).length} pendentes`),
      owesMe.length === 0
        ? h('div', { style: { padding: '20px 8px', textAlign: 'center', color: t.textFaint, fontSize: 13 } }, 'Ninguém te deve agora.')
        : owesMe.map(d => h(DebtRow, { key: d.id, d, t, onToggle: () => toggleDebt(d.id), onDelete: () => { if (confirm('Remover?')) removeDebt(d.id); }, onEdit: () => onEditDebt && onEditDebt(d) }))
    ),
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, `Você deve · ${iOwe.filter(d => !d.paid).length} pendentes`),
      iOwe.length === 0
        ? h('div', { style: { padding: '20px 8px', textAlign: 'center', color: t.textFaint, fontSize: 13 } }, 'Sem dívidas pessoais.')
        : iOwe.map(d => h(DebtRow, { key: d.id, d, t, onToggle: () => toggleDebt(d.id), onDelete: () => { if (confirm('Remover?')) removeDebt(d.id); }, onEdit: () => onEditDebt && onEditDebt(d) }))
    ),
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, `Contas pendentes · ${pendingBills.length}`),
      pendingBills.length === 0
        ? h('div', { style: { padding: '20px 8px', textAlign: 'center', color: t.textFaint, fontSize: 13 } }, 'Nenhuma conta pendente.')
        : pendingBills.map(b => h(BillRow, { key: b.id, b, t, onToggle: () => toggleBill(b.id), onDelete: () => { if (confirm('Remover?')) removeBill(b.id); }, onEdit: () => onEditBill && onEditBill(b) }))
    ),
    paidBills.length > 0 && h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, 'Contas pagas'),
      paidBills.slice(-8).reverse().map(b =>
        h(BillRow, { key: b.id, b, t, onToggle: () => toggleBill(b.id), onDelete: () => { if (confirm('Remover?')) removeBill(b.id); }, onEdit: () => onEditBill && onEditBill(b) })
      )
    ),
    h('div', { style: styles.card },
      h('div', { style: styles.cardTitle }, `Histórico · ${transactions.length}`),
      h('input', {
        style: { ...styles.input, marginBottom: 8 },
        placeholder: 'Buscar...', value: search,
        onChange: (e) => setSearch(e.target.value),
      }),
      filteredHist.length === 0
        ? h('div', { style: { padding: '20px 8px', textAlign: 'center', color: t.textFaint, fontSize: 13 } },
            search ? 'Nada encontrado.' : 'Nada registrado ainda.')
        : filteredHist.map(tx => h(TxRow, { key: tx.id, tx, t, onDelete: () => removeTx(tx.id), onEdit: () => onEditTx && onEditTx(tx) }))
    )
  );
});

const DebtRow = memo(function DebtRow({ d, t, onToggle, onDelete, onEdit }) {
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 0', borderBottom: `1px solid ${t.border}`,
      opacity: d.paid ? 0.5 : 1,
    }
  },
    h('button', {
      onClick: onToggle,
      style: {
        width: 24, height: 24, borderRadius: 8,
        border: `2px solid ${d.paid ? t.success : t.border}`,
        background: d.paid ? t.success : 'transparent',
        color: '#000', fontSize: 14, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }
    }, d.paid ? '✓' : ''),
    h('div', {
      onClick: onEdit,
      style: { flex: 1, minWidth: 0, cursor: onEdit ? 'pointer' : 'default' }
    },
      h('div', {
        style: {
          fontSize: 14, fontWeight: 600, color: t.text, textTransform: 'capitalize',
          textDecoration: d.paid ? 'line-through' : 'none',
        }
      }, d.person),
      h('div', { style: { fontSize: 11, color: t.textDim } },
        `${d.description} · ${new Date(d.date + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`)
    ),
    h('div', { style: { fontSize: 15, fontWeight: 700, color: d.direction === 'owes_me' ? t.success : t.danger } },
      fmt(d.amount)),
    onEdit && h('button', {
      onClick: onEdit,
      style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 14, padding: 4 },
      title: 'Editar',
    }, '✎'),
    h('button', { onClick: onDelete, style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 18 } }, '×')
  );
});

const BillRow = memo(function BillRow({ b, t, onToggle, onDelete, onEdit }) {
  const isOverdue = !b.paid && b.dueDate && b.dueDate < todayISO();
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 0', borderBottom: `1px solid ${t.border}`,
      opacity: b.paid ? 0.5 : 1,
    }
  },
    h('button', {
      onClick: onToggle,
      style: {
        width: 24, height: 24, borderRadius: 8,
        border: `2px solid ${b.paid ? t.success : isOverdue ? t.danger : t.border}`,
        background: b.paid ? t.success : 'transparent',
        color: '#000', fontSize: 14, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }
    }, b.paid ? '✓' : ''),
    h('div', {
      onClick: onEdit,
      style: { flex: 1, minWidth: 0, cursor: onEdit ? 'pointer' : 'default' }
    },
      h('div', {
        style: {
          fontSize: 14, fontWeight: 600, color: t.text, textTransform: 'capitalize',
          textDecoration: b.paid ? 'line-through' : 'none',
        }
      }, b.name),
      h('div', { style: { fontSize: 11, color: isOverdue ? t.danger : t.textDim } },
        b.dueDate
          ? `Vence ${new Date(b.dueDate + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}${isOverdue ? ' · atrasada' : ''}`
          : 'Sem vencimento')
    ),
    h('div', { style: { fontSize: 15, fontWeight: 700, color: t.text } }, b.amount ? fmt(b.amount) : '—'),
    onEdit && h('button', {
      onClick: onEdit,
      style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 14, padding: 4 },
      title: 'Editar',
    }, '✎'),
    h('button', { onClick: onDelete, style: { background: 'transparent', border: 'none', color: t.textFaint, cursor: 'pointer', fontSize: 18 } }, '×')
  );
});

/* ===================== SETTINGS ===================== */
const SettingsTab = memo(function SettingsTab({ t, styles, theme, setTheme, exportData, importData, askNotifPermission }) {
  const fileRef = useRef();
  const [storageInfo, setStorageInfo] = useState(null);

  useEffect(() => { getStorageEstimate().then(setStorageInfo); }, []);

  const notifStatus = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

  const wipeAll = async () => {
    if (!confirm('Apagar TODOS os dados? Isso não pode ser desfeito.')) return;
    if (!confirm('Tem certeza absoluta?')) return;
    const db = await openDB();
    const tx = db.transaction(['transactions','debts','bills','meta','audit'], 'readwrite');
    tx.objectStore('transactions').clear();
    tx.objectStore('debts').clear();
    tx.objectStore('bills').clear();
    tx.objectStore('meta').clear();
    tx.objectStore('audit').clear();
    tx.oncomplete = () => location.reload();
  };

  return h('div', { className: 'strix-fade' },
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, 'Aparência'),
      h('div', { style: { display: 'flex', gap: 8 } },
        ['dark', 'light'].map(m => h('button', {
          key: m, onClick: () => setTheme(m),
          style: {
            flex: 1, padding: '12px', borderRadius: 12, fontSize: 14,
            border: `1px solid ${t.border}`, cursor: 'pointer',
            background: theme === m ? t.accent : t.surfaceHi,
            color: theme === m ? '#fff' : t.text, fontWeight: 600,
          }
        }, m === 'dark' ? '☾ Escuro' : '☀ Claro'))
      )
    ),
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, 'Notificações'),
      h('div', { style: { fontSize: 13, color: t.textDim, marginBottom: 10 } },
        notifStatus === 'granted' ? '✓ Ativadas' :
        notifStatus === 'denied' ? '✗ Bloqueadas (libere nas configurações do navegador)' :
        notifStatus === 'unsupported' ? 'Não suportado neste dispositivo' :
        'Pendente'),
      notifStatus === 'default' && h('button', {
        onClick: askNotifPermission,
        style: { ...styles.primaryBtn, width: '100%' }
      }, 'Ativar notificações')
    ),
    h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, 'Backup'),
      h('div', { style: { fontSize: 12, color: t.textDim, marginBottom: 10 } },
        'Seus dados ficam só no seu dispositivo. Faça backup periodicamente.'),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('button', { onClick: exportData, style: { ...styles.primaryBtn, flex: 1 } }, 'Exportar'),
        h('button', {
          onClick: () => fileRef.current?.click(),
          style: {
            flex: 1, padding: '12px 20px', borderRadius: 14,
            background: t.surfaceHi, color: t.text, border: `1px solid ${t.border}`,
            fontWeight: 600, fontSize: 15, cursor: 'pointer',
          }
        }, 'Importar')
      ),
      h('input', {
        ref: fileRef, type: 'file', accept: 'application/json',
        style: { display: 'none' },
        onChange: (e) => {
          const f = e.target.files?.[0];
          if (f && confirm('Importar substituirá todos os dados atuais. Continuar?')) importData(f);
          e.target.value = '';
        },
      })
    ),
    storageInfo && h('div', { style: { ...styles.card, marginBottom: 12 } },
      h('div', { style: styles.cardTitle }, 'Armazenamento'),
      h('div', { style: { fontSize: 13, color: t.textDim } },
        `${(storageInfo.used / 1024).toFixed(1)} KB usados de ${(storageInfo.quota / 1024 / 1024).toFixed(0)} MB disponíveis`)
    ),
    h('div', { style: styles.card },
      h('div', { style: styles.cardTitle }, 'Zona de risco'),
      h('button', {
        onClick: wipeAll,
        style: {
          width: '100%', padding: '12px', borderRadius: 14,
          background: 'transparent', color: t.danger,
          border: `1px solid ${t.danger}`, fontWeight: 600, fontSize: 14, cursor: 'pointer',
        }
      }, 'Apagar todos os dados')
    )
  );
});

/* ===================== ASSISTANT ===================== */
const FloatingAssistant = memo(function FloatingAssistant({ t, theme, open, setOpen, onSubmit, startVoice, listening }) {
  const [input, setInput] = useState('');

  const handleVoice = () => {
    startVoice((transcript) => setInput(transcript));
  };

  return h(Fragment, null,
    !open && h('button', {
      onClick: () => { setOpen(true); haptic(); },
      'aria-label': 'Abrir assistente',
      style: {
        position: 'fixed',
        bottom: `calc(env(safe-area-inset-bottom) + 90px)`,
        right: 16, width: 60, height: 60, borderRadius: 30,
        background: t.surface, border: `1px solid ${t.border}`,
        boxShadow: `0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px ${t.accent}33`,
        cursor: 'pointer', zIndex: 49,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }
    }, h(StrixOwl, { size: 44, theme })),
    open && h(Fragment, null,
      h('div', {
        onClick: () => setOpen(false),
        style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', zIndex: 60, animation: 'fadeIn 0.2s ease' }
      }),
      h('div', {
        style: {
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: t.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
          padding: `20px 20px calc(env(safe-area-inset-bottom) + 24px)`,
          zIndex: 70, boxShadow: '0 -8px 40px rgba(0,0,0,0.4)',
          animation: 'slideUp 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
          maxWidth: 480, margin: '0 auto',
          border: `1px solid ${t.border}`, borderBottom: 'none',
        }
      },
        h('div', { style: { width: 36, height: 4, background: t.textFaint, borderRadius: 2, margin: '0 auto 16px', opacity: 0.4 } }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 } },
          h(StrixOwl, { size: 48, theme }),
          h('div', null,
            h('div', { style: { fontSize: 16, fontWeight: 700, color: t.text } }, 'Strix está ouvindo'),
            h('div', { style: { fontSize: 12, color: t.textDim } }, 'Diga ou escreva o que rolou')
          )
        ),
        h('input', {
          autoFocus: true, value: input,
          onChange: (e) => setInput(e.target.value),
          onKeyDown: (e) => e.key === 'Enter' && input.trim() && onSubmit(input),
          placeholder: 'Ex: "vendi 15 reais para joão"',
          style: {
            width: '100%', padding: '14px 16px', borderRadius: 14,
            background: t.surfaceHi, border: `1px solid ${t.border}`,
            color: t.text, fontSize: 15, outline: 'none',
            fontFamily: 'inherit', boxSizing: 'border-box',
          }
        }),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
          h('button', {
            onClick: handleVoice,
            className: listening ? 'strix-listening' : '',
            style: {
              flex: 1, padding: '14px', borderRadius: 14,
              background: listening ? t.accent : t.surfaceHi,
              color: listening ? '#fff' : t.text,
              border: `1px solid ${t.border}`,
              fontSize: 15, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }
          }, '🎙', listening ? 'Ouvindo...' : 'Falar'),
          h('button', {
            onClick: () => input.trim() && (onSubmit(input), setInput('')),
            disabled: !input.trim(),
            style: {
              flex: 1, padding: '14px', borderRadius: 14,
              background: input.trim() ? t.accent : t.surfaceHi,
              color: input.trim() ? '#fff' : t.textFaint,
              border: 'none', fontSize: 15, fontWeight: 600,
              cursor: input.trim() ? 'pointer' : 'not-allowed',
            }
          }, 'Registrar')
        )
      )
    )
  );
});

/* ===================== EDIT MODAL ===================== */
const EditModal = memo(function EditModal({ t, theme, editing, setEditing, accounts, onSave }) {
  const { kind, item } = editing;
  // Form state — inicializa com valores atuais
  const [form, setForm] = useState(() => {
    if (kind === 'tx') return {
      amount: item.amount,
      description: item.description || '',
      category: item.category || '',
      date: item.date || todayISO(),
      accountId: item.accountId || '',
      type: item.type,
    };
    if (kind === 'debt') return {
      amount: item.amount,
      person: item.person || '',
      description: item.description || '',
      date: item.date || todayISO(),
      direction: item.direction,
    };
    if (kind === 'bill') return {
      amount: item.amount || 0,
      name: item.name || '',
      dueDate: item.dueDate || '',
    };
    if (kind === 'account') return {
      name: item.name || '',
      initialBalance: item.initialBalance || 0,
    };
    return {};
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = () => {
    // Sanitiza: amount/initialBalance numbers
    const patch = { ...form };
    if (patch.amount !== undefined) patch.amount = Number(patch.amount) || 0;
    if (patch.initialBalance !== undefined) patch.initialBalance = Number(patch.initialBalance) || 0;
    if (patch.accountId === '') patch.accountId = null;
    onSave(patch);
  };

  const close = () => setEditing(null);

  const inputStyle = {
    width: '100%', padding: '12px 14px', borderRadius: 12,
    background: t.surfaceHi, border: `1px solid ${t.border}`,
    color: t.text, fontSize: 14, outline: 'none',
    fontFamily: 'inherit', boxSizing: 'border-box', marginTop: 4,
  };
  const labelStyle = { fontSize: 11, color: t.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 };

  const title = kind === 'tx' ? 'Editar lançamento'
              : kind === 'debt' ? 'Editar dívida'
              : kind === 'bill' ? 'Editar conta'
              : 'Editar local';

  return h(Fragment, null,
    h('div', {
      onClick: close,
      style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
        zIndex: 80, animation: 'fadeIn 0.2s ease' }
    }),
    h('div', {
      style: {
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: t.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
        padding: `20px 20px calc(env(safe-area-inset-bottom) + 24px)`,
        zIndex: 90, boxShadow: '0 -8px 40px rgba(0,0,0,0.4)',
        animation: 'slideUp 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
        maxWidth: 480, margin: '0 auto',
        border: `1px solid ${t.border}`, borderBottom: 'none',
        maxHeight: '85vh', overflowY: 'auto',
      }
    },
      h('div', { style: { width: 36, height: 4, background: t.textFaint, borderRadius: 2, margin: '0 auto 16px', opacity: 0.4 } }),
      h('div', { style: { fontSize: 18, fontWeight: 700, color: t.text, marginBottom: 16 } }, title),

      // Campos por tipo
      kind === 'tx' && h(Fragment, null,
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Tipo'),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
            ['expense', 'income'].map(tp => h('button', {
              key: tp, onClick: () => set('type', tp),
              style: {
                flex: 1, padding: 10, borderRadius: 10, fontSize: 13,
                border: `1px solid ${t.border}`, cursor: 'pointer',
                background: form.type === tp ? t.accent : t.surfaceHi,
                color: form.type === tp ? '#fff' : t.text, fontWeight: 600,
              }
            }, tp === 'expense' ? 'Gasto' : 'Receita'))
          )
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Valor (R$)'),
          h('input', {
            type: 'number', step: '0.01', style: inputStyle,
            value: form.amount, onChange: (e) => set('amount', e.target.value),
          })
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Descrição'),
          h('input', {
            style: inputStyle, value: form.description,
            onChange: (e) => set('description', e.target.value),
          })
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Categoria'),
          h('input', {
            style: inputStyle, value: form.category,
            onChange: (e) => set('category', e.target.value),
          })
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Data'),
          h('input', {
            type: 'date', style: inputStyle, value: form.date,
            onChange: (e) => set('date', e.target.value),
          })
        ),
        accounts && accounts.length > 0 && h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Local vinculado'),
          h('select', {
            style: inputStyle, value: form.accountId,
            onChange: (e) => set('accountId', e.target.value),
          },
            h('option', { value: '' }, '— Não vinculado —'),
            accounts.filter(a => !a.archived).map(a =>
              h('option', { key: a.id, value: a.id }, a.name)
            )
          )
        )
      ),

      kind === 'debt' && h(Fragment, null,
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Direção'),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
            [['owes_me', 'Me devem'], ['i_owe', 'Eu devo']].map(([v, lbl]) => h('button', {
              key: v, onClick: () => set('direction', v),
              style: {
                flex: 1, padding: 10, borderRadius: 10, fontSize: 13,
                border: `1px solid ${t.border}`, cursor: 'pointer',
                background: form.direction === v ? t.accent : t.surfaceHi,
                color: form.direction === v ? '#fff' : t.text, fontWeight: 600,
              }
            }, lbl))
          )
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Pessoa'),
          h('input', { style: inputStyle, value: form.person, onChange: (e) => set('person', e.target.value) })
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Valor (R$)'),
          h('input', { type: 'number', step: '0.01', style: inputStyle,
            value: form.amount, onChange: (e) => set('amount', e.target.value) })
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Descrição'),
          h('input', { style: inputStyle, value: form.description,
            onChange: (e) => set('description', e.target.value) })
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Data'),
          h('input', { type: 'date', style: inputStyle, value: form.date,
            onChange: (e) => set('date', e.target.value) })
        )
      ),

      kind === 'bill' && h(Fragment, null,
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Nome'),
          h('input', { style: inputStyle, value: form.name,
            onChange: (e) => set('name', e.target.value) })
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Valor (R$)'),
          h('input', { type: 'number', step: '0.01', style: inputStyle,
            value: form.amount, onChange: (e) => set('amount', e.target.value) })
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Vencimento'),
          h('input', { type: 'date', style: inputStyle, value: form.dueDate || '',
            onChange: (e) => set('dueDate', e.target.value) })
        )
      ),

      kind === 'account' && h(Fragment, null,
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Nome do local'),
          h('input', { style: inputStyle, value: form.name,
            onChange: (e) => set('name', e.target.value) })
        ),
        h('div', { style: { marginBottom: 12 } },
          h('label', { style: labelStyle }, 'Saldo inicial (R$)'),
          h('input', { type: 'number', step: '0.01', style: inputStyle,
            value: form.initialBalance, onChange: (e) => set('initialBalance', e.target.value) }),
          h('div', { style: { fontSize: 11, color: t.textDim, marginTop: 4 } },
            'O saldo atual é calculado a partir desse valor + transações vinculadas.')
        )
      ),

      // Botões
      h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
        h('button', {
          onClick: close,
          style: {
            flex: 1, padding: 14, borderRadius: 14,
            background: t.surfaceHi, color: t.text, border: `1px solid ${t.border}`,
            fontSize: 15, fontWeight: 600, cursor: 'pointer',
          }
        }, 'Cancelar'),
        h('button', {
          onClick: handleSubmit,
          style: {
            flex: 1, padding: 14, borderRadius: 14,
            background: t.accent, color: '#fff', border: 'none',
            fontSize: 15, fontWeight: 600, cursor: 'pointer',
          }
        }, 'Salvar')
      )
    )
  );
});


/* ===================== MOUNT ===================== */
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(h(App));

})();
