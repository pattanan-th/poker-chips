// PeerJS wrapper. The host's browser is the server: it owns the game state and
// every client connects straight to it. Room code -> fixed peer id, so a host
// that reloads can reclaim the same room.
(function (root) {
  'use strict';

  const PREFIX = 'pkchips-v1-';
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function randomCode() {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return c;
  }

  // Host: onMessage(clientId, msg), onPeers(ids) when the connected set changes.
  function host(code, { onOpen, onMessage, onPeers, onStatus }) {
    const conns = new Map(); // clientId -> conn
    let peer, retry = 0, dead = false;

    function emitPeers() { onPeers([...conns.keys()]); }

    function start() {
      peer = new Peer(PREFIX + code, { debug: 1 });
      peer.on('open', () => { retry = 0; onStatus('online'); onOpen && onOpen(); });
      peer.on('connection', (conn) => {
        let cid = null;
        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.t === 'hello' && typeof msg.id === 'string') {
            cid = msg.id;
            const old = conns.get(cid);
            if (old && old !== conn) old.close();
            conns.set(cid, conn);
            emitPeers();
          }
          if (cid) onMessage(cid, msg);
        });
        conn.on('close', () => { if (cid && conns.get(cid) === conn) { conns.delete(cid); emitPeers(); } });
        conn.on('error', () => {});
      });
      peer.on('disconnected', () => { onStatus('reconnecting'); if (!dead) setTimeout(() => !dead && !peer.destroyed && peer.reconnect(), 1500); });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          // our old session still holds the id on the signalling server; it frees up within ~a minute
          onStatus('claiming');
          peer.destroy();
          if (!dead) setTimeout(start, Math.min(2000 + retry++ * 1000, 8000));
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          onStatus('reconnecting');
        }
      });
    }
    start();

    return {
      send(cid, msg) { const c = conns.get(cid); if (c && c.open) c.send(msg); },
      broadcast(msgFor) { conns.forEach((c, cid) => { if (c.open) c.send(msgFor(cid)); }); },
      kick(cid) { const c = conns.get(cid); if (c) c.close(); },
      destroy() { dead = true; peer && peer.destroy(); },
    };
  }

  // Client: connects to the host and keeps reconnecting.
  function client(code, myId, name, hello, { onMessage, onStatus }) {
    let peer = null, conn = null, dead = false, timer = null, lastMsg = 0;

    function scheduleConnect(ms) { clearTimeout(timer); if (!dead) timer = setTimeout(connect, ms); }

    function connect() {
      if (dead) return;
      if (!peer || peer.destroyed) {
        peer = new Peer({ debug: 1 });
        peer.on('open', () => connect());
        peer.on('disconnected', () => { if (!dead && !peer.destroyed) peer.reconnect(); });
        peer.on('error', (err) => {
          if (err.type === 'peer-unavailable') onStatus('no-host');
          else onStatus('reconnecting');
          scheduleConnect(2500);
        });
        return;
      }
      if (!peer.open) return; // 'open' handler will call us
      if (conn && conn.open) return;
      onStatus('connecting');
      conn = peer.connect(PREFIX + code, { reliable: true });
      const c = conn;
      c.on('open', () => { lastMsg = Date.now(); onStatus('online'); c.send(Object.assign({ t: 'hello', id: myId, name }, hello)); });
      c.on('data', (msg) => { lastMsg = Date.now(); onMessage(msg); });
      c.on('close', () => { if (conn === c) { onStatus('reconnecting'); scheduleConnect(1500); } });
      c.on('error', () => { if (conn === c) scheduleConnect(2500); });
      // if the data channel never opens, try again
      setTimeout(() => { if (conn === c && !c.open) { c.close(); scheduleConnect(500); } }, 9000);
    }

    // host pings every few seconds; silence means a half-dead connection (common after phone sleep)
    const watchdog = setInterval(() => {
      if (conn && conn.open && Date.now() - lastMsg > 12000) { conn.close(); }
    }, 4000);

    connect();
    return {
      send(msg) { if (conn && conn.open) { conn.send(msg); return true; } return false; },
      poke() { if (!conn || !conn.open) { if (peer && peer.disconnected && !peer.destroyed) peer.reconnect(); scheduleConnect(100); } },
      destroy() { dead = true; clearInterval(watchdog); clearTimeout(timer); peer && peer.destroy(); },
    };
  }

  root.Net = { host, client, randomCode };
})(this);
