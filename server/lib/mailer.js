// Outbound email for field dispatches. Configured with environment variables:
//
//   MAIL_FROM          Sender, e.g. "Estate Monitor <noreply@yourdomain.com>" (required)
//   RESEND_API_KEY     Send through Resend (HTTPS), or
//   SENDGRID_API_KEY   Send through SendGrid (HTTPS), or
//   SMTP_URL           smtps://user:pass@smtp.example.com:465  (implicit TLS)
//                      smtp://user:pass@smtp.example.com:587   (STARTTLS, required)
//   MAIL_REPLY_TO      Optional Reply-To address
//
// Railway blocks outbound SMTP on its lower plans, so an HTTPS provider is the
// safer choice there. With nothing configured, the app offers a mailto link and
// a copy button instead and says so.
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

export const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
export const cleanEmail = (v) => { const s = String(v ?? '').trim().slice(0, 254); return EMAIL_RE.test(s) ? s : null; };

export class Mailer {
  constructor(env = process.env, { transport = null } = {}) {
    this.from = String(env.MAIL_FROM || '').trim();
    this.replyTo = cleanEmail(env.MAIL_REPLY_TO);
    this.provider = env.RESEND_API_KEY ? 'resend' : env.SENDGRID_API_KEY ? 'sendgrid' : env.SMTP_URL ? 'smtp' : null;
    this.keys = { resend: env.RESEND_API_KEY, sendgrid: env.SENDGRID_API_KEY, smtp: env.SMTP_URL };
    this.transport = transport; // tests inject a fake: async (msg) => ({ id })
    if (transport) this.provider = 'test';
  }

  get configured() { return !!(this.provider && (this.from || this.provider === 'test')); }

  status() {
    if (this.configured) return { configured: true, provider: { resend: 'Resend', sendgrid: 'SendGrid', smtp: 'SMTP', test: 'Test transport' }[this.provider], from: this.from || null };
    return { configured: false, provider: null, reason: this.provider ? 'MAIL_FROM is not set' : 'No email provider is set (RESEND_API_KEY, SENDGRID_API_KEY or SMTP_URL, plus MAIL_FROM)' };
  }

  /** Send a plain-text email. Returns { id }. */
  async send({ to, cc = [], subject, text }) {
    if (!this.configured) throw new Error(this.status().reason);
    const rcpt = [to, ...cc].map(cleanEmail);
    if (rcpt.some((x) => !x)) throw new Error('Invalid email address');
    const msg = { from: this.from, to: rcpt[0], cc: rcpt.slice(1), subject: String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200), text: String(text) };
    if (this.transport) return this.transport(msg);
    if (this.provider === 'resend') return this.viaResend(msg);
    if (this.provider === 'sendgrid') return this.viaSendgrid(msg);
    return this.viaSmtp(msg);
  }

  async viaResend(m) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${this.keys.resend}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: m.from, to: [m.to], ...(m.cc.length ? { cc: m.cc } : {}), subject: m.subject, text: m.text, ...(this.replyTo ? { reply_to: this.replyTo } : {}) }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend refused the email (HTTP ${r.status}): ${body.message || body.error || 'no detail'}`);
    return { id: body.id || null };
  }

  async viaSendgrid(m) {
    const addr = (s) => { const x = s.match(/^(.*)<([^>]+)>\s*$/); return x ? { email: x[2].trim(), name: x[1].trim().replace(/^"|"$/g, '') || undefined } : { email: s }; };
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${this.keys.sendgrid}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: m.to }], ...(m.cc.length ? { cc: m.cc.map((email) => ({ email })) } : {}) }],
        from: addr(m.from), ...(this.replyTo ? { reply_to: { email: this.replyTo } } : {}),
        subject: m.subject, content: [{ type: 'text/plain', value: m.text }],
      }),
    });
    if (!r.ok) throw new Error(`SendGrid refused the email (HTTP ${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return { id: r.headers.get('x-message-id') };
  }

  /** Minimal SMTP client: implicit TLS (smtps, 465) or STARTTLS (smtp, 587), AUTH LOGIN. */
  async viaSmtp(m) {
    const u = new URL(this.keys.smtp);
    const secure = u.protocol === 'smtps:';
    const host = u.hostname;
    const port = Number(u.port) || (secure ? 465 : 587);
    const user = decodeURIComponent(u.username || '');
    const pass = decodeURIComponent(u.password || '');
    const envelopeFrom = (m.from.match(/<([^>]+)>/)?.[1] || m.from).trim();
    let sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    sock.setTimeout(20_000);
    let buf = '';
    const waiters = [];
    const onData = (d) => {
      buf += d.toString('utf8');
      // A reply is complete when a line has "NNN " (space, not dash) after the code.
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          waiters.shift()?.resolve(reply);
          return onData(Buffer.alloc(0));
        }
      }
      return undefined;
    };
    const attach = (s) => {
      s.on('data', onData);
      s.on('error', (e) => { while (waiters.length) waiters.shift().reject(e); });
      s.on('timeout', () => { s.destroy(); while (waiters.length) waiters.shift().reject(new Error('SMTP server timed out')); });
    };
    attach(sock);
    const read = () => new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    const expect = async (code, cmd) => {
      if (cmd !== undefined) sock.write(`${cmd}\r\n`);
      const reply = await read();
      if (!reply.startsWith(String(code))) throw new Error(`SMTP ${cmd ? cmd.split(' ')[0] : 'greeting'} failed: ${reply.split('\n').at(-1)}`);
      return reply;
    };
    try {
      if (!secure) await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
      await expect(220);
      const name = os.hostname().replace(/[^a-z0-9.-]/gi, '') || 'localhost';
      let ehlo = await expect(250, `EHLO ${name}`);
      if (!secure) {
        if (!/STARTTLS/i.test(ehlo)) throw new Error('SMTP server does not offer STARTTLS; use smtps:// on port 465');
        await expect(220, 'STARTTLS');
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: host });
        await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
        attach(sock);
        ehlo = await expect(250, `EHLO ${name}`);
      }
      if (user) {
        await expect(334, 'AUTH LOGIN');
        await expect(334, Buffer.from(user).toString('base64'));
        await expect(235, Buffer.from(pass).toString('base64'));
      }
      await expect(250, `MAIL FROM:<${envelopeFrom}>`);
      for (const r of [m.to, ...m.cc]) await expect(250, `RCPT TO:<${r}>`);
      await expect(354, 'DATA');
      const id = `<${crypto.randomUUID()}@${envelopeFrom.split('@')[1] || 'estate-monitor'}>`;
      const headers = [
        `From: ${m.from}`, `To: ${m.to}`, ...(m.cc.length ? [`Cc: ${m.cc.join(', ')}`] : []),
        ...(this.replyTo ? [`Reply-To: ${this.replyTo}`] : []),
        `Subject: =?UTF-8?B?${Buffer.from(m.subject).toString('base64')}?=`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: ${id}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
      ];
      const body = Buffer.from(m.text).toString('base64').replace(/.{1,76}/g, '$&\r\n');
      await expect(250, `${headers.join('\r\n')}\r\n\r\n${body}.`);
      sock.write('QUIT\r\n');
      return { id };
    } finally {
      setTimeout(() => sock.destroy(), 500).unref?.();
    }
  }
}

/** mailto: link for the "no provider configured" fallback (kept under typical URL limits). */
export function mailtoLink({ to, subject, body }) {
  const b = body.length > 1800 ? `${body.slice(0, 1800)}\n\n[Shortened: copy the full text from Estate Monitor]` : body;
  return `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
}
