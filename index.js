require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const express = require('express');
const crypto = require('crypto');

// ───────────────────────── Config ─────────────────────────
const { BOT_TOKEN, DATABASE_URL, PAYSTACK_SECRET, PGSSL } = process.env;
if (!BOT_TOKEN || !DATABASE_URL) {
  console.error('Missing BOT_TOKEN or DATABASE_URL in .env');
  process.exit(1);
}

const FREE_LIMIT = parseInt(process.env.FREE_LIMIT || '5', 10);
const PORT = process.env.PORT || 3000;
const EMAIL_DOMAIN = process.env.PAYSTACK_EMAIL_DOMAIN || 'invoicebot.app';
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
const bot = new Telegraf(BOT_TOKEN);
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
  `);
}

async function upsertUser(from) {
  await pool.query(
    `INSERT INTO users (tg_id, first_name) VALUES ($1, $2)
     ON CONFLICT (tg_id) DO NOTHING`,
    [from.id, from.first_name || null]
  );
}

async function getUser(id) {
  const r = await pool.query(
    `SELECT tg_id, first_name, biz_name, phone, address, bank, accent,
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

const isPro = (u) => !!(u && u.plan_expires && new Date(u.plan_expires) > new Date());

// ───────────────────────── Helpers ─────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) =>
  Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtDate = (d) =>
  new Date(d).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
const sumItems = (items) => items.reduce((t, i) => t + i.qty * i.price, 0);
const btn = Markup.button.callback;
const opts = (kb) => ({ parse_mode: 'HTML', reply_markup: kb.reply_markup });

// Edit the current message when a button was pressed, otherwise send a new one
async function show(ctx, text, kb) {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, opts(kb));
      return;
    } catch (e) {
      // message not editable or unchanged, fall through and send a new one
    }
  }
  await ctx.reply(text, opts(kb));
}

// "2 bags rice 45000" -> { name: 'Bags rice', qty: 2, price: 45000 }  (price is per unit)
function parseLine(line) {
  const tokens = line.replace(/,/g, '').trim().split(/\s+/);
  if (tokens.length < 2) {
    // allow a single token like "delivery" only if it has no price -> invalid
    return null;
  }
  const last = tokens[tokens.length - 1];
  const pm = last.match(/^[₦N]?(\d+(?:\.\d+)?)(k)?$/i);
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
  return { name: name.charAt(0).toUpperCase() + name.slice(1), qty, price };
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

// ───────────────────────── PDF ─────────────────────────
function buildPdf({ user, logo, pro, doc }) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margins: { top: 50, left: 50, right: 50, bottom: 40 },
    });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const accent = pro ? `#${user.accent || '1f3a5f'}` : '#333333';
    const grey = '#666666';
    const isInvoice = doc.kind === 'invoice';
    const L = 50;
    const R = 545;
    const body = () => pdf.font('Helvetica').fontSize(10).fillColor('#000000');

    // Header: logo + business details (left), title + number/date (right)
    let textX = L;
    if (pro && logo) {
      try {
        pdf.image(logo, L, 45, { fit: [80, 60] });
        textX = L + 95;
      } catch (e) {
        /* ignore unreadable logo */
      }
    }
    pdf.fillColor(accent).font('Helvetica-Bold').fontSize(18)
      .text(user.biz_name || user.first_name || 'My Business', textX, 50, { width: 250 });
    pdf.fillColor(grey).font('Helvetica').fontSize(9);
    if (user.phone) pdf.text(user.phone, textX, pdf.y + 2, { width: 250 });
    if (user.address) pdf.text(user.address, textX, pdf.y + 2, { width: 250 });
    const leftEnd = pdf.y;

    pdf.fillColor(accent).font('Helvetica-Bold').fontSize(26)
      .text(isInvoice ? 'INVOICE' : 'RECEIPT', 300, 50, { width: R - 300, align: 'right' });
    pdf.fillColor(grey).font('Helvetica').fontSize(10);
    pdf.text(`No: ${doc.number}`, 300, 84, { width: R - 300, align: 'right' });
    pdf.text(`Date: ${doc.date}`, 300, 98, { width: R - 300, align: 'right' });
    if (isInvoice && doc.due) {
      pdf.text(`Due: ${doc.due}`, 300, 112, { width: R - 300, align: 'right' });
    }

    let y = Math.max(leftEnd, 130) + 15;
    pdf.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor('#dddddd').stroke();

    // Customer
    pdf.fillColor(grey).font('Helvetica').fontSize(9)
      .text(isInvoice ? 'BILL TO' : 'RECEIVED FROM', L, y + 12);
    pdf.fillColor('#000000').font('Helvetica-Bold').fontSize(13)
      .text(doc.customer, L, pdf.y + 2, { width: 300 });

    // Table header
    const ty = pdf.y + 20;
    pdf.rect(L, ty, R - L, 22).fill(accent);
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
    pdf.text('ITEM', 58, ty + 6, { width: 230 });
    pdf.text('QTY', 295, ty + 6, { width: 45, align: 'right' });
    pdf.text('PRICE', 345, ty + 6, { width: 95, align: 'right' });
    pdf.text('AMOUNT', 445, ty + 6, { width: 95, align: 'right' });

    // Rows
    y = ty + 32;
    body();
    for (const it of doc.items) {
      const h = pdf.heightOfString(it.name, { width: 230 });
      if (y + h > 730) {
        pdf.addPage();
        y = 50;
        body();
      }
      pdf.text(it.name, 58, y, { width: 230 });
      pdf.text(String(it.qty), 295, y, { width: 45, align: 'right' });
      pdf.text(money(it.price), 345, y, { width: 95, align: 'right' });
      pdf.text(money(it.qty * it.price), 445, y, { width: 95, align: 'right' });
      y += h + 8;
      pdf.moveTo(L, y - 4).lineTo(R, y - 4).lineWidth(0.5).strokeColor('#eeeeee').stroke();
    }

    // Total
    if (y > 700) {
      pdf.addPage();
      y = 50;
    }
    y += 8;
    const total = sumItems(doc.items);
    pdf.fillColor('#000000').font('Helvetica-Bold').fontSize(11);
    pdf.text('TOTAL', 300, y, { width: 105, align: 'right' });
    pdf.text(`NGN ${money(total)}`, 410, y, { width: 135, align: 'right' });

    if (!isInvoice) {
      pdf.save();
      pdf.rotate(-10, { origin: [L + 50, y + 10] });
      pdf.roundedRect(L, y - 6, 100, 34, 4).lineWidth(2).strokeColor('#1b7a4b').stroke();
      pdf.fillColor('#1b7a4b').font('Helvetica-Bold').fontSize(20)
        .text('PAID', L, y + 1, { width: 100, align: 'center' });
      pdf.restore();
    }

    y += 50;
    if (y > 700) {
      pdf.addPage();
      y = 50;
    }

    // Notes
    if (doc.note) {
      pdf.fillColor(grey).font('Helvetica-Bold').fontSize(9).text('NOTES', L, y);
      body();
      pdf.text(doc.note, L, pdf.y + 2, { width: 320 });
      y = pdf.y + 16;
    }

    // Payment details (Pro, invoices only)
    if (isInvoice && pro && user.bank) {
      if (y > 700) {
        pdf.addPage();
        y = 50;
      }
      pdf.fillColor(grey).font('Helvetica-Bold').fontSize(9).text('PAYMENT DETAILS', L, y);
      body();
      pdf.text(user.bank, L, pdf.y + 2, { width: 320 });
    }

    // Footer (Free plan)
    if (!pro) {
      pdf.fillColor('#999999').font('Helvetica').fontSize(8)
        .text(`Created with @${BOT_NAME}`, L, 785, { width: R - L, align: 'center' });
    }

    pdf.end();
  });
}

// ───────────────────────── Keyboards & screens ─────────────────────────
const menuKeyboard = () =>
  Markup.inlineKeyboard([
    [btn('🧾 New Invoice', 'new:invoice'), btn('💵 New Receipt', 'new:receipt')],
    [btn('📂 My Documents', 'hist'), btn('🏢 Business Profile', 'prof')],
    [btn('⭐ Upgrade', 'up'), btn('ℹ️ Help', 'help')],
  ]);

const cancelKeyboard = (to = 'menu') => Markup.inlineKeyboard([[btn('❌ Cancel', to)]]);

async function statusLine(u) {
  if (isPro(u)) return `⭐ Pro active until ${fmtDate(u.plan_expires)}`;
  const n = await monthCount(u.tg_id);
  return `Free plan · ${n}/${FREE_LIMIT} documents used this month`;
}

async function showMenu(ctx, fresh = false) {
  states.delete(ctx.from.id);
  const u = await getUser(ctx.from.id);
  const text = `<b>🧾 Invoice &amp; Receipt Bot</b>\nCreate professional PDF invoices and receipts in seconds.\n\n${await statusLine(u)}\n\nWhat would you like to do?`;
  if (fresh) await ctx.reply(text, opts(menuKeyboard()));
  else await show(ctx, text, menuKeyboard());
}

async function showUpgrade(ctx, intro) {
  const rows = Object.entries(PLANS).map(([key, p]) => [
    btn(`${p.label} · ₦${money(p.price)}`, `buy:${key}`),
  ]);
  rows.push([btn('⬅️ Back', 'menu')]);
  const text =
    `${intro ? intro + '\n\n' : ''}<b>⭐ Pro plan</b>\n` +
    `• Unlimited invoices &amp; receipts\n` +
    `• Your logo, brand colour and bank details on invoices\n` +
    `• No "Created with" footer\n` +
    `• Longer document history\n\n` +
    `Choose a plan:`;
  await show(ctx, text, Markup.inlineKeyboard(rows));
}

function previewText(st) {
  const d = st.draft;
  const lines = d.items.map(
    (i) => `• ${esc(i.name)} — ${i.qty} × ${money(i.price)} = ${money(i.qty * i.price)}`
  );
  let t =
    `<b>${st.mode === 'invoice' ? 'Invoice' : 'Receipt'} preview</b>\n` +
    `Customer: <b>${esc(d.customer)}</b>\n\n${lines.join('\n')}\n\n` +
    `Total: <b>₦${money(sumItems(d.items))}</b>`;
  if (d.due) t += `\nDue: ${esc(d.due)}`;
  if (d.note) t += `\nNote: ${esc(d.note)}`;
  return t;
}

function previewKeyboard(st) {
  const rows = [
    [btn('✅ Generate PDF', 'doc:gen')],
    [btn('✏️ Edit items', 'doc:items'), btn('📝 Note', 'doc:note')],
  ];
  if (st.mode === 'invoice') rows.push([btn('📅 Due date', 'doc:due')]);
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

// ───────────────────────── Middleware ─────────────────────────
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

// ───────────────────────── New document flow ─────────────────────────
bot.action(/^new:(invoice|receipt)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.from.id;
  const u = await getUser(id);
  if (!isPro(u) && (await monthCount(id)) >= FREE_LIMIT) {
    return showUpgrade(ctx, `You've used all ${FREE_LIMIT} free documents this month.`);
  }
  states.set(id, { step: 'customer', mode: ctx.match[1], draft: { items: [] } });
  await show(
    ctx,
    `<b>New ${ctx.match[1]}</b>\nWho is it for? Send the customer's name.`,
    cancelKeyboard()
  );
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

bot.action('doc:gen', async (ctx) => {
  await ctx.answerCbQuery('Generating…');
  const id = ctx.from.id;
  const st = states.get(id);
  if (!st || !st.draft.items.length) return showMenu(ctx);

  const user = await getUser(id);
  const pro = isPro(user);
  if (!pro && (await monthCount(id)) >= FREE_LIMIT) {
    return showUpgrade(ctx, `You've used all ${FREE_LIMIT} free documents this month.`);
  }

  const col = st.mode === 'invoice' ? 'inv_seq' : 'rec_seq';
  const prefix = st.mode === 'invoice' ? 'INV' : 'REC';
  const r = await pool.query(
    `UPDATE users SET ${col} = ${col} + 1 WHERE tg_id = $1 RETURNING ${col} AS n`,
    [id]
  );
  const number = `${prefix}-${String(r.rows[0].n).padStart(4, '0')}`;
  const d = st.draft;
  const docData = {
    kind: st.mode,
    number,
    date: fmtDate(new Date()),
    customer: d.customer,
    items: d.items,
    due: d.due || null,
    note: d.note || null,
  };
  const total = sumItems(d.items);
  await pool.query(
    'INSERT INTO documents (tg_id, kind, number, data, total) VALUES ($1, $2, $3, $4, $5)',
    [id, st.mode, number, JSON.stringify(docData), total]
  );

  const logo = pro && user.has_logo ? await getLogo(id) : null;
  const buf = await buildPdf({ user, logo, pro, doc: docData });
  states.delete(id);
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch (e) {
    /* ignore */
  }
  await ctx.replyWithDocument(
    { source: buf, filename: `${number}.pdf` },
    { caption: `${number} · ₦${money(total)}` }
  );
  await showMenu(ctx, true);
});

// ───────────────────────── History ─────────────────────────
bot.action('hist', async (ctx) => {
  await ctx.answerCbQuery();
  states.delete(ctx.from.id);
  const u = await getUser(ctx.from.id);
  const limit = isPro(u) ? 10 : 3;
  const r = await pool.query(
    'SELECT id, number, total, created_at FROM documents WHERE tg_id = $1 ORDER BY created_at DESC LIMIT $2',
    [ctx.from.id, limit]
  );
  if (!r.rowCount) {
    return show(ctx, 'No documents yet. Create your first one!', Markup.inlineKeyboard([[btn('⬅️ Back', 'menu')]]));
  }
  const rows = r.rows.map((d) => [
    btn(`${d.number} · ₦${money(d.total)} · ${fmtDate(d.created_at)}`, `doc:view:${d.id}`),
  ]);
  rows.push([btn('⬅️ Back', 'menu')]);
  const note = isPro(u) ? 'Your last 10 documents. Tap one to get the PDF again.' : 'Your last 3 documents (Pro keeps 10). Tap one to get the PDF again.';
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
  const buf = await buildPdf({ user, logo, pro, doc });
  await ctx.replyWithDocument({ source: buf, filename: `${doc.number}.pdf` });
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
  const kb = Markup.inlineKeyboard([
    [btn('Name', 'prof:name'), btn('Phone', 'prof:phone'), btn('Address', 'prof:addr')],
    [btn(`${lock}Bank details`, 'prof:bank'), btn(`${lock}Logo`, 'prof:logo')],
    [btn(`${lock}Brand colour`, 'prof:color')],
    [btn('🗑 Delete my data', 'del')],
    [btn('⬅️ Back', 'menu')],
  ]);
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
    return ctx.reply('To set a logo, open Business Profile → Logo first.', opts(menuKeyboard()));
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
    '<b>Delete all your data?</b>\nThis removes your profile, logo and all saved documents. Payment records are kept for accounting. This cannot be undone.',
    Markup.inlineKeyboard([[btn('Yes, delete everything', 'del:yes')], [btn('Cancel', 'prof')]])
  );
});

bot.action('del:yes', async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.from.id;
  await pool.query('DELETE FROM documents WHERE tg_id = $1', [id]);
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
      `2. Send the customer's name\n` +
      `3. Send the items, one per line\n` +
      `4. Check the preview, then tap <b>Generate PDF</b>\n\n` +
      `${ITEMS_HELP}\n\n` +
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

const backToMenu = () => Markup.inlineKeyboard([[btn('⬅️ Menu', 'menu')]]);

bot.action('up', async (ctx) => {
  await ctx.answerCbQuery();
  const u = await getUser(ctx.from.id);
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
  console.error('Bot error', err);
  try {
    await ctx.reply('Something went wrong. Please try again.', opts(menuKeyboard()));
  } catch (e) {
    /* ignore */
  }
});

// ───────────────────────── Web server (Paystack webhook) ─────────────────────────
const app = express();
app.get('/', (req, res) => res.send('Invoice bot is running'));

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
      await bot.telegram.sendMessage(tgId, '✅ Payment received! Pro is now active.', opts(menuKeyboard()));
    }
  } catch (e) {
    console.error('Webhook error', e);
  }
});

// ───────────────────────── Start ─────────────────────────
(async () => {
  await initDb();
  const me = await bot.telegram.getMe();
  BOT_NAME = me.username;
  app.listen(PORT, () => console.log(`Web server on :${PORT}`));
  bot.launch().catch((e) => {
    console.error('Launch failed', e);
    process.exit(1);
  });
  console.log(`Bot @${BOT_NAME} started`);
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
