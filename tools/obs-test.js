const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cfgPath = path.join(process.env.APPDATA, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
const oc = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
console.log('obs cfg: enabled=', oc.server_enabled, 'port=', oc.server_port, 'pass_len=', (oc.server_password || '').length);

const ws = new WebSocket('ws://127.0.0.1:' + (oc.server_port || 4455));
ws.on('open', () => console.log('OPEN'));
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  console.log('MSG op', m.op, JSON.stringify(m.d).slice(0, 140));
  if (m.op === 0) {
    let auth;
    if (m.d.authentication) {
      const secret = crypto.createHash('sha256').update((oc.server_password || '') + m.d.authentication.salt).digest('base64');
      auth = crypto.createHash('sha256').update(secret + m.d.authentication.challenge).digest('base64');
      console.log('sending Identify with auth');
    } else {
      console.log('sending Identify without auth');
    }
    ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 5, ...(auth ? { authentication: auth } : {}) } }));
  } else if (m.op === 2) {
    console.log('IDENTIFIED OK');
    ws.send(JSON.stringify({ op: 6, d: { requestType: 'GetStreamStatus', requestId: 't1' } }));
  } else if (m.op === 7) {
    console.log('RESP', JSON.stringify(m.d).slice(0, 400));
    process.exit(0);
  }
});
ws.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
ws.on('close', (c, r) => { console.log('CLOSE', c, r ? r.toString() : ''); process.exit(0); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 6000);
