const PDFDocument = require('pdfkit');

const TEMPLATES = {
  classic: { name: 'Classic', free: true },
  modern: { name: 'Modern' },
  minimal: { name: 'Minimal' },
  bold: { name: 'Bold' },
  elegant: { name: 'Elegant' },
};

const money = (n) =>
  Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const sumItems = (items) => items.reduce((t, i) => t + i.qty * i.price, 0);

function buildPdf({ user, logo, pro, doc, sample = false, botName = 'InvoiceBot' }) {
  return new Promise((resolve, reject) => {
    const tpl = pro && TEMPLATES[doc.template] ? doc.template : 'classic';
    const pdf = new PDFDocument({
      size: 'A4',
      margins: { top: 50, left: 50, right: 50, bottom: 40 },
    });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const W = 595.28;
    const L = 50;
    const R = 545;
    const accent = pro ? `#${user.accent || '1f3a5f'}` : '#333333';
    const grey = '#666666';
    const FR = tpl === 'elegant' ? 'Times-Roman' : 'Helvetica';
    const FB = tpl === 'elegant' ? 'Times-Bold' : 'Helvetica-Bold';
    const isInvoice = doc.kind === 'invoice';
    const title = isInvoice ? 'INVOICE' : 'RECEIPT';
    const bizName = user.biz_name || user.first_name || 'My Business';
    const hasLogo = !!(pro && logo);

    const body = () => pdf.font(FR).fontSize(10).fillColor('#000000');
    const drawLogo = (x, yy, w, h) => {
      if (!hasLogo) return false;
      try {
        pdf.image(logo, x, yy, { fit: [w, h] });
        return true;
      } catch (e) {
        return false;
      }
    };
    const meta = (x, yy, w, align, color) => {
      pdf.fillColor(color).font(FR).fontSize(10);
      pdf.text(`No: ${doc.number}`, x, yy, { width: w, align });
      pdf.text(`Date: ${doc.date}`, x, yy + 14, { width: w, align });
      if (isInvoice && doc.due) pdf.text(`Due: ${doc.due}`, x, yy + 28, { width: w, align });
    };
    const contact = (x, w, align, color, size = 9) => {
      pdf.fillColor(color).font(FR).fontSize(size);
      if (user.phone) pdf.text(user.phone, x, pdf.y + 2, { width: w, align });
      if (user.address) pdf.text(user.address, x, pdf.y + 2, { width: w, align });
    };

    // ───────── Headers: each returns the y where the "Bill to" block starts ─────────
    const headers = {
      classic() {
        let tx = L;
        if (drawLogo(L, 45, 80, 60)) tx = L + 95;
        pdf.fillColor(accent).font(FB).fontSize(18).text(bizName, tx, 50, { width: 250 });
        contact(tx, 250, 'left', grey);
        const leftEnd = pdf.y;
        pdf.fillColor(accent).font(FB).fontSize(26)
          .text(title, 300, 50, { width: R - 300, align: 'right' });
        meta(300, 84, R - 300, 'right', grey);
        const y = Math.max(leftEnd, 130) + 15;
        pdf.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor('#dddddd').stroke();
        return y + 12;
      },

      modern() {
        pdf.rect(0, 0, W, 115).fill(accent);
        let tx = L;
        if (hasLogo) {
          pdf.roundedRect(L - 4, 24, 78, 68, 6).fill('#ffffff');
          if (drawLogo(L, 28, 70, 60)) tx = L + 90;
        }
        pdf.fillColor('#ffffff').font(FB).fontSize(20).text(bizName, tx, 32, { width: 240 });
        contact(tx, 240, 'left', '#ffffff');
        pdf.fillColor('#ffffff').font(FB).fontSize(24)
          .text(title, 300, 28, { width: R - 300, align: 'right' });
        meta(300, 62, R - 300, 'right', '#ffffff');
        return 140;
      },

      minimal() {
        let tx = L;
        if (drawLogo(L, 45, 60, 45)) tx = L + 75;
        pdf.fillColor('#111111').font(FB).fontSize(14).text(bizName, tx, 50, { width: 250 });
        contact(tx, 250, 'left', grey);
        const leftEnd = pdf.y;
        pdf.fillColor('#111111').font(FR).fontSize(12)
          .text(title, 300, 50, { width: R - 300, align: 'right', characterSpacing: 4 });
        meta(300, 70, R - 300, 'right', grey);
        const y = Math.max(leftEnd, 105) + 15;
        pdf.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor('#111111').stroke();
        return y + 14;
      },

      bold() {
        pdf.rect(0, 0, W, 135).fill(accent);
        pdf.fillColor('#ffffff').font(FB).fontSize(38).text(title, L, 36, { width: 300 });
        meta(L, 90, 250, 'left', '#ffffff');
        let rw = R - 300;
        if (hasLogo) {
          pdf.roundedRect(R - 76, 26, 76, 66, 6).fill('#ffffff');
          drawLogo(R - 72, 29, 68, 60);
          rw = R - 300 - 88;
        }
        pdf.fillColor('#ffffff').font(FB).fontSize(13).text(bizName, 300, 38, { width: rw, align: 'right' });
        contact(300, rw, 'right', '#ffffff');
        return 162;
      },

      elegant() {
        let yy = 45;
        if (hasLogo) {
          drawLogo((W - 70) / 2, 40, 70, 50);
          yy = 98;
        }
        pdf.fillColor(accent).font(FB).fontSize(22)
          .text(bizName, L, yy, { width: R - L, align: 'center' });
        contact(L, R - L, 'center', grey, 10);
        const ly = pdf.y + 10;
        pdf.moveTo(L, ly).lineTo(R, ly).lineWidth(1.5).strokeColor(accent).stroke();
        pdf.moveTo(L, ly + 3).lineTo(R, ly + 3).lineWidth(0.5).strokeColor(accent).stroke();
        pdf.fillColor('#111111').font(FR).fontSize(15)
          .text(title, L, ly + 14, { width: R - L, align: 'center', characterSpacing: 5 });
        const parts = [`No. ${doc.number}`, doc.date];
        if (isInvoice && doc.due) parts.push(`Due ${doc.due}`);
        pdf.fillColor(grey).font(FR).fontSize(10)
          .text(parts.join('   -   '), L, pdf.y + 4, { width: R - L, align: 'center' });
        return pdf.y + 24;
      },
    };

    const billY = headers[tpl]();

    // ───────── Customer ─────────
    pdf.fillColor(grey).font(FR).fontSize(9)
      .text(isInvoice ? 'BILL TO' : 'RECEIVED FROM', L, billY);
    pdf.fillColor('#000000').font(FB).fontSize(13).text(doc.customer, L, pdf.y + 2, { width: 300 });
    if (doc.customerPhone) {
      pdf.fillColor(grey).font(FR).fontSize(9).text(doc.customerPhone, L, pdf.y + 2, { width: 300 });
    }

    // ───────── Table header ─────────
    const ty = pdf.y + 20;
    const hdrText = (color) => {
      pdf.fillColor(color).font(FB).fontSize(10);
      pdf.text('ITEM', 58, ty + 6, { width: 230 });
      pdf.text('QTY', 295, ty + 6, { width: 45, align: 'right' });
      pdf.text('PRICE', 345, ty + 6, { width: 95, align: 'right' });
      pdf.text('AMOUNT', 445, ty + 6, { width: 95, align: 'right' });
    };
    if (tpl === 'modern') {
      pdf.rect(L, ty, R - L, 22).fill('#eef1f5');
      hdrText(accent);
    } else if (tpl === 'minimal') {
      pdf.moveTo(L, ty).lineTo(R, ty).lineWidth(0.5).strokeColor('#111111').stroke();
      pdf.moveTo(L, ty + 22).lineTo(R, ty + 22).lineWidth(0.5).strokeColor('#111111').stroke();
      hdrText('#111111');
    } else if (tpl === 'bold') {
      pdf.rect(L, ty, R - L, 22).fill('#222222');
      hdrText('#ffffff');
    } else if (tpl === 'elegant') {
      pdf.moveTo(L, ty).lineTo(R, ty).lineWidth(1).strokeColor(accent).stroke();
      pdf.moveTo(L, ty + 22).lineTo(R, ty + 22).lineWidth(1).strokeColor(accent).stroke();
      hdrText(accent);
    } else {
      pdf.rect(L, ty, R - L, 22).fill(accent);
      hdrText('#ffffff');
    }

    // ───────── Rows ─────────
    let y = ty + 32;
    let idx = 0;
    for (const it of doc.items) {
      body();
      const h = Math.max(pdf.heightOfString(it.name, { width: 230 }), 12);
      if (y + h > 730) {
        pdf.addPage();
        y = 50;
      }
      if (tpl === 'modern' && idx % 2 === 1) {
        pdf.rect(L, y - 4, R - L, h + 8).fill('#f7f8fa');
      }
      body();
      pdf.text(it.name, 58, y, { width: 230 });
      pdf.text(String(it.qty), 295, y, { width: 45, align: 'right' });
      pdf.text(money(it.price), 345, y, { width: 95, align: 'right' });
      pdf.text(money(it.qty * it.price), 445, y, { width: 95, align: 'right' });
      y += h + 8;
      if (tpl !== 'modern') {
        pdf.moveTo(L, y - 4).lineTo(R, y - 4).lineWidth(0.5)
          .strokeColor(tpl === 'elegant' ? '#d8d0c0' : '#eeeeee').stroke();
      }
      idx += 1;
    }

    // ───────── Total ─────────
    if (y > 690) {
      pdf.addPage();
      y = 50;
    }
    y += 10;
    const total = sumItems(doc.items);
    if (tpl === 'bold') {
      pdf.roundedRect(300, y - 6, R - 300, 30, 4).fill(accent);
      pdf.fillColor('#ffffff').font(FB).fontSize(12);
      pdf.text('TOTAL', 312, y + 3, { width: 80 });
      pdf.text(`NGN ${money(total)}`, 390, y + 3, { width: 147, align: 'right' });
    } else if (tpl === 'modern') {
      pdf.rect(300, y - 6, R - 300, 30).fill('#eef1f5');
      pdf.fillColor(accent).font(FB).fontSize(12);
      pdf.text('TOTAL', 312, y + 3, { width: 80 });
      pdf.text(`NGN ${money(total)}`, 390, y + 3, { width: 147, align: 'right' });
    } else {
      if (tpl === 'elegant' || tpl === 'minimal') {
        pdf.moveTo(300, y - 6).lineTo(R, y - 6).lineWidth(1)
          .strokeColor(tpl === 'elegant' ? accent : '#111111').stroke();
      }
      pdf.fillColor('#000000').font(FB).fontSize(11);
      pdf.text('TOTAL', 300, y, { width: 105, align: 'right' });
      pdf.text(`NGN ${money(total)}`, 410, y, { width: 135, align: 'right' });
    }

    if (!isInvoice) {
      pdf.save();
      pdf.rotate(-10, { origin: [L + 50, y + 10] });
      pdf.roundedRect(L, y - 6, 100, 34, 4).lineWidth(2).strokeColor('#1b7a4b').stroke();
      pdf.fillColor('#1b7a4b').font('Helvetica-Bold').fontSize(20)
        .text('PAID', L, y + 1, { width: 100, align: 'center' });
      pdf.restore();
    }

    y += 55;
    if (y > 700) {
      pdf.addPage();
      y = 50;
    }

    // ───────── Notes ─────────
    if (doc.note) {
      pdf.fillColor(grey).font(FB).fontSize(9).text('NOTES', L, y);
      body();
      pdf.text(doc.note, L, pdf.y + 2, { width: 320 });
      y = pdf.y + 16;
    }

    // ───────── Payment details (Pro, invoices) ─────────
    if (isInvoice && pro && user.bank) {
      if (y > 700) {
        pdf.addPage();
        y = 50;
      }
      pdf.fillColor(grey).font(FB).fontSize(9).text('PAYMENT DETAILS', L, y);
      body();
      pdf.text(user.bank, L, pdf.y + 2, { width: 320 });
    }

    // ───────── Footer (Free) ─────────
    if (!pro) {
      pdf.fillColor('#999999').font('Helvetica').fontSize(8)
        .text(`Created with @${botName}`, L, 785, { width: R - L, align: 'center' });
    }

    // ───────── Sample watermark ─────────
    if (sample) {
      pdf.save();
      pdf.rotate(-35, { origin: [W / 2, 420] });
      pdf.fillOpacity(0.12).fillColor('#cc0000').font('Helvetica-Bold').fontSize(90)
        .text('SAMPLE', 0, 380, { width: W, align: 'center' });
      pdf.restore();
    }

    pdf.end();
  });
}

module.exports = { TEMPLATES, buildPdf, money, sumItems };