// gmail-smtp.mjs — minimal Gmail SMTPS sender, zero dependencies.
//
// Born 2026-09-14: a week of daily digests was accepted by Resend but its
// sandbox delivers ONLY to the Resend account owner's address — the user
// never saw a single one. CAJITA already holds GMAIL_USER +
// GMAIL_APP_PASSWORD (the IMAP alert reader authenticates with them every
// morning), and the same App Password authorizes SMTP, so the digest can go
// straight to the user's real inbox with no third-party sandbox in the way.
//
// Implements just enough of RFC 5321 over implicit TLS (port 465):
// greeting → EHLO → AUTH PLAIN → MAIL FROM → RCPT TO → DATA → QUIT.
// The body travels base64-encoded (no dot-stuffing worries, full UTF-8) and
// the subject is RFC 2047-encoded (the digest subjects carry "·").

import { connect } from 'node:tls';

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function chunk76(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join('\r\n');
}

export function sendViaGmail({ user, appPassword, to, subject, html, timeoutMs = 30_000 }) {
  return new Promise((resolvePromise, reject) => {
    const message = [
      'From: career-ops <' + user + '>',
      'To: ' + to,
      'Subject: =?UTF-8?B?' + b64(subject) + '?=',
      'Date: ' + new Date().toUTCString(),
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      chunk76(b64(html)),
    ].join('\r\n');

    const steps = [
      { expect: 220, then: () => send('EHLO cajita.local') },
      { expect: 250, then: () => send('AUTH PLAIN ' + b64('\0' + user + '\0' + appPassword)) },
      { expect: 235, then: () => send('MAIL FROM:<' + user + '>') },
      { expect: 250, then: () => send('RCPT TO:<' + to + '>') },
      { expect: 250, then: () => send('DATA') },
      { expect: 354, then: () => socket.write(message + '\r\n.\r\n') },
      {
        expect: 250,
        then: (line) => {
          finished = true;
          clearTimeout(timer);
          try { send('QUIT'); socket.end(); } catch { /* already closing */ }
          resolvePromise({ accepted: true, response: line });
        },
      },
    ];

    let step = 0;
    let buf = '';
    let finished = false;
    const socket = connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' });
    const fail = (msg) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('smtp timeout after ' + timeoutMs + 'ms (step ' + step + ')'), timeoutMs);
    const send = (line) => socket.write(line + '\r\n');

    socket.on('error', (e) => fail('smtp socket: ' + e.message));
    socket.on('close', () => { if (!finished) fail('smtp connection closed early (step ' + step + ')'); });
    socket.on('data', (d) => {
      if (finished) return;
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        // Multiline replies ("250-SIZE ...") continue; only "250 " ends one.
        if (/^\d{3}-/.test(line)) continue;
        const code = parseInt(line.slice(0, 3), 10);
        const cur = steps[step];
        if (!cur) return;
        if (code !== cur.expect) {
          fail('smtp step ' + step + ' expected ' + cur.expect + ', got: ' + line.slice(0, 200));
          return;
        }
        step++;
        cur.then(line);
        if (finished) return;
      }
    });
  });
}
