require('dotenv').config();
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const axios = require('axios');
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { buildPdf, TEMPLATES, money, sumItems } = require('./pdf');

// ───────────────────────── Config ─────────────────────────
const { BOT_TOKEN, DATABASE_URL, PAYSTACK_SECRET, PGSSL } = process.env;
if (!BOT_TOKEN || !DATABASE_URL) {
  console.error('Missing BOT_TOKEN or DATABASE_URL in .env');
  process.exit(1);
}

const FREE_LIMIT = parseInt(process.env.FREE_LIMIT || '5', 10);
const PORT = process.env.PORT || 3000;
const EMAIL_DOMAIN = process.env.PAYSTACK_EMAIL_DOMAIN || 'invoicebot.app';
// Public HTTPS address of this server. Enables the data-entry form (Telegram Mini App).
const WEBAPP_URL = (process.env.WEBAPP_URL || '').replace(/\/$/, '');
// Comma separated Telegram user IDs that get every Pro feature for free
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter(Boolean);
let BOT_NAME = process.env.BOT_NAME || 'InvoiceBot';

const PLANS = {
  monthly: { label: '1 month', days: 30, price: Number(process.env.PRICE_MONTHLY || 2500) },
  quarterly: { label: '3 months', days: 90, price: Number(process.env.PRICE_QUARTERLY || 6500) },
  yearly: { label: '12 months', days: 365, price: Number(process.env.PRICE_YEARLY || 24000) },
};

const COLORS = {
  Navy: '1f3a5f',
  Green: '1b7a4b',
  Red: 'b3261e',
  Purple: '6b3fa0',
  Orange: 'd9730d',
  Black: '222222',
};

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
// FIX for "socket hang up": use a fresh IPv4 connection per request (no stale keep-alive sockets)
const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 120000,
  telegram: { agent: new https.Agent({ keepAlive: false, family: 4 }) },
});

// ───────────────────────── Network helpers (retry on dropped connections) ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = /socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|network|timeout/i;
async function retry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = `${(e && e.message) || ''} ${(e && e.code) || ''}`;
      if (i >= tries || !TRANSIENT.test(msg)) throw e;
      await sleep(700 * i);
    }
  }
}
const sendPdf = (ctx, buf, filename, extra = {}) =>
  retry(() => ctx.replyWithDocument({ source: buf, filename }, extra));
const sendPdfTo = (chatId, buf, filename, extra = {}) =>
  retry(() => bot.telegram.sendDocument(chatId, { source: buf, filename }, extra));
const states = new Map(); // tgId -> { step, mode, draft }

// ───────────────────────── Database ─────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id BIGINT PRIMARY KEY,
      first_name TEXT,
      biz_name TEXT,
      phone TEXT,
      address TEXT,
      bank TEXT,
      accent TEXT DEFAULT '1f3a5f',
      logo BYTEA,
      inv_seq INT DEFAULT 0,
      rec_seq INT DEFAULT 0,
      plan_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      tg_id BIGINT NOT NULL,
      kind TEXT NOT NULL,
      number TEXT NOT NULL,
      data JSONB NOT NULL,
      total NUMERIC NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS documents_user_idx ON documents (tg_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS payments (
      reference TEXT PRIMARY KEY,
      tg_id BIGINT NOT NULL,
      plan TEXT NOT NULL,
      amount INT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      tg_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      phone TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      last_used TIMESTAMPTZ DEFAULT now(),
      UNIQUE (tg_id, name_key)
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS template TEXT DEFAULT 'classic';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS cust_synced BOOLEAN DEFAULT false;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS customer_id INT;
    CREATE INDEX IF NOT EXISTS documents_cust_idx ON documents (tg_id, customer_id);
  `);
}

async function upsertUser(from) {
  await pool.query(
    `INSERT INTO users (tg_id, first_name) VALUES ($1, $2) ON CONFLICT (tg_id) DO NOTHING`,
    [from.id, from.first_name || null]
  );
}

async function getUser(id) {
  const r = await pool.query(
    `SELECT tg_id, first_name, biz_name, phone, address, bank, accent, template,
            (logo IS NOT NULL) AS has_logo, inv_seq, rec_seq, plan_expires
     FROM users WHERE tg_id = $1`,
    [id]
  );
  return r.rows[0];
}

async function getLogo(id) {
  const r = await pool.query('SELECT logo FROM users WHERE tg_id = $1', [id]);
  return r.rows[0] ? r.rows[0].logo : null;
}

async function monthCount(id) {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM documents
     WHERE tg_id = $1
       AND created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'`,
    [id]
  );
  return r.rows[0].n;
}

const historyLimit = (pro) => (pro ? 10 : 3);
const isAdmin = (id) => ADMIN_IDS.includes(Number(id));
const isPro = (u) =>
  !!u && (isAdmin(u.tg_id) || !!(u.plan_expires && new Date(u.plan_expires) > new Date()));

// Builds the customer list from past documents the first time a Pro user opens Customers
async function syncCustomers(id) {
  const flag = await pool.query(
    'UPDATE users SET cust_synced = true WHERE tg_id = $1 AND cust_synced = false RETURNING 1',
    [id]
  );
  if (!flag.rowCount) return;
  await pool.query(
    `INSERT INTO customers (tg_id, name, name_key, phone, last_used)
     SELECT $1,
            (array_agg(data->>'customer' ORDER BY created_at DESC))[1],
            lower(data->>'customer'),
            (array_agg(data->>'customerPhone' ORDER BY created_at DESC))[1],
            max(created_at)
     FROM documents
     WHERE tg_id = $1 AND data->>'customer' IS NOT NULL
     GROUP BY lower(data->>'customer')
     ON CONFLICT (tg_id, name_key) DO NOTHING`,
    [id]
  );
  await pool.query(
    `UPDATE documents d SET customer_id = c.id
     FROM customers c
     WHERE d.tg_id = $1 AND c.tg_id = d.tg_id
       AND c.name_key = lower(d.data->>'customer') AND d.customer_id IS NULL`,
    [id]
  );
}

// ───────────────────────── Helpers ─────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDate = (d) =>
  new Date(d).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
const btn = Markup.button.callback;
const opts = (kb) => ({ parse_mode: 'HTML', reply_markup: kb.reply_markup });
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Edit the current message when a button was pressed, otherwise send a new one
async function show(ctx, text, kb) {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, opts(kb));
      return;
    } catch (e) {
      // not editable (e.g. a document message) - send a new message instead
    }
  }
  await ctx.reply(text, opts(kb));
}

// "2 bags rice 45000" -> { name: 'Bags rice', qty: 2, price: 45000 }  (price is per unit)
function parseLine(line) {
  const tokens = line.replace(/,/g, '').trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const pm = tokens[tokens.length - 1].match(/^[₦N]?(\d+(?:\.\d+)?)(k)?$/i);
  if (!pm) return null;
  const price = parseFloat(pm[1]) * (pm[2] ? 1000 : 1);
  if (!(price > 0)) return null;
  const rest = tokens.slice(0, -1);
  let qty = 1;
  const qm = rest[0].match(/^(\d+(?:\.\d+)?)x?$/i);
  if (rest.length > 1 && qm && parseFloat(qm[1]) > 0) {
    qty = parseFloat(qm[1]);
    rest.shift();
  }
  const name = rest.join(' ').slice(0, 80);
  if (!name) return null;
  return { name: cap(name), qty, price };
}

function parseItems(text) {
  const items = [];
  const bad = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const it = parseLine(line);
    if (it) items.push(it);
    else bad.push(line);
  }
  return { items: items.slice(0, 30), bad };
}

function formatDue(v) {
  const s = String(v || '').trim().slice(0, 40);
  if (!s) return { due: null, raw: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { due: fmtDate(new Date(`${s}T12:00:00Z`)), raw: s };
  return { due: s, raw: s };
}

const SAMPLE_USER = {
  first_name: 'Your Business',
  biz_name: 'Your Business',
  phone: '0800 000 0000',
  address: 'Lagos, Nigeria',
  accent: '1f3a5f',
  bank: 'Your Bank · 0123456789 · Your Business',
};
const sampleDoc = (template) => ({
  kind: 'invoice',
  number: 'INV-0001',
  date: fmtDate(new Date()),
  customer: 'Sample Customer',
  customerPhone: '0801 234 5678',
  items: [
    { name: 'Product one', qty: 2, price: 15000 },
    { name: 'Product two', qty: 1, price: 8500 },
    { name: 'Delivery', qty: 1, price: 2000 },
  ],
  due: '14 days',
  note: 'Thank you for your business.',
  template,
});

// ───────────────────────── Keyboards & screens ─────────────────────────
const menuKeyboard = (uid) => {
  const rows = [
    [btn('🧾 New Invoice', 'new:invoice'), btn('💵 New Receipt', 'new:receipt')],
    [btn('👥 Customers', 'custs:0'), btn('📂 My Documents', 'hist')],
    [btn('🏢 Business Profile', 'prof'), btn('🎨 Templates', 'tpls')],
  ];
  if (WEBAPP_URL) rows.push([Markup.button.webApp('🗂 Open Manager (forms)', `${WEBAPP_URL}/manage`)]);
  rows.push(isAdmin(uid) ? [btn('ℹ️ Help', 'help')] : [btn('⭐ Upgrade', 'up'), btn('ℹ️ Help', 'help')]);
  return Markup.inlineKeyboard(rows);
};

const cancelKeyboard = (to = 'menu') => Markup.inlineKeyboard([[btn('❌ Cancel', to)]]);
const backToMenu = () => Markup.inlineKeyboard([[btn('⬅️ Menu', 'menu')]]);

async function statusLine(u) {
  if (isAdmin(u.tg_id)) return '👑 Admin · all features unlocked';
  if (isPro(u)) return `⭐ Pro active until ${fmtDate(u.plan_expires)}`;
  const n = await monthCount(u.tg_id);
  return `Free plan · ${n}/${FREE_LIMIT} documents used this month`;
}

async function showMenu(ctx, fresh = false) {
  states.delete(ctx.from.id);
  const u = await getUser(ctx.from.id);
  const text = `<b>🧾 Invoice &amp; Receipt Bot</b>\nCreate professional PDF invoices and receipts in seconds.\n\n${await statusLine(u)}\n\nWhat would you like to do?`;
  if (fresh) await ctx.reply(text, opts(menuKeyboard(ctx.from.id)));
  else await show(ctx, text, menuKeyboard(ctx.from.id));
}

async function showUpgrade(ctx, intro) {
  const rows = Object.entries(PLANS).map(([key, p]) => [
    btn(`${p.label} · ₦${money(p.price)}`, `buy:${key}`),
  ]);
  rows.push([btn('⬅️ Back', 'menu')]);
  const text =
    `${intro ? intro + '\n\n' : ''}<b>⭐ Pro plan</b>\n` +
    `• Unlimited invoices &amp; receipts\n` +
    `• Saved customers and one-tap repeat invoices\n` +
    `• 5 document templates\n` +
    `• Your logo, brand colour and bank details\n` +
    `• No "Created with" footer\n` +
    `• Longer document history\n\n` +
    `Choose a plan:`;
  await show(ctx, text, Markup.inlineKeyboard(rows));
}

function previewText(st) {
  const d = st.draft;
  const lines = d.items.map(
    (i) => `• ${esc(i.name)}: ${i.qty} × ${money(i.price)} = ${money(i.qty * i.price)}`
  );
  let t =
    `<b>${st.mode === 'invoice' ? 'Invoice' : 'Receipt'} preview</b>\n` +
    `Customer: <b>${esc(d.customer)}</b>${d.phone ? ` · ${esc(d.phone)}` : ''}\n\n${lines.join('\n')}\n\n` +
    `Total: <b>₦${money(sumItems(d.items))}</b>`;
  if (d.due) t += `\nDue: ${esc(d.due)}`;
  if (d.note) t += `\nNote: ${esc(d.note)}`;
  t += `\nTemplate: ${TEMPLATES[d.template] ? TEMPLATES[d.template].name : 'Classic'}`;
  return t;
}

function previewKeyboard(st) {
  const rows = [[btn('✅ Generate PDF', 'doc:gen')]];
  if (WEBAPP_URL) {
    rows.push([Markup.button.webApp('✏️ Edit in form', `${WEBAPP_URL}/form?mode=${st.mode}&edit=1`)]);
  } else {
    rows.push([btn('✏️ Edit items', 'doc:items'), btn('📝 Note', 'doc:note')]);
    if (st.mode === 'invoice') rows.push([btn('📅 Due date', 'doc:due')]);
  }
  rows.push([btn('🎨 Template', 'doc:tpl')]);
  rows.push([btn('❌ Cancel', 'menu')]);
  return Markup.inlineKeyboard(rows);
}

async function showPreview(ctx, st) {
  st.step = 'preview';
  await show(ctx, previewText(st), previewKeyboard(st));
}

const ITEMS_HELP =
  `Send the items, one per line. Format: <code>[qty] item price</code>\n` +
  `Price is <b>per unit</b>. Examples:\n` +
  `<code>2 bags rice 45000\n1 carton oil 38k\ndelivery 5000</code>`;

// ───────────────────────── Middleware & basics ─────────────────────────
bot.use(async (ctx, next) => {
  if (ctx.from) await upsertUser(ctx.from);
  return next();
});

bot.start((ctx) => showMenu(ctx, true));
bot.command('menu', (ctx) => showMenu(ctx, true));

bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showMenu(ctx);
});

// ───────────────────────── New document ─────────────────────────
async function startNew(ctx, mode, cust) {
  const id = ctx.from.id;
  const u = await getUser(id);
  const pro = isPro(u);
  if (!pro && (await monthCount(id)) >= FREE_LIMIT) {
    return showUpgrade(ctx, `You've used all ${FREE_LIMIT} free documents this month.`);
  }
  const draft = { items: [], template: pro ? u.template || 'classic' : 'classic' };
  if (cust) {
    draft.customer = cust.name;
    draft.phone = cust.phone || null;
    draft.customerId = cust.id;
  }
  states.set(id, { step: WEBAPP_URL ? 'form' : cust ? 'items' : 'customer', mode, draft });

  if (WEBAPP_URL) {
    const url = `${WEBAPP_URL}/form?mode=${mode}${cust ? `&c=${cust.id}` : ''}`;
    const rows = [[Markup.button.webApp('📝 Open form', url)]];
    if (pro && !cust) rows.push([btn('👥 Pick saved customer', `pick:${mode}:0`)]);
    rows.push([btn('⌨️ Type instead', 'typed')], [btn('❌ Cancel', 'menu')]);
    return show(
      ctx,
      `<b>New ${mode}</b>${cust ? `\nCustomer: <b>${esc(cust.name)}</b>` : ''}\nTap <b>Open form</b> to fill in the details.`,
      Markup.inlineKeyboard(rows)
    );
  }
  if (cust) {
    return show(ctx, `<b>New ${mode}</b> for <b>${esc(cust.name)}</b>\n\n${ITEMS_HELP}`, cancelKeyboard());
  }
  return show(ctx, `<b>New ${mode}</b>\nWho is it for? Send the customer's name.`, cancelKeyboard());
}

bot.action(/^new:(invoice|receipt)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await startNew(ctx, ctx.match[1], null);
});

bot.action('typed', async (ctx) => {
  await ctx.answerCbQuery();
  const st = states.get(ctx.from.id);
  if (!st) return showMenu(ctx);
  if (st.draft.customer) {
    st.step = 'items';
    return show(ctx, ITEMS_HELP, cancelKeyboard());
  }
  st.step = 'customer';
  return show(ctx, `<b>New ${st.mode}</b>\nWho is it for? Send the customer's name.`, cancelKeyboard());
});

bot.action('doc:items', async (ctx) => {
  await ctx.answerCbQuery();
  const st = states.get(ctx.from.id);
  if (!st) return showMenu(ctx);
  st.step = 'items';
  await show(ctx, ITEMS_HELP, cancelKeyboard());
});

bot.action('doc:due', async (ctx) => {
  await ctx.answerCbQuery();
  const st = states.get(ctx.from.id);
  if (!st) return showMenu(ctx);
  st.step = 'due';
  await show(ctx, 'When is it due? Type a date or text, e.g. <code>30 Nov 2026</code> or <code>on delivery</code>.', cancelKeyboard());
});

bot.action('doc:note', async (ctx) => {
  await ctx.answerCbQuery();
  const st = states.get(ctx.from.id);
  if (!st) return showMenu(ctx);
  st.step = 'note';
  await show(ctx, 'Type the note to show on the document (max 200 characters).', cancelKeyboard());
});

// Template choice for the document being created
bot.action('doc:tpl', async (ctx) => {
  await ctx.answerCbQuery();
  const st = states.get(ctx.from.id);
  if (!st) return showMenu(ctx);
  const pro = isPro(await getUser(ctx.from.id));
  const rows = Object.entries(TEMPLATES).map(([k, t]) => [
    btn(`${st.draft.template === k ? '✅ ' : ''}${!pro && !t.free ? '🔒 ' : ''}${t.name}`, `doc:tpl:${k}`),
  ]);
  rows.push([btn('⬅️ Back', 'doc:back')]);
  await show(ctx, 'Choose a template for this document:', Markup.inlineKeyboard(rows));
});

bot.action(/^doc:tpl:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const st = states.get(ctx.from.id);
  if (!st) return showMenu(ctx);
  const key = ctx.match[1];
  const t = TEMPLATES[key];
  if (!t) return showPreview(ctx, st);
  if (!t.free && !isPro(await getUser(ctx.from.id))) {
    return showUpgrade(ctx, 'This template is a Pro feature.');
  }
  st.draft.template = key;
  await showPreview(ctx, st);
});

bot.action('doc:back', async (ctx) => {
  await ctx.answerCbQuery();
  const st = states.get(ctx.from.id);
  if (!st) return showMenu(ctx);
  await showPreview(ctx, st);
});

bot.action('doc:gen', async (ctx) => {
  await ctx.answerCbQuery('Generating…');
  const id = ctx.from.id;
  const st = states.get(id);
  if (!st || !st.draft.items.length || !st.draft.customer) return showMenu(ctx);

  const user = await getUser(id);
  const pro = isPro(user);
  if (!pro && (await monthCount(id)) >= FREE_LIMIT) {
    return showUpgrade(ctx, `You've used all ${FREE_LIMIT} free documents this month.`);
  }

  const d = st.draft;
  const template = pro && TEMPLATES[d.template] ? d.template : 'classic';

  // Pro: remember the customer
  let customerId = null;
  if (pro) {
    const cr = await pool.query(
      `INSERT INTO customers (tg_id, name, name_key, phone) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tg_id, name_key)
       DO UPDATE SET last_used = now(), phone = COALESCE(EXCLUDED.phone, customers.phone)
       RETURNING id`,
      [id, d.customer, d.customer.toLowerCase(), d.phone || null]
    );
    customerId = cr.rows[0].id;
  }

  const col = st.mode === 'invoice' ? 'inv_seq' : 'rec_seq';
  const prefix = st.mode === 'invoice' ? 'INV' : 'REC';
  const r = await pool.query(
    `UPDATE users SET ${col} = ${col} + 1 WHERE tg_id = $1 RETURNING ${col} AS n`,
    [id]
  );
  const number = `${prefix}-${String(r.rows[0].n).padStart(4, '0')}`;
  const docData = {
    kind: st.mode,
    number,
    date: fmtDate(new Date()),
    customer: d.customer,
    customerPhone: d.phone || null,
    items: d.items,
    due: d.due || null,
    note: d.note || null,
    template,
  };
  const total = sumItems(d.items);
  await pool.query(
    'INSERT INTO documents (tg_id, kind, number, data, total, customer_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, st.mode, number, JSON.stringify(docData), total, customerId]
  );

  const logo = pro && user.has_logo ? await getLogo(id) : null;
  const buf = await buildPdf({ user, logo, pro, doc: docData, botName: BOT_NAME });
  states.delete(id);
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch (e) {
    /* ignore */
  }
  await sendPdf(ctx, buf, `${number}.pdf`, { caption: `${number} · ₦${money(total)}` });
  await showMenu(ctx, true);
});

// ───────────────────────── History ─────────────────────────
bot.action('hist', async (ctx) => {
  await ctx.answerCbQuery();
  states.delete(ctx.from.id);
  const u = await getUser(ctx.from.id);
  const pro = isPro(u);
  const r = await pool.query(
    'SELECT id, number, total, created_at FROM documents WHERE tg_id = $1 ORDER BY created_at DESC LIMIT $2',
    [ctx.from.id, historyLimit(pro)]
  );
  if (!r.rowCount) {
    return show(ctx, 'No documents yet. Create your first one!', backToMenu());
  }
  const rows = r.rows.map((d) => [
    btn(`${d.number} · ₦${money(d.total)} · ${fmtDate(d.created_at)}`, `doc:view:${d.id}`),
  ]);
  if (WEBAPP_URL) rows.push([Markup.button.webApp('📥 Open downloads page', `${WEBAPP_URL}/manage?tab=docs`)]);
  rows.push([btn('⬅️ Back', 'menu')]);
  const note = pro
    ? 'Your last 10 documents. Tap one to get the PDF again.'
    : 'Your last 3 documents (Pro keeps 10). Tap one to get the PDF again.';
  await show(ctx, `<b>📂 My Documents</b>\n${note}`, Markup.inlineKeyboard(rows));
});

bot.action(/^doc:view:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Preparing PDF…');
  const id = ctx.from.id;
  const r = await pool.query('SELECT data FROM documents WHERE id = $1 AND tg_id = $2', [ctx.match[1], id]);
  if (!r.rowCount) return showMenu(ctx);
  const user = await getUser(id);
  const pro = isPro(user);
  const logo = pro && user.has_logo ? await getLogo(id) : null;
  const doc = r.rows[0].data;
  const buf = await buildPdf({ user, logo, pro, doc, botName: BOT_NAME });
  await sendPdf(ctx, buf, `${doc.number}.pdf`);
});

// ───────────────────────── Customers (Pro) ─────────────────────────
async function showCustomerList(ctx, page, mode) {
  const id = ctx.from.id;
  if (!isPro(await getUser(id))) return showUpgrade(ctx, 'Saved customers are a Pro feature.');
  states.delete(id);
  await syncCustomers(id);
  const PAGE = 8;
  const cnt = (await pool.query('SELECT count(*)::int AS n FROM customers WHERE tg_id = $1', [id])).rows[0].n;
  const r = await pool.query(
    'SELECT id, name FROM customers WHERE tg_id = $1 ORDER BY last_used DESC LIMIT $2 OFFSET $3',
    [id, PAGE, page * PAGE]
  );
  const prefix = mode ? `pick:${mode}` : 'custs';
  const rows = r.rows.map((c) => [btn(c.name.slice(0, 40), mode ? `cnew:${mode}:${c.id}` : `cust:${c.id}`)]);
  const nav = [];
  if (page > 0) nav.push(btn('◀️ Prev', `${prefix}:${page - 1}`));
  if ((page + 1) * PAGE < cnt) nav.push(btn('Next ▶️', `${prefix}:${page + 1}`));
  if (nav.length) rows.push(nav);
  if (WEBAPP_URL && !mode) rows.push([Markup.button.webApp('➕ Add / edit in form', `${WEBAPP_URL}/manage?tab=customers`)]);
  rows.push([btn('⬅️ Back', mode ? `new:${mode}` : 'menu')]);
  let text;
  if (!cnt) {
    text = `<b>👥 Customers</b>\nNo customers yet. They are saved automatically each time you create a document${WEBAPP_URL ? ', or add one with the form below' : ''}.`;
  } else if (mode) {
    text = `<b>Choose a customer</b> (${cnt})`;
  } else {
    text = `<b>👥 Customers</b> (${cnt})\nTap a customer to create a new document, repeat their last one, or see their history.`;
  }
  await show(ctx, text, Markup.inlineKeyboard(rows));
}

bot.action(/^custs:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showCustomerList(ctx, Number(ctx.match[1]), null);
});

bot.action(/^pick:(invoice|receipt):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showCustomerList(ctx, Number(ctx.match[2]), ctx.match[1]);
});

async function getCustomer(id, cid) {
  const r = await pool.query('SELECT id, name, phone FROM customers WHERE id = $1 AND tg_id = $2', [cid, id]);
  return r.rows[0];
}

bot.action(/^cust:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.from.id;
  if (!isPro(await getUser(id))) return showUpgrade(ctx, 'Saved customers are a Pro feature.');
  const c = await getCustomer(id, ctx.match[1]);
  if (!c) return showCustomerList(ctx, 0, null);
  const s = (
    await pool.query(
      'SELECT count(*)::int AS n, max(created_at) AS last FROM documents WHERE tg_id = $1 AND customer_id = $2',
      [id, c.id]
    )
  ).rows[0];
  const text =
    `<b>${esc(c.name)}</b>\n` +
    (c.phone ? `Phone: ${esc(c.phone)}\n` : '') +
    `Documents: ${s.n}` +
    (s.last ? `\nLast document: ${fmtDate(s.last)}` : '');
  const kb = Markup.inlineKeyboard([
    [btn('🧾 New invoice', `cnew:invoice:${c.id}`), btn('💵 New receipt', `cnew:receipt:${c.id}`)],
    [btn('🔁 Repeat last document', `crepeat:${c.id}`)],
    [btn('📄 Their documents', `cdocs:${c.id}`)],
    [btn('🗑 Remove customer', `cdel:${c.id}`)],
    [btn('⬅️ Back', 'custs:0')],
  ]);
  await show(ctx, text, kb);
});

bot.action(/^cnew:(invoice|receipt):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const c = await getCustomer(ctx.from.id, ctx.match[2]);
  if (!c) return showCustomerList(ctx, 0, null);
  await startNew(ctx, ctx.match[1], c);
});

bot.action(/^crepeat:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.from.id;
  const u = await getUser(id);
  if (!isPro(u)) return showUpgrade(ctx, 'Saved customers are a Pro feature.');
  const c = await getCustomer(id, ctx.match[1]);
  if (!c) return showCustomerList(ctx, 0, null);
  const r = await pool.query(
    'SELECT data FROM documents WHERE tg_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 1',
    [id, c.id]
  );
  if (!r.rowCount) {
    return show(ctx, 'No documents for this customer yet.', Markup.inlineKeyboard([[btn('⬅️ Back', `cust:${c.id}`)]]));
  }
  const last = r.rows[0].data;
  const st = {
    step: 'preview',
    mode: last.kind,
    draft: {
      customer: c.name,
      phone: c.phone || last.customerPhone || null,
      customerId: c.id,
      items: last.items,
      due: null,
      note: last.note || null,
      template: u.template || last.template || 'classic',
    },
  };
  states.set(id, st);
  await showPreview(ctx, st);
});

bot.action(/^cdocs:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.from.id;
  const c = await getCustomer(id, ctx.match[1]);
  if (!c) return showCustomerList(ctx, 0, null);
  const r = await pool.query(
    'SELECT id, number, total, created_at FROM documents WHERE tg_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 8',
    [id, c.id]
  );
  const rows = r.rows.map((d) => [
    btn(`${d.number} · ₦${money(d.total)} · ${fmtDate(d.created_at)}`, `doc:view:${d.id}`),
  ]);
  rows.push([btn('⬅️ Back', `cust:${c.id}`)]);
  await show(
    ctx,
    r.rowCount ? `<b>${esc(c.name)}</b>: tap a document to get the PDF again.` : 'No documents for this customer yet.',
    Markup.inlineKeyboard(rows)
  );
});

bot.action(/^cdel:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const c = await getCustomer(ctx.from.id, ctx.match[1]);
  if (!c) return showCustomerList(ctx, 0, null);
  await show(
    ctx,
    `Remove <b>${esc(c.name)}</b> from your customers? Their documents stay in your history.`,
    Markup.inlineKeyboard([[btn('Yes, remove', `cdel:yes:${c.id}`)], [btn('Cancel', `cust:${c.id}`)]])
  );
});

bot.action(/^cdel:yes:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Removed');
  const id = ctx.from.id;
  await pool.query('UPDATE documents SET customer_id = NULL WHERE tg_id = $1 AND customer_id = $2', [id, ctx.match[1]]);
  await pool.query('DELETE FROM customers WHERE tg_id = $1 AND id = $2', [id, ctx.match[1]]);
  await showCustomerList(ctx, 0, null);
});

// ───────────────────────── Templates ─────────────────────────
async function showTemplates(ctx) {
  const u = await getUser(ctx.from.id);
  const pro = isPro(u);
  const current = pro ? u.template || 'classic' : 'classic';
  const keys = Object.keys(TEMPLATES);
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(
      keys.slice(i, i + 2).map((k) => {
        const t = TEMPLATES[k];
        return btn(`${current === k ? '✅ ' : ''}${!pro && !t.free ? '🔒 ' : ''}${t.name}`, `tpl:view:${k}`);
      })
    );
  }
  rows.push([btn('⬅️ Back', 'menu')]);
  await show(
    ctx,
    `<b>🎨 Templates</b>\nYour default: <b>${TEMPLATES[current].name}</b>\nTap a template to see a sample PDF.` +
      (pro ? '' : '\n🔒 = Pro'),
    Markup.inlineKeyboard(rows)
  );
}

bot.action('tpls', async (ctx) => {
  await ctx.answerCbQuery();
  states.delete(ctx.from.id);
  await showTemplates(ctx);
});

bot.action(/^tpl:view:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery('Preparing sample…');
  const key = ctx.match[1];
  const t = TEMPLATES[key];
  if (!t) return showTemplates(ctx);
  const id = ctx.from.id;
  const u = await getUser(id);
  const pro = isPro(u);
  const user = pro ? u : SAMPLE_USER;
  const logo = pro && u.has_logo ? await getLogo(id) : null;
  const buf = await buildPdf({ user, logo, pro: true, sample: true, doc: sampleDoc(key), botName: BOT_NAME });
  const allowed = pro || t.free;
  const kb = Markup.inlineKeyboard([
    [allowed ? btn(`✅ Use ${t.name} as default`, `tpl:set:${key}`) : btn('⭐ Upgrade to unlock', 'up')],
    [btn('⬅️ All templates', 'tpls')],
  ]);
  await sendPdf(ctx, buf, `sample-${key}.pdf`, {
    caption: `${t.name} template (sample)`,
    reply_markup: kb.reply_markup,
  });
});

bot.action(/^tpl:set:(\w+)$/, async (ctx) => {
  const key = ctx.match[1];
  const t = TEMPLATES[key];
  const u = await getUser(ctx.from.id);
  if (!t || (!t.free && !isPro(u))) {
    await ctx.answerCbQuery();
    return showUpgrade(ctx, 'This template is a Pro feature.');
  }
  await ctx.answerCbQuery('Saved');
  await pool.query('UPDATE users SET template = $2 WHERE tg_id = $1', [ctx.from.id, key]);
  await ctx.reply(`✅ ${t.name} is now your default template.`, opts(Markup.inlineKeyboard([[btn('🎨 Templates', 'tpls'), btn('⬅️ Menu', 'menu')]])));
});

// ───────────────────────── Business profile ─────────────────────────
async function showProfile(ctx) {
  states.delete(ctx.from.id);
  const u = await getUser(ctx.from.id);
  const pro = isPro(u);
  const lock = pro ? '' : '🔒 ';
  const text =
    `<b>🏢 Business Profile</b>\n` +
    `Name: ${u.biz_name ? esc(u.biz_name) : '<i>not set</i>'}\n` +
    `Phone: ${u.phone ? esc(u.phone) : '<i>not set</i>'}\n` +
    `Address: ${u.address ? esc(u.address) : '<i>not set</i>'}\n` +
    `Bank details: ${u.bank ? esc(u.bank) : '<i>not set</i>'}${pro ? '' : ' 🔒'}\n` +
    `Logo: ${u.has_logo ? 'uploaded' : 'none'}${pro ? '' : ' 🔒'}\n` +
    `Brand colour: #${u.accent}${pro ? '' : ' 🔒'}`;
  const rows = [];
  if (WEBAPP_URL) rows.push([Markup.button.webApp('📝 Edit in form', `${WEBAPP_URL}/manage?tab=profile`)]);
  rows.push(
    [btn('Name', 'prof:name'), btn('Phone', 'prof:phone'), btn('Address', 'prof:addr')],
    [btn(`${lock}Bank details`, 'prof:bank'), btn(`${lock}Logo`, 'prof:logo')],
    [btn(`${lock}Brand colour`, 'prof:color')],
    [btn('🗑 Delete my data', 'del')],
    [btn('⬅️ Back', 'menu')]
  );
  const kb = Markup.inlineKeyboard(rows);
  await show(ctx, text, kb);
}

bot.action('prof', async (ctx) => {
  await ctx.answerCbQuery();
  await showProfile(ctx);
});

const PROFILE_PROMPTS = {
  name: ['prof_name', 'Send your business name.'],
  phone: ['prof_phone', 'Send the phone number to show on documents.'],
  addr: ['prof_addr', 'Send your business address.'],
  bank: ['prof_bank', 'Send your bank details, e.g. <code>GTBank · 0123456789 · Ada Stores</code>'],
};

bot.action(/^prof:(name|phone|addr|bank)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const field = ctx.match[1];
  if (field === 'bank' && !isPro(await getUser(ctx.from.id))) {
    return showUpgrade(ctx, 'Bank details on invoices are a Pro feature.');
  }
  const [step, prompt] = PROFILE_PROMPTS[field];
  states.set(ctx.from.id, { step });
  await show(ctx, prompt, cancelKeyboard('prof'));
});

bot.action('prof:logo', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPro(await getUser(ctx.from.id))) return showUpgrade(ctx, 'Your logo on documents is a Pro feature.');
  states.set(ctx.from.id, { step: 'prof_logo' });
  await show(ctx, 'Send your logo as a <b>photo</b> (not as a file).', cancelKeyboard('prof'));
});

bot.action('prof:color', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isPro(await getUser(ctx.from.id))) return showUpgrade(ctx, 'Brand colours are a Pro feature.');
  const names = Object.keys(COLORS);
  const rows = [];
  for (let i = 0; i < names.length; i += 3) {
    rows.push(names.slice(i, i + 3).map((n) => btn(n, `color:${COLORS[n]}`)));
  }
  rows.push([btn('⬅️ Back', 'prof')]);
  await show(ctx, 'Pick a brand colour for your documents:', Markup.inlineKeyboard(rows));
});

bot.action(/^color:([0-9a-f]{6})$/i, async (ctx) => {
  await ctx.answerCbQuery('Saved');
  if (!isPro(await getUser(ctx.from.id))) return showUpgrade(ctx);
  await pool.query('UPDATE users SET accent = $2 WHERE tg_id = $1', [ctx.from.id, ctx.match[1].toLowerCase()]);
  await showProfile(ctx);
});

bot.on('photo', async (ctx) => {
  const id = ctx.from.id;
  const st = states.get(id);
  if (!st || st.step !== 'prof_logo') {
    return ctx.reply('To set a logo, open Business Profile → Logo first.', opts(menuKeyboard(id)));
  }
  const photos = ctx.message.photo;
  const link = await ctx.telegram.getFileLink(photos[photos.length - 1].file_id);
  const resp = await axios.get(link.href, { responseType: 'arraybuffer' });
  await pool.query('UPDATE users SET logo = $2 WHERE tg_id = $1', [id, Buffer.from(resp.data)]);
  states.delete(id);
  await ctx.reply('✅ Logo saved.', opts(Markup.inlineKeyboard([[btn('🏢 Business Profile', 'prof')]])));
});

// ───────────────────────── Delete data ─────────────────────────
bot.action('del', async (ctx) => {
  await ctx.answerCbQuery();
  await show(
    ctx,
    '<b>Delete all your data?</b>\nThis removes your profile, logo, customers and all saved documents. Payment records are kept for accounting. This cannot be undone.',
    Markup.inlineKeyboard([[btn('Yes, delete everything', 'del:yes')], [btn('Cancel', 'prof')]])
  );
});

bot.action('del:yes', async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.from.id;
  await pool.query('DELETE FROM documents WHERE tg_id = $1', [id]);
  await pool.query('DELETE FROM customers WHERE tg_id = $1', [id]);
  await pool.query('DELETE FROM users WHERE tg_id = $1', [id]);
  states.delete(id);
  await show(ctx, 'Your data has been deleted. Send /start to begin again.', Markup.inlineKeyboard([]));
});

// ───────────────────────── Help ─────────────────────────
bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await show(
    ctx,
    `<b>ℹ️ How it works</b>\n` +
      `1. Tap <b>New Invoice</b> or <b>New Receipt</b>\n` +
      (WEBAPP_URL
        ? `2. Tap <b>Open form</b>, fill in the customer and items, then tap Preview\n`
        : `2. Send the customer's name, then the items, one per line\n`) +
      `3. Check the preview, pick a template if you like, and tap <b>Generate PDF</b>\n\n` +
      (WEBAPP_URL ? '' : `${ITEMS_HELP}\n\n`) +
      `Set your business name, phone and address under <b>Business Profile</b>.`,
    Markup.inlineKeyboard([[btn('⬅️ Back', 'menu')]])
  );
});

// ───────────────────────── Payments (Paystack) ─────────────────────────
async function activate(tgId, planKey, reference, amountKobo) {
  const plan = PLANS[planKey];
  if (!plan || Number(amountKobo) < plan.price * 100) return 'invalid';
  const ins = await pool.query(
    'INSERT INTO payments (reference, tg_id, plan, amount) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING reference',
    [reference, tgId, planKey, amountKobo]
  );
  if (!ins.rowCount) return 'duplicate';
  await pool.query(
    `UPDATE users
     SET plan_expires = GREATEST(COALESCE(plan_expires, now()), now()) + make_interval(days => $2)
     WHERE tg_id = $1`,
    [tgId, plan.days]
  );
  return 'ok';
}

bot.action('up', async (ctx) => {
  await ctx.answerCbQuery();
  const u = await getUser(ctx.from.id);
  if (isAdmin(u.tg_id)) return show(ctx, '👑 You are an admin: every feature is already unlocked.', backToMenu());
  await showUpgrade(ctx, isPro(u) ? `You're on Pro until ${fmtDate(u.plan_expires)}. Buying again extends it.` : '');
});

bot.action(/^buy:(monthly|quarterly|yearly)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!PAYSTACK_SECRET) {
    return show(ctx, 'Payments are not set up yet. Please try again later.', backToMenu());
  }
  const id = ctx.from.id;
  const key = ctx.match[1];
  const plan = PLANS[key];
  const reference = `inv${id}_${Date.now()}`;
  try {
    const { data } = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: `${id}@${EMAIL_DOMAIN}`,
        amount: plan.price * 100,
        reference,
        metadata: { telegram_id: id, plan: key },
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );
    const kb = Markup.inlineKeyboard([
      [Markup.button.url(`💳 Pay ₦${money(plan.price)}`, data.data.authorization_url)],
      [btn('✅ I have paid', `chk:${reference}`)],
      [btn('⬅️ Back', 'up')],
    ]);
    await show(ctx, `<b>Pro · ${plan.label}</b>\nTap Pay, complete the payment, then come back. Pro activates automatically, or tap "I have paid".`, kb);
  } catch (e) {
    console.error('Paystack init error', e.response ? e.response.data : e.message);
    await show(ctx, 'Could not start the payment. Please try again in a moment.', backToMenu());
  }
});

bot.action(/^chk:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const reference = ctx.match[1];
  try {
    const { data } = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );
    const d = data.data;
    if (d.status === 'success' && Number(d.metadata && d.metadata.telegram_id) === ctx.from.id) {
      const res = await activate(ctx.from.id, d.metadata.plan, d.reference, d.amount);
      if (res === 'ok' || res === 'duplicate') {
        return show(ctx, '✅ Pro is active. Thank you!', backToMenu());
      }
    }
    await show(
      ctx,
      'Payment not confirmed yet. If you just paid, wait a few seconds and tap "I have paid" again.',
      Markup.inlineKeyboard([[btn('✅ I have paid', `chk:${reference}`)], [btn('⬅️ Menu', 'menu')]])
    );
  } catch (e) {
    console.error('Paystack verify error', e.response ? e.response.data : e.message);
    await show(ctx, 'Could not check the payment right now. Please try again shortly.', backToMenu());
  }
});

// ───────────────────────── Text input ─────────────────────────
const PROFILE_FIELDS = {
  prof_name: ['biz_name', 60],
  prof_phone: ['phone', 30],
  prof_addr: ['address', 120],
  prof_bank: ['bank', 200],
};

bot.on('text', async (ctx) => {
  const id = ctx.from.id;
  const st = states.get(id);
  const text = ctx.message.text.trim();
  if (!st) return showMenu(ctx, true);

  if (PROFILE_FIELDS[st.step]) {
    const [col, max] = PROFILE_FIELDS[st.step];
    if (col === 'bank' && !isPro(await getUser(id))) return showMenu(ctx, true);
    await pool.query(`UPDATE users SET ${col} = $2 WHERE tg_id = $1`, [id, text.slice(0, max)]);
    states.delete(id);
    return ctx.reply('✅ Saved.', opts(Markup.inlineKeyboard([[btn('🏢 Business Profile', 'prof')]])));
  }

  switch (st.step) {
    case 'customer':
      st.draft.customer = text.slice(0, 80);
      st.step = 'items';
      return ctx.reply(ITEMS_HELP, opts(cancelKeyboard()));

    case 'items': {
      const { items, bad } = parseItems(text);
      if (bad.length || !items.length) {
        const msg = bad.length
          ? `I couldn't read these lines:\n<code>${esc(bad.join('\n'))}</code>\n\nPlease send all the items again.\n\n${ITEMS_HELP}`
          : ITEMS_HELP;
        return ctx.reply(msg, opts(cancelKeyboard()));
      }
      st.draft.items = items;
      st.step = 'preview';
      return ctx.reply(previewText(st), opts(previewKeyboard(st)));
    }

    case 'due':
      st.draft.due = text.slice(0, 40);
      st.draft.dueRaw = st.draft.due;
      st.step = 'preview';
      return ctx.reply(previewText(st), opts(previewKeyboard(st)));

    case 'note':
      st.draft.note = text.slice(0, 200);
      st.step = 'preview';
      return ctx.reply(previewText(st), opts(previewKeyboard(st)));

    case 'preview':
      return ctx.reply('Use the buttons below to continue.\n\n' + previewText(st), opts(previewKeyboard(st)));

    default:
      return showMenu(ctx, true);
  }
});

bot.catch(async (err, ctx) => {
  console.error('Bot error:', err && err.stack ? err.stack : err);
  try {
    const detail =
      ctx.from && isAdmin(ctx.from.id)
        ? `\n\n<code>${esc(String((err && err.message) || err).slice(0, 300))}</code>`
        : '';
    await ctx.reply('Something went wrong. Please try again.' + detail, opts(menuKeyboard(ctx.from && ctx.from.id)));
  } catch (e) {
    /* ignore */
  }
});

// ───────────────────────── Web server: form (Mini App) + Paystack webhook ─────────────────────────
const app = express();
app.get('/', (req, res) => res.send('Invoice bot is running'));

app.get('/form', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'form.html'));
});

app.get('/manage', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'manage.html'));
});

// Validates Telegram Mini App initData and returns the Telegram user (or null)
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try {
    return JSON.parse(params.get('user'));
  } catch (e) {
    return null;
  }
}

app.use('/api', express.json({ limit: '3mb' }));

app.get('/api/init', async (req, res) => {
  try {
    const tg = verifyInitData(req.get('X-Init-Data'));
    if (!tg) return res.status(401).json({ error: 'unauthorized' });
    const u = await getUser(tg.id);
    if (!u) return res.status(404).json({ error: 'Open the bot and send /start first.' });
    const pro = isPro(u);
    const out = { pro, customers: [], customer: null, draft: null, mode: null };
    if (pro) {
      const r = await pool.query(
        'SELECT name, phone FROM customers WHERE tg_id = $1 ORDER BY last_used DESC LIMIT 200',
        [tg.id]
      );
      out.customers = r.rows;
      const cid = Number(req.query.c);
      if (cid) {
        const c = await getCustomer(tg.id, cid);
        if (c) out.customer = { name: c.name, phone: c.phone };
      }
    }
    const st = states.get(tg.id);
    if (req.query.edit && st && st.draft && st.draft.items) {
      out.mode = st.mode;
      out.draft = {
        customer: st.draft.customer,
        phone: st.draft.phone || '',
        items: st.draft.items,
        due: st.draft.dueRaw || '',
        note: st.draft.note || '',
      };
    }
    res.json(out);
  } catch (e) {
    console.error('init error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/submit', async (req, res) => {
  try {
    const tg = verifyInitData(req.get('X-Init-Data'));
    if (!tg) return res.status(401).json({ error: 'unauthorized' });
    const id = tg.id;
    const u = await getUser(id);
    if (!u) return res.status(404).json({ error: 'Open the bot and send /start first.' });

    const b = req.body || {};
    const mode = b.mode === 'receipt' ? 'receipt' : 'invoice';
    const customer = String(b.customer || '').trim().slice(0, 80);
    const items = (Array.isArray(b.items) ? b.items : [])
      .slice(0, 30)
      .map((i) => ({
        name: cap(String((i && i.name) || '').trim().slice(0, 80)),
        qty: Number(i && i.qty),
        price: Number(i && i.price),
      }))
      .filter((i) => i.name && isFinite(i.qty) && i.qty > 0 && isFinite(i.price) && i.price > 0);
    if (!customer) return res.status(400).json({ error: 'Please enter the customer name.' });
    if (!items.length) return res.status(400).json({ error: 'Please add at least one item with a price.' });

    const pro = isPro(u);
    const prev = states.get(id);
    const { due, raw } = formatDue(b.due);
    const st = {
      step: 'preview',
      mode,
      draft: {
        customer,
        phone: String(b.phone || '').trim().slice(0, 30) || null,
        items,
        due,
        dueRaw: raw,
        note: String(b.note || '').trim().slice(0, 200) || null,
        template:
          (prev && prev.draft && prev.draft.template) || (pro ? u.template || 'classic' : 'classic'),
      },
    };
    states.set(id, st);
    await bot.telegram.sendMessage(id, previewText(st), opts(previewKeyboard(st)));
    res.json({ ok: true });
  } catch (e) {
    console.error('submit error', e);
    res.status(500).json({ error: 'Server error' });
  }
});


// ───────────────────────── Manager Mini App API (profile, customers, downloads) ─────────────────────────
// Every route checks Telegram's signed initData, so a user can only touch their own data.
const wrap = (fn) => async (req, res) => {
  try {
    const tg = verifyInitData(req.get('X-Init-Data'));
    if (!tg) return res.status(401).json({ error: 'unauthorized' });
    const u = await getUser(tg.id);
    if (!u) return res.status(404).json({ error: 'Open the bot and send /start first.' });
    await fn(req, res, { tg, u, pro: isPro(u) });
  } catch (e) {
    console.error('api error:', e && e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
};
const needPro = (res, a, what) => {
  if (a.pro) return false;
  res.status(403).json({ error: `${what} is a Pro feature.` });
  return true;
};
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;

async function listCustomers(id) {
  const r = await pool.query(
    `SELECT c.id, c.name, c.phone,
            (SELECT count(*)::int FROM documents d WHERE d.tg_id = c.tg_id AND d.customer_id = c.id) AS docs
     FROM customers c WHERE c.tg_id = $1 ORDER BY c.last_used DESC LIMIT 500`,
    [id]
  );
  return r.rows;
}

async function listDocs(id, pro) {
  const r = await pool.query(
    `SELECT id, kind, number, total, created_at, data->>'customer' AS customer
     FROM documents WHERE tg_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [id, historyLimit(pro)]
  );
  return r.rows;
}

app.get('/api/manage/init', wrap(async (req, res, { tg, u, pro }) => {
  if (pro) await syncCustomers(tg.id);
  const [customers, docs] = await Promise.all([pro ? listCustomers(tg.id) : [], listDocs(tg.id, pro)]);
  res.json({
    pro,
    status: await statusLine(u),
    user: {
      biz_name: u.biz_name || '',
      phone: u.phone || '',
      address: u.address || '',
      bank: u.bank || '',
      accent: u.accent || '1f3a5f',
      template: pro ? u.template || 'classic' : 'classic',
      has_logo: u.has_logo,
    },
    colors: COLORS,
    templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, name: t.name, free: !!t.free })),
    customers,
    docs,
  });
}));

// Business profile
app.post('/api/profile', wrap(async (req, res, { tg, pro }) => {
  const b = req.body || {};
  const sets = {
    biz_name: clean(b.biz_name, 60),
    phone: clean(b.phone, 30),
    address: clean(b.address, 120),
  };
  if (pro) {
    sets.bank = clean(b.bank, 200);
    if (/^[0-9a-f]{6}$/i.test(String(b.accent || ''))) sets.accent = String(b.accent).toLowerCase();
    if (TEMPLATES[b.template]) sets.template = b.template;
  }
  const cols = Object.keys(sets); // fixed, whitelisted column names
  await pool.query(
    `UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE tg_id = $1`,
    [tg.id, ...cols.map((c) => sets[c])]
  );
  res.json({ ok: true });
}));

// Logo (PNG or JPEG, sent as a data URL already resized by the page)
const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;

app.get('/api/logo', wrap(async (req, res, { tg, pro }) => {
  const logo = pro ? await getLogo(tg.id) : null;
  if (!logo) return res.sendStatus(404);
  res.set('Cache-Control', 'no-store');
  res.type(isPng(logo) ? 'image/png' : 'image/jpeg').send(logo);
}));

app.post('/api/logo', wrap(async (req, res, a) => {
  if (needPro(res, a, 'Your logo on documents')) return;
  const s = String((req.body && req.body.image) || '');
  const i = s.indexOf(',');
  if (i < 0 || !/^data:image\/(png|jpeg);base64$/.test(s.slice(0, i))) {
    return res.status(400).json({ error: 'Please choose a PNG or JPG image.' });
  }
  const buf = Buffer.from(s.slice(i + 1), 'base64');
  if (!isPng(buf) && !isJpg(buf)) return res.status(400).json({ error: 'That image could not be read.' });
  if (buf.length > 1.5 * 1024 * 1024) return res.status(413).json({ error: 'Image is too large.' });
  await pool.query('UPDATE users SET logo = $2 WHERE tg_id = $1', [a.tg.id, buf]);
  res.json({ ok: true });
}));

app.delete('/api/logo', wrap(async (req, res, { tg }) => {
  await pool.query('UPDATE users SET logo = NULL WHERE tg_id = $1', [tg.id]);
  res.json({ ok: true });
}));

// Customers
app.post('/api/customers', wrap(async (req, res, a) => {
  if (needPro(res, a, 'Saved customers')) return;
  const b = req.body || {};
  const name = clean(b.name, 80);
  if (!name) return res.status(400).json({ error: 'Please enter the customer name.' });
  const phone = clean(b.phone, 30);
  const id = a.tg.id;
  if (b.id) {
    const c = await getCustomer(id, Number(b.id));
    if (!c) return res.status(404).json({ error: 'Customer not found.' });
    try {
      await pool.query(
        'UPDATE customers SET name = $3, name_key = $4, phone = $5 WHERE tg_id = $1 AND id = $2',
        [id, c.id, name, name.toLowerCase(), phone]
      );
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'A customer with that name already exists.' });
      throw e;
    }
  } else {
    await pool.query(
      `INSERT INTO customers (tg_id, name, name_key, phone) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tg_id, name_key)
       DO UPDATE SET last_used = now(), phone = COALESCE(EXCLUDED.phone, customers.phone)`,
      [id, name, name.toLowerCase(), phone]
    );
  }
  res.json({ ok: true, customers: await listCustomers(id) });
}));

app.delete('/api/customers/:id', wrap(async (req, res, a) => {
  if (needPro(res, a, 'Saved customers')) return;
  const cid = Number(req.params.id);
  if (!Number.isInteger(cid)) return res.status(400).json({ error: 'Bad request' });
  await pool.query('UPDATE documents SET customer_id = NULL WHERE tg_id = $1 AND customer_id = $2', [a.tg.id, cid]);
  await pool.query('DELETE FROM customers WHERE tg_id = $1 AND id = $2', [a.tg.id, cid]);
  res.json({ ok: true, customers: await listCustomers(a.tg.id) });
}));

// Downloads: the PDF is sent to the user's Telegram chat (reliable inside the Mini App)
app.post('/api/docs/:id/send', wrap(async (req, res, { tg, u, pro }) => {
  const did = Number(req.params.id);
  if (!Number.isInteger(did)) return res.status(400).json({ error: 'Bad request' });
  const r = await pool.query('SELECT data, total FROM documents WHERE id = $1 AND tg_id = $2', [did, tg.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Document not found.' });
  const doc = r.rows[0].data;
  const logo = pro && u.has_logo ? await getLogo(tg.id) : null;
  const buf = await buildPdf({ user: u, logo, pro, doc, botName: BOT_NAME });
  await sendPdfTo(tg.id, buf, `${doc.number}.pdf`, { caption: `${doc.number} · ₦${money(r.rows[0].total)}` });
  res.json({ ok: true });
}));

app.post('/paystack/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const sig = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET || '').update(req.body).digest('hex');
  if (
    !PAYSTACK_SECRET ||
    typeof sig !== 'string' ||
    sig.length !== hash.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hash))
  ) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  try {
    const ev = JSON.parse(req.body.toString());
    if (ev.event !== 'charge.success') return;
    const d = ev.data;
    const tgId = Number(d.metadata && d.metadata.telegram_id);
    if (!tgId) return;
    const r = await activate(tgId, d.metadata.plan, d.reference, d.amount);
    if (r === 'ok') {
      await bot.telegram.sendMessage(tgId, '✅ Payment received! Pro is now active.', opts(menuKeyboard(tgId)));
    }
  } catch (e) {
    console.error('Webhook error', e);
  }
});

// ───────────────────────── Start ─────────────────────────
(async () => {
  await initDb();
  const me = await retry(() => bot.telegram.getMe());
  BOT_NAME = me.username;
  app.listen(PORT, () => console.log(`Web server on :${PORT}`));
  bot.launch().catch((e) => {
    console.error('Launch failed', e);
    process.exit(1);
  });
  console.log(`Bot @${BOT_NAME} started${WEBAPP_URL ? ` · form at ${WEBAPP_URL}/form` : ' · form disabled (no WEBAPP_URL)'}`);
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));