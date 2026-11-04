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
  // probe: when the room id is taken, check whether a live host answers there and
  // call onLostId() instead of retrying forever (someone else took over the room).
  function host(code, { onOpen, onMessage, onPeers, onStatus, onLostId, probe: useProbe }) {
    const conns = new Map(); // clientId -> conn
    const seen = new Map();  // clientId -> last time we heard from it
    let peer, retry = 0, dead = false, wasOpen = false;

    function emitPeers() { onPeers([...conns.keys()]); }

    function start() {
      peer = new Peer(PREFIX + code, { debug: 1 });
      peer.on('open', () => { retry = 0; wasOpen = true; onStatus('online'); onOpen && onOpen(); });
      peer.on('connection', (conn) => {
        let cid = null;
        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (cid) seen.set(cid, Date.now());
          if (msg.t === 'beat') return;
          if (msg.t === 'hello' && typeof msg.id === 'string') {
            cid = msg.id;
            const old = conns.get(cid);
            if (old && old !== conn) old.close();
            conns.set(cid, conn);
            seen.set(cid, Date.now());
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
          const again = () => { if (!dead) setTimeout(start, Math.min(2000 + retry++ * 1000, 8000)); };
          if (!(useProbe || wasOpen) || !onLostId) return again();
          probe(code).then((alive) => { if (dead) return; if (alive) { dead = true; onLostId(); } else again(); });
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          onStatus('reconnecting');
        }
      });
    }
    start();

    // a phone that closed the page or lost signal often leaves its connection open on our side:
    // clients beat every few seconds, so silence means they're gone
    const sweep = setInterval(() => {
      const t = Date.now();
      conns.forEach((c, cid) => { if (t - (seen.get(cid) || 0) > 12000) { conns.delete(cid); c.close(); emitPeers(); } });
    }, 3000);

    return {
      send(cid, msg) { const c = conns.get(cid); if (c && c.open) c.send(msg); },
      broadcast(msgFor) { conns.forEach((c, cid) => { if (c.open) c.send(msgFor(cid)); }); },
      kick(cid) { const c = conns.get(cid); if (c) c.close(); },
      destroy() { dead = true; clearInterval(sweep); peer && peer.destroy(); },
    };
  }

  // Resolves true if a host is answering on the room id right now.
  function probe(code) {
    return new Promise((resolve) => {
      let done = false;
      const p = new Peer({ debug: 0 });
      const finish = (v) => { if (done) return; done = true; clearTimeout(t); setTimeout(() => p.destroy(), 100); resolve(v); };
      const t = setTimeout(() => finish(false), 8000);
      p.on('open', () => {
        const c = p.connect(PREFIX + code, { reliable: true });
        c.on('open', () => finish(true));
        c.on('error', () => finish(false));
      });
      p.on('error', () => finish(false));
    });
  }

  // Client: connects to the host and keeps reconnecting.
  function client(code, myId, name, hello, { onMessage, onStatus }) {
    let peer = null, conn = null, dead = false, timer = null, lastMsg = 0, fails = 0;
    const backoff = () => Math.min(1500 * 2 ** fails++, 8000);

    function scheduleConnect(ms) { clearTimeout(timer); if (!dead) timer = setTimeout(connect, ms); }

    function connect() {
      if (dead) return;
      if (!peer || peer.destroyed) {
        const p = peer = new Peer({ debug: 1 });
        p.on('open', () => { fails = 0; connect(); });
        // back off instead of hammering the signalling server when the network is down
        p.on('disconnected', () => { if (!dead && !p.destroyed) setTimeout(() => { if (!dead && !p.destroyed && p.disconnected) p.reconnect(); }, backoff()); });
        p.on('error', (err) => {
          if (err.type === 'browser-incompatible') { onStatus('unsupported'); dead = true; p.destroy(); return; }
          if (err.type === 'peer-unavailable') onStatus('no-host');
          else onStatus('reconnecting');
          // a broken signalling socket leaves the peer unusable: start over with a fresh one
          if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) p.destroy();
          scheduleConnect(backoff());
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
      if (conn && conn.open && Date.now() - lastMsg > 12000) { conn.close(); return; }
      if (conn && conn.open) conn.send({ t: 'beat' }); // tells the host we're still here
    }, 4000);

    connect();
    return {
      send(msg) { if (conn && conn.open) { conn.send(msg); return true; } return false; },
      poke() { if (!conn || !conn.open) { if (peer && peer.disconnected && !peer.destroyed) peer.reconnect(); scheduleConnect(100); } },
      destroy() { dead = true; clearInterval(watchdog); clearTimeout(timer); peer && peer.destroy(); },
    };
  }

  root.Net = { host, client, probe, randomCode };
})(this);
