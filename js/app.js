// UI + host/client glue. The host applies every command to the game state and
// broadcasts the whole state; clients only render it and send commands.
(function () {
  'use strict';
  const E = window.Engine;
  const Cards = window.Cards;
  const $app = document.getElementById('app');
  const params = new URLSearchParams(location.search);

  // ---------- identity / storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }, // false: private mode or storage full
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  // the release number is the ?v=N on the script tags, so there's nothing extra to bump
  const APP_VER = (() => { const s = document.currentScript || document.querySelector('script[src*="app.js"]'); const m = s && /[?&]v=(\d+)/.exec(s.src); return m ? `v${m[1]}` : ''; })();
  const RANDOM_NAMES = ['เจ', 'โจ้', 'จิน', 'แจง', 'เจฟ', 'เจี๊ยบ', 'จอร์จ', 'จอห์น', 'จิ๊บ', // 🎲 next to the name box
    'จ๋า', 'จุ๊บ', 'จิ๋ว', 'จูน', 'แจ๊ค', 'จั๊ม', 'จ๊ะจ๋า', 'จูเนียร์', 'โจโจ้', 'เจน'];
  const NAME_MAX = 100; // only a guard against junk; long names scroll in the player list
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  // ?pid= lets several tabs on one device be different players (testing)
  const myId = params.get('pid') || store.get('pk:id') || (() => { const id = rid(); store.set('pk:id', id); return id; })();
  let myName = store.get('pk:name', '');
  // picture shown in the seat instead of the name's first letter; a kangaroo until you pick ('' = none)
  let myEmoji = store.get('pk:emoji', '🦘');
  const EMOJIS = ['🦘', '😎', '🤠', '🥷', '🦊', '🐯', '🐼', '🐸', '👻', '🦄', '🔥', '💎', '🍀', '🎯', '👑', '💰'];
  // keep one emoji (or one character): the first grapheme, so flags and skin tones stay whole
  function cleanEmoji(v) {
    const t = String(v || '').trim();
    if (!t) return '';
    const first = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter().segment(t)][0].segment : Array.from(t)[0];
    return first.slice(0, 16);
  }

  // ---------- app state ----------
  let role = null;        // 'host' | 'client'
  let code = null;
  let S = null;           // game state
  let online = new Set(); // client ids connected to the host
  let netStatus = 'offline';
  let net = null;
  let hist = [];          // host: undo snapshots
  let secrets = {};       // host: app-dealt decks by hand number (never broadcast)
  let clockSkew = 0;      // client: host time - local time
  let kicked = false;
  let hostLostAt = null;  // client: when the connection to the host dropped
  const ui = { view: store.get('pk:view', 'table'), raiseOpen: false, raiseTo: 0, sheet: null, proxy: false, sd: null, sdHand: 0, wasMyTurn: false };

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pById = (id) => S && S.players.find((p) => p.id === id);
  // cash without buy-in: show each player's +/- balance instead of a chip count
  const credit = () => !!S && E.isCredit(S);
  const balance = (p) => p.stack - E.CREDIT;
  const chips = (p) => (credit() ? signedFmt(balance(p)) : fmt(p.stack));
  const chipWord = () => (credit() ? 'ยอด' : 'ชิป');
  const now = () => Date.now() + clockSkew;
  const isHost = () => role === 'host';
  const joinUrl = () => location.origin + location.pathname + '?room=' + code;

  function toast(msg, info) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (info ? ' info' : ''); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2800);
  }

  // ---------- host ----------
  // Each hosted room keeps its own save so several games can be resumed; pk:rooms lists
  // recently opened rooms (hosted or joined) for the home screen.
  const hostKey = (c) => 'pk:host:' + c;
  const ROOMS_KEY = 'pk:rooms';

  (function migrateSingleSave() {
    const old = store.get('pk:host', null);
    if (old && old.code) { store.set(hostKey(old.code), old); rememberRoom(old.code, 'host', old.S); }
    store.del('pk:host');
  })();

  function rememberRoom(c, r, game) {
    const rooms = store.get(ROOMS_KEY, []).filter((x) => x.code !== c);
    const info = game ? { mode: game.settings.mode, players: game.players.length, handNo: game.handNo } : {};
    rooms.unshift(Object.assign({ code: c, role: r, at: Date.now() }, info));
    store.set(ROOMS_KEY, rooms.slice(0, 8));
  }

  function forgetRoom(c) {
    store.set(ROOMS_KEY, store.get(ROOMS_KEY, []).filter((x) => x.code !== c));
    store.del(hostKey(c));
  }

  let lastRemember = 0;
  // The phone's storage is small (about 5 MB) and a big table with its undo steps fills it fast.
  // If a save doesn't fit, drop other rooms' saves (oldest first), then keep fewer undo steps,
  // so this game is never left on an old copy that would come back on reopening.
  function saveHost() {
    const rec = (n) => ({ code, S, hist: hist.slice(-n), secrets });
    let ok = store.set(hostKey(code), rec(15));
    if (!ok) {
      const recent = store.get(ROOMS_KEY, []).map((r) => r.code);
      const others = hostSaves().filter((c) => c !== code)
        .sort((a, b) => (recent.indexOf(a) < 0 ? 99 : recent.indexOf(a)) - (recent.indexOf(b) < 0 ? 99 : recent.indexOf(b))).reverse();
      while (!ok && others.length) { store.del(hostKey(others.shift())); ok = store.set(hostKey(code), rec(15)); }
      if (!ok) ok = store.set(hostKey(code), rec(3)) || store.set(hostKey(code), rec(0));
      if (!ok && !ui.saveWarned) { ui.saveWarned = true; toast('พื้นที่ในเครื่องเต็ม — บันทึกเกมไม่ได้ ถ้าปิดแอปเกมล่าสุดจะหาย'); }
    }
    if (Date.now() - lastRemember > 30000) { lastRemember = Date.now(); rememberRoom(code, 'host', S); }
  }
  function hostSaves() {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('pk:host:')) out.push(k.slice(8)); } } catch (e) { /* no storage */ }
    return out;
  }
  // saves of rooms that fell off the recent list can never be reopened: clear them
  function pruneHostSaves() {
    const keep = new Set(store.get(ROOMS_KEY, []).map((r) => r.code).concat(code || []));
    hostSaves().forEach((c) => { if (!keep.has(c)) store.del(hostKey(c)); });
  }

  // probe: if the room id is already taken, check whether another host is live there
  // (someone took over while we were gone) and step down to player instead of fighting for it.
  function startHost(c, game, h, probe, sec) {
    role = 'host'; code = c; S = game; hist = h || []; secrets = sec || {}; online = new Set(); hostLostAt = null;
    pruneHostSaves();
    S.hostId = myId;
    stampClock(true); // a reload or a new host gives the current turn a fresh clock
    Object.keys(offlineSince).forEach((k) => delete offlineSince[k]); // players get time to reconnect to this host
    lastRemember = Date.now(); rememberRoom(code, 'host', S);
    history.replaceState(null, '', location.pathname + '?room=' + code + (params.get('pid') ? '&pid=' + params.get('pid') : ''));
    net = Net.host(code, {
      probe,
      onStatus(st) { netStatus = st; render(); },
      onPeers(ids) { online = new Set(ids); broadcast(); render(); },
      onLostId() { becomeClient('มีเจ้ามือคนใหม่แล้ว — สลับเป็นผู้เล่น'); },
      onMessage(cid, msg) {
        if (msg.t === 'handoffAck' && handoffTimer && cid === S.hostId) {
          clearTimeout(handoffTimer); handoffTimer = null;
          broadcast();
          setTimeout(() => becomeClient(`ส่งต่อให้ ${pById(cid).name} เป็นเจ้ามือแล้ว`), 300);
        } else if (msg.t === 'hello') {
          if ((S.removed || []).includes(cid) && !msg.rejoin) { net.send(cid, { t: 'kicked' }); return; }
          S.removed = (S.removed || []).filter((x) => x !== cid);
          const name = String(msg.name || 'ผู้เล่น').slice(0, NAME_MAX);
          const p = pById(cid);
          if (!p && S.players.length >= seatLimit()) { net.send(cid, { t: 'full', max: seatLimit() }); setTimeout(() => net.kick(cid), 500); toast(`${name} เข้าไม่ได้ — ${fullMsg()}`); return; }
          if (!p) {
            E.addPlayer(S, cid, name);
            const np = pById(cid); np.emoji = cleanEmoji(msg.emoji);
            // a game already under way: they come in watching and sit down when they're ready
            if (S.handNo > 0 && !isPD()) { np.left = true; np.watching = true; }
            saveHost(); toast(`${name} ${np.watching ? 'เข้ามาดู' : 'เข้าห้องแล้ว'}`, true);
          }
          else { if (p.name !== name) p.name = name; if (msg.emoji != null) p.emoji = cleanEmoji(msg.emoji); if (p.leaving === 'gone') p.leaving = null; }
          delete offlineSince[cid];
          broadcast(); render();
        } else if (msg.t === 'cmd') {
          apply(msg.cmd, cid);
        }
      },
    });
    saveHost();
    render();
  }

  // Planned handoff: send the whole game to another phone; it claims the room once we let go.
  let handoffTimer = null;
  let handingOff = false;
  function handoff(targetId) {
    const t = pById(targetId);
    if (!online.has(targetId)) return toast(`${t.name} ไม่ได้ออนไลน์อยู่`);
    const prev = S.hostId;
    handingOff = true;
    S.hostId = targetId;
    S.log.push(`👑 ${t.name} เป็นเจ้ามือแทน`);
    net.send(targetId, { t: 'handoff', s: S, hist: hist.slice(-30), secrets });
    handoffTimer = setTimeout(() => {
      handoffTimer = null; handingOff = false; S.hostId = prev; S.log.pop();
      toast(`ส่งต่อไม่สำเร็จ — เครื่องของ ${t.name} ไม่ตอบ`); render();
    }, 6000);
    toast(`กำลังส่งต่อให้ ${t.name}…`, true);
  }

  function becomeClient(msg) {
    store.del(hostKey(code));
    rememberRoom(code, 'client', S);
    if (net) net.destroy();
    hist = []; secrets = {}; online = new Set(); ui.sheet = null; ui.proxy = false; handingOff = false;
    toast(msg, true);
    startClient(code);
  }

  function broadcast() {
    if (!net || !isHost()) return;
    const ol = [...online];
    net.broadcast((cid) => ({ t: 'state', s: S, online: ol, now: Date.now(), hole: holeFor(cid) }));
  }

  setInterval(() => { if (isHost() && net) net.broadcast(() => ({ t: 'ping', now: Date.now() })); }, 4000);

  function holeFor(id) {
    const h = S && S.hand; const d = h && secrets[h.no];
    return d && d.hole[id] && h.ids.includes(id) ? { no: h.no, cards: d.hole[id] } : null;
  }

  function myHole() {
    const h = S && S.hand;
    if (!h || !h.appCards) return null;
    const x = isHost() ? holeFor(myId) : ui.hole;
    return x && x.no === h.no ? x.cards : null;
  }

  // Seats per room, so a deal never runs out of cards. Hold'em: 2 each + 5 board + 3 burns → 22.
  // Omaha: 4 each + 8 → 11. Pok Deng: up to 3 each, banker included → 17.
  const GAME_NAMES = { nlh: "Texas Hold'em", plo: 'Omaha (PLO)', short: 'Short Deck' };
  const GAME_TAG = { plo: 'PLO', short: 'Short Deck' };
  function seatLimit(game) {
    if (isPD()) return 17;
    return Cards.maxPlayers(game || S.settings.game);
  }
  const fullMsg = () => `ห้องเต็มแล้ว (สูงสุด ${seatLimit()} คน)`;

  const PLAYER_CMDS = ['act', 'rebuy', 'sitout', 'stand', 'leaveSeat', 'rename', 'avatar', 'pdBet', 'show'];
  // Pok Deng: the banker runs the round from their own phone too
  const BANKER_CMDS = ['pdBet', 'pdDeal', 'pdReopen', 'pdSettle'];

  function apply(cmd, from) {
    const fromHost = from === myId;
    let before = null;
    try {
      if (!cmd || typeof cmd !== 'object') throw new Error('คำสั่งไม่ถูกต้อง');
      if (handingOff) throw new Error('กำลังเปลี่ยนเจ้ามือ รอสักครู่แล้วกดใหม่');
      // the player's screen may lag behind (e.g. someone raised meanwhile): don't apply a stale call
      if (!fromHost && cmd.c === 'act' && cmd.seq !== (S.seq || 0)) throw new Error('ยอดบนโต๊ะเปลี่ยนไปแล้ว — ดูอีกครั้งแล้วกดใหม่');
      if (!fromHost) {
        const banker = isPD() && S.pd && S.pd.bankerId === from && BANKER_CMDS.includes(cmd.c);
        if (!banker && (!PLAYER_CMDS.includes(cmd.c) || cmd.pid !== from)) throw new Error(`เฉพาะ${hostWord()}เท่านั้น`);
        if (cmd.c === 'rebuy' && (S.settings.mode !== 'cash' || pById(from).stack > 0)) throw new Error('Rebuy ได้เมื่อชิปหมด (เฉพาะ Cash game)');
      }
      const seq = (S.seq || 0) + 1;
      if (cmd.c === 'undo') {
        if (!hist.length) throw new Error('ไม่มีอะไรให้ย้อน');
        S = JSON.parse(hist.pop());
        S.hostId = myId; // snapshots taken before a handoff name the previous host
        botHold = Date.now() + 5000;
        stampClock(true);
        toast('ย้อนกลับ 1 ขั้นแล้ว', true);
      } else {
        before = JSON.stringify(S);
        run(cmd);
        if (isPD()) PD.tidy(S);
        Cards.sync(S, secrets, E);
        stampClock();
        hist.push(before);
        if (hist.length > 40) hist.shift();
      }
      S.seq = seq;
      saveHost(); broadcast(); render();
    } catch (e) {
      if (before) S = JSON.parse(before);
      if (fromHost) toast(e.message); else net.send(from, { t: 'err', msg: e.message });
    }
  }

  function run(cmd) {
    const t = Date.now();
    switch (cmd.c) {
      case 'act':
        E.act(S, cmd.pid, cmd.type, cmd.amount);
        if (cmd.timeout || cmd.away) {
          const note = cmd.timeout ? ' (หมดเวลา)' : ' (ออกจากโต๊ะ)';
          const acts = S.hand.actions.filter((x) => x.id === cmd.pid); const x = acts[acts.length - 1];
          if (x) x.t += note;
          const i = S.log.map((l, k) => [l, k]).reverse().find(([l]) => l.startsWith(pById(cmd.pid).name + ' '));
          if (i) S.log[i[1]] += note;
        }
        return;
      case 'show': return Cards.show(S, secrets, cmd.pid);
      case 'start':
        if (isPD()) { PD.init(S); S.handNo = Math.max(S.handNo, 1); return; }
        return E.startHand(S, t);
      case 'pdBet': return PD.setBet(S, cmd.pid, cmd.amount);
      case 'pdDeal': return PD.deal(S);
      case 'pdReopen': return PD.reopen(S);
      case 'pdSettle': return PD.settle(S, cmd.results);
      case 'pdBanker': return PD.setBanker(S, cmd.pid);
      case 'pdNet': return PD.setNet(S, cmd.pid, cmd.v);
      case 'award': return E.award(S, cmd.winners);
      case 'rebuy': return E.rebuy(S, cmd.pid);
      case 'stack': return E.setStack(S, cmd.pid, cmd.v, cmd.asBuyIn);
      case 'sitout': return E.setSitOut(S, cmd.pid, cmd.v);
      case 'stand': {
        const p = pById(cmd.pid); const h = S.hand;
        if (cmd.v && h && !h.done && h.ids.includes(cmd.pid) && !h.folded[cmd.pid]) {
          if (!p.leaving) { p.leaving = 'stand'; S.log.push(`${p.name} จะลุกหลังจบมือนี้`); }
          return;
        }
        if (p) p.leaving = null;
        if (p && !cmd.v && p.watching) { p.watching = false; p.left = false; p.sitOut = false; S.log.push(`${p.name} นั่งลงเล่น`); return; }
        if (cmd.auto) S.log.push(`${p.name} ${cmd.auto === 'offline' ? 'หลุดการเชื่อมต่อ' : 'ออกจากห้อง'} — ลุกจากโต๊ะให้อัตโนมัติ`);
        return E.setLeft(S, cmd.pid, cmd.v);
      }
      // the player closed the room: fold their hand when it's their turn, then stand them up
      case 'leaveSeat': { const p = pById(cmd.pid); if (p && !p.left) p.leaving = 'gone'; return; }
      case 'remove':
        E.removePlayer(S, cmd.pid);
        S.removed = (S.removed || []).concat(cmd.pid);
        if (net) { net.send(cmd.pid, { t: 'kicked' }); }
        return;
      case 'move': return E.movePlayer(S, cmd.pid, cmd.dir);
      case 'rename': { const p = pById(cmd.pid); if (p) p.name = String(cmd.name).slice(0, NAME_MAX); return; }
      case 'avatar': { const p = pById(cmd.pid); if (p) p.emoji = cleanEmoji(cmd.emoji); return; }
      case 'join':
        if (!pById(myId) && S.players.length >= seatLimit()) throw new Error(fullMsg());
        E.addPlayer(S, myId, myName);
        pById(myId).emoji = myEmoji;
        return;
      case 'addBot': {
        if (isPD()) throw new Error('ป๊อกเด้งยังไม่มีบอท');
        if (S.players.length >= seatLimit()) throw new Error(fullMsg());
        if (!S.settings.appCards) {
          if (S.hand && !S.hand.done) throw new Error('บอทต้องใช้โหมดแอปแจกไพ่ — เพิ่มได้หลังจบมือ');
          S.settings.appCards = true; // a bot can't hold physical cards
        }
        const used = S.players.filter((p) => p.bot).map((p) => p.botNo);
        let n = 1; while (used.includes(n)) n++;
        const id = 'bot-' + rid();
        E.addPlayer(S, id, `🤖 บอท ${n}`);
        Object.assign(pById(id), { bot: true, botNo: n });
        return;
      }
      case 'pause': return E.setPaused(S, cmd.v, t);
      case 'level': {
        const n = Math.max(0, Math.min(S.settings.levels.length - 1, S.level + cmd.d));
        S.level = n; if (S.levelStart != null) S.levelStart = S.pausedAt != null ? S.pausedAt : t;
        return;
      }
      case 'settings': {
        const old = S.settings;
        if (S.hand && !S.hand.done && cmd.settings.game != null && cmd.settings.game !== (old.game || 'nlh')) throw new Error('เปลี่ยนเกมได้หลังจบมือ');
        if (S.hand && !S.hand.done && cmd.settings.appCards != null && !!cmd.settings.appCards !== !!old.appCards) throw new Error('เปลี่ยนแบบไพ่ได้หลังจบมือ');
        if (cmd.settings.game && cmd.settings.game !== old.game && S.players.length > seatLimit(cmd.settings.game)) throw new Error(`${GAME_NAMES[cmd.settings.game] || "Texas Hold'em"} เล่นได้สูงสุด ${seatLimit(cmd.settings.game)} คน — ตอนนี้มี ${S.players.length} คน`);
        if (cmd.settings.appCards === false && S.players.some((p) => p.bot)) throw new Error('บอทเล่นได้เฉพาะโหมดแอปแจกไพ่ — ลบบอทออกก่อน');
        S.settings = Object.assign({}, old, cmd.settings);
        if (S.handNo > 0) S.settings.credit = !!old.credit; // can't switch buy-in style mid-game
        else if (S.settings.startStack !== old.startStack || !!S.settings.credit !== !!old.credit || S.settings.mode !== old.mode) E.resetStacks(S);
        if (S.settings.mode !== old.mode && S.handNo === 0) { S.level = 0; S.levelStart = null; S.pausedAt = null; }
        // cash clock: changing the length mid-game restarts the countdown from now
        if (S.settings.mode === 'cash' && (S.settings.sessionMin || 0) !== (old.sessionMin || 0)) {
          S.levelStart = S.handNo > 0 && S.settings.sessionMin > 0 ? t : null; S.pausedAt = null;
        }
        S.level = Math.min(S.level, S.settings.levels.length - 1);
        return;
      }
      default: throw new Error('คำสั่งไม่รู้จัก');
    }
  }

  // ---------- client ----------
  function startClient(c, hello) {
    role = 'client'; code = c;
    store.set('pk:name', myName);
    history.replaceState(null, '', location.pathname + '?room=' + code + (params.get('pid') ? '&pid=' + params.get('pid') : ''));
    hostLostAt = null; ui.roomNoted = false;
    rememberRoom(code, 'client', S);
    net = Net.client(code, myId, myName, Object.assign({ emoji: myEmoji }, hello), {
      onStatus(st) {
        netStatus = st;
        if (st === 'online') hostLostAt = null;
        else if (S && hostLostAt == null) hostLostAt = Date.now();
        render();
      },
      onMessage(msg) {
        if (msg.t === 'handoff') {
          net.send({ t: 'handoffAck' });
          toast('คุณเป็นเจ้ามือแล้ว 👑', true);
          // give the old host a moment to release the room id
          setTimeout(() => { net.destroy(); startHost(code, msg.s, msg.hist, false, msg.secrets); }, 1200);
        } else if (msg.t === 'state') {
          clockSkew = msg.now - Date.now();
          S = msg.s; online = new Set(msg.online); kicked = false; ui.hole = msg.hole || null;
          // fill in mode/players for the home screen's recent-rooms card once we know them
          if (!ui.roomNoted) { ui.roomNoted = true; rememberRoom(code, 'client', S); }
          render();
        } else if (msg.t === 'ping') {
          clockSkew = msg.now - Date.now();
        } else if (msg.t === 'err') {
          toast(msg.msg);
        } else if (msg.t === 'kicked') {
          kicked = true; render();
        } else if (msg.t === 'full') {
          kicked = 'full'; ui.fullMax = msg.max; net.destroy(); render(); // stop retrying until they tap again
        }
      },
    });
    render();
  }

  function send(cmd) {
    if (isHost()) return apply(cmd, myId);
    if (!net.send({ t: 'cmd', cmd })) toast('ยังเชื่อมต่อไม่ได้ ลองอีกครั้ง');
  }

  // ---------- derived ----------
  function actorId() {
    const h = S && S.hand;
    if (!h || h.done || !h.toAct) return null;
    if (h.toAct === myId) return myId;
    if (isHost() && ui.proxy) return h.toAct;
    return null;
  }

  // ---------- turn clock / auto next hand (host only) ----------
  // h.turnAt: when the player to act got the turn; h.doneAt: when the hand ended (host clock).
  function stampClock(reset) {
    const h = S && S.hand;
    if (!h) return;
    const t = Date.now();
    h.actions.forEach((a) => { if (!a.at) a.at = t; }); // when each action happened (host clock)
    const key = `${h.toAct}|${h.actions.length}|${h.street}`;
    if (!h.done && (reset || h.turnKey !== key)) { h.turnKey = key; h.turnAt = Date.now(); }
    if (h.done && (reset || !h.doneAt)) h.doneAt = Date.now();
  }
  // host time → this phone's clock, shown as 21:14:05
  const clockAt = (at) => (at ? new Date(at - clockSkew).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');
  const tmHtml = (at) => (at ? `<span class="tm">${clockAt(at)}</span>` : '');
  const turnEnds = (h) => (S.settings.actSec > 0 && h && !h.done && h.toAct && h.street !== 'showdown' && h.turnAt ? h.turnAt + S.settings.actSec * 1000 : null);
  const nextStarts = (h) => (S.settings.autoNext > 0 && h && h.done && h.doneAt && E.eligible(S).length >= 2 ? h.doneAt + S.settings.autoNext * 1000 : null);

  // Clock ticking for the player whose turn it is: once a second over the last 10 s, faster and higher in the last 3
  let tickedSec = null;
  setInterval(() => {
    const h = S && S.hand; const te = S && !isPD() && h && h.toAct === myId ? turnEnds(h) : null;
    if (!te) { tickedSec = null; return; }
    const sec = Math.ceil((te - Date.now()) / 1000);
    if (sec > 10 || sec < 1 || sec === tickedSec) return;
    tickedSec = sec;
    Sfx.play('tick', sec);
    try { if (sec <= 3 && navigator.vibrate) navigator.vibrate(40); } catch (e) { /* ignore */ }
  }, 200);

  let autoTried = null;
  setInterval(() => {
    if (!isHost() || !S || isPD() || handingOff) return;
    const h = S.hand; const t = Date.now();
    const te = turnEnds(h);
    if (te && t >= te && !(pById(h.toAct) || {}).bot) {
      const free = (h.bets[h.toAct] || 0) >= h.currentBet;
      return apply({ c: 'act', pid: h.toAct, type: free ? 'check' : 'fold', timeout: true }, myId);
    }
    if (awayTick(h, t)) return;
    const ns = nextStarts(h);
    if (ns && t >= ns && autoTried !== h.no) { autoTried = h.no; apply({ c: 'start' }, myId); }
  }, 500);

  // A player who closed the room, or whose phone has been unreachable for OFFLINE_S, is folded when
  // it's their turn and stood up once they're out of the hand, so the table never waits on them.
  // Someone who pressed stand mid-hand is stood up when the hand ends.
  const OFFLINE_S = 20;
  const offlineSince = {};
  function awayTick(h, t) {
    const live = h && !h.done;
    for (const p of S.players) {
      if (p.bot || p.left) { delete offlineSince[p.id]; continue; }
      if (online.has(p.id) || p.id === myId) delete offlineSince[p.id]; // the host is never "offline" to itself
      else if (!offlineSince[p.id]) offlineSince[p.id] = t;
      const dropped = offlineSince[p.id] && t - offlineSince[p.id] >= OFFLINE_S * 1000;
      const gone = p.leaving === 'gone' || dropped;
      if (!gone && p.leaving !== 'stand') continue;
      if (live && h.toAct === p.id && gone) { apply({ c: 'act', pid: p.id, type: 'fold', away: true }, myId); return true; }
      const inPlay = live && h.ids.includes(p.id) && !h.folded[p.id];
      if (!inPlay) { apply({ c: 'stand', pid: p.id, v: true, auto: gone ? (p.leaving === 'gone' ? 'left' : 'offline') : null }, myId); return true; }
    }
    return false;
  }

  // live countdowns: <span class="cd" data-until="…"> ticks without a full re-render
  const cdHtml = (until) => (until ? `<span class="cd" data-until="${until}">${Math.max(0, Math.ceil((until - now()) / 1000))}</span>` : '');
  setInterval(() => {
    document.querySelectorAll('.cd').forEach((el) => {
      const s = Math.max(0, Math.ceil((Number(el.dataset.until) - now()) / 1000));
      if (el.textContent !== String(s)) el.textContent = s;
      el.classList.toggle('urgent', s <= 5);
    });
  }, 250);

  // ---------- bots (host only) ----------
  let botTimer = null;
  let botHold = 0; // after an undo, bots wait so the host can keep stepping back

  function botTick() {
    if (!isHost() || botTimer || !S || isPD()) return;
    const h = S.hand;
    if (!h || h.done || !h.toAct || !(pById(h.toAct) || {}).bot) return;
    const id = h.toAct; const key = `${h.no}|${h.actions.length}`;
    botTimer = setTimeout(() => {
      botTimer = null;
      const h2 = S && S.hand;
      if (!isHost() || !h2 || h2.done || h2.toAct !== id || `${h2.no}|${h2.actions.length}` !== key || Date.now() < botHold) return botTick();
      apply(botMove(id), myId);
    }, Math.max(0, botHold - Date.now()) + 700 + Math.random() * 900);
  }

  // Plays by its chance to win (simulated against the live hands) versus the price of calling,
  // with a little randomness so it bluffs and slow-plays now and then.
  function botMove(id) {
    const h = S.hand; const a = actorInfo(id);
    const d = secrets[h.no]; const cards = d && d.hole[id];
    const opps = h.ids.filter((x) => x !== id && !h.folded[x]).length;
    const eq = cards ? Cards.equity(cards, h.board || [], opps, h.game, 300) : 0.4;
    const r = Math.random();
    const raise = (f) => {
      const to = Math.max(a.minTo, Math.min(a.maxTo, Math.round(h.currentBet + (a.pot + a.toCall) * f)));
      return to >= a.maxTo ? { type: 'allin' } : { type: 'raise', amount: to };
    };
    let m;
    if (a.toCall === 0) {
      if (a.canRaise && eq > 0.62 && r < 0.75) m = raise(0.5 + Math.random() * 0.4);
      else if (a.canRaise && ((eq > 0.45 && r < 0.2) || r < 0.06)) m = raise(0.4);
      else m = { type: 'check' };
    } else {
      const odds = a.toCall / (a.pot + a.toCall);
      if (a.canRaise && eq > 0.72 && r < 0.55) m = raise(0.75);
      else if (eq >= odds + 0.03 || (a.toCall <= h.bb && eq > 0.25) || r < 0.07) m = { type: 'call' };
      else m = { type: 'fold' };
    }
    return Object.assign({ c: 'act', pid: id }, m);
  }

  function actorInfo(id) {
    const h = S.hand; const p = pById(id);
    const bet = h.bets[id] || 0;
    const toCall = Math.max(0, h.currentBet - bet);
    const allTo = bet + p.stack;
    const maxTo = E.raiseCap(S, id);
    const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
    const canRaise = maxTo > h.currentBet && !h.noRaise[id] && p.stack > toCall;
    const pot = E.potTotal(h);
    return { p, bet, toCall, maxTo, minTo, canRaise, pot, isBet: h.currentBet === 0, plo: E.isPotLimit(S), capped: maxTo < allTo };
  }

  // ---------- render ----------
  function render() {
    if (!role) return renderHome();
    if (kicked) return renderKicked();
    if (!S) return renderConnecting();
    const h = S.hand;
    if (ui.sdHand !== (h && h.no) || (h && h.pots && (!ui.sd || ui.sd.length !== h.pots.length))) {
      ui.sdHand = h && h.no; ui.sd = h && h.pots ? h.pots.map((pot) => pot.elig.length === 1 ? [pot.elig[0]] : []) : null;
    }
    const actor = actorId();
    if (!actor) ui.raiseOpen = false;
    const myTurn = !!(h && !h.done && h.toAct === myId);
    if (myTurn && !ui.wasMyTurn) {
      const pre = preAction(h);
      if (pre) { ui.pre = null; setTimeout(() => send({ c: 'act', pid: myId, type: pre, seq: S.seq || 0 }), 150); }
      else { try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch (e) { /* ignore */ } }
    }
    ui.wasMyTurn = myTurn;
    Sfx.update(S, myId);

    const scrollY = window.scrollY;
    // a state broadcast can arrive while the player is typing a bet; keep their input
    ui.typingRaise = document.activeElement && document.activeElement.id === 'raiseInput';
    const typingPd = document.activeElement && document.activeElement.id === 'pdBetInput';
    // The table re-renders on every move (and bots move every second or two). An open settings form
    // is kept as it is, or the host's half-made choices would be wiped; other sheets keep their scroll.
    const oldBg = document.querySelector('.sheet-bg');
    const sameSheet = oldBg && oldBg.dataset.sheet === ui.sheet;
    const keepForm = sameSheet && ui.sheet === 'settings';
    const sheetScroll = sameSheet ? oldBg.firstElementChild.scrollTop : 0;
    const focusId = keepForm && document.activeElement && oldBg.contains(document.activeElement) ? document.activeElement.id : null;
    $app.innerHTML = topBar() + `<div class="wrap">${hostLostBanner()}${S.handNo === 0 && !h ? lobby() : isPD() ? pdTable() : table()}</div>` + (isPD() ? pdBottom() : bottomBar(actor)) + (keepForm ? '' : sheet());
    if (keepForm) {
      $app.appendChild(oldBg);
      const f = focusId && document.getElementById(focusId);
      if (f) f.focus();
    } else if (sheetScroll) {
      const sh = document.querySelector('.sheet-bg .sheet');
      if (sh) sh.scrollTop = sheetScroll;
    }
    runNames();
    botTick();
    fitTable();
    winFly();
    window.scrollTo(0, scrollY);
    const ri = ui.typingRaise && document.getElementById('raiseInput');
    if (ri) { ri.focus(); syncRaise(true); }
    const pi = typingPd && document.getElementById('pdBetInput');
    if (pi) { pi.focus(); const n = pi.value.length; try { pi.setSelectionRange(n, n); } catch (e) { /* number inputs */ } }
    ui.typingRaise = false;
    updateTimer();
  }

  function renderHome() {
    const roomParam = (params.get('room') || '').toUpperCase();
    const resume = roomParam && store.get(hostKey(roomParam), null) ? roomParam : null;
    $app.innerHTML = `<div class="wrap">
      <svg class="chip-logo" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="#c0392b"/><circle cx="50" cy="50" r="30" fill="none" stroke="#fff" stroke-width="8" stroke-dasharray="12 10"/><circle cx="50" cy="50" r="18" fill="#c0392b" stroke="#fff" stroke-width="2"/></svg>
      <h1>Kapoke Chip</h1>
      <div class="ver">${APP_VER}</div>
      <p class="center muted">ไพ่จริงบนโต๊ะ · ชิปบนมือถือ</p>
      <div class="card">
        <label>ชื่อของคุณ</label>
        <div class="row namerow"><input id="name" maxlength="${NAME_MAX}" value="${esc(myName)}" placeholder="เช่น โจโจ้" autocomplete="nickname">
          <button class="dice" data-a="randName" title="สุ่มชื่อ" aria-label="สุ่มชื่อ">🎲</button></div>
        <label>รูปแทนตัว <span class="small">(ไม่เลือก = ใช้ตัวแรกของชื่อ)</span></label>
        ${emojiPicker()}
      </div>
      ${resume ? `<button class="primary" style="width:100%" data-a="resume" data-code="${esc(resume)}">กลับเข้าห้องเดิม ${esc(resume)} (เจ้ามือ)</button>` : ''}
      ${recentRooms()}
      <div class="card">
        <h2>เข้าห้องของเพื่อน</h2>
        <div class="row"><input id="code" maxlength="5" placeholder="รหัสห้อง" value="${esc(roomParam)}" style="text-transform:uppercase;letter-spacing:3px;font-weight:700">
        <button class="${roomParam && !resume ? 'primary' : 'blue'}" data-a="join" style="flex:none">เข้าห้อง</button></div>
      </div>
      <div class="card">
        <h2>สร้างห้องใหม่</h2>
        <p class="muted small" style="margin:0 0 10px">มือถือเครื่องนี้จะเป็นเจ้ามือ (ต้องเปิดแอปค้างไว้ตลอดเกม)</p>
        <div class="seg" id="mode"><button class="on" data-a="mode" data-v="cash">Cash game</button><button data-a="mode" data-v="tournament">Tournament</button><button data-a="mode" data-v="pokdeng">ป๊อกเด้ง</button></div>
        <label class="check"><input type="checkbox" id="plays" checked> ฉันร่วมเล่นด้วย</label>
        <button class="${resume || roomParam ? '' : 'primary'}" style="width:100%;margin-top:8px" data-a="create">สร้างห้อง</button>
      </div>
    </div>`;
  }

  function emojiPicker() {
    const custom = myEmoji && !EMOJIS.includes(myEmoji) ? myEmoji : '';
    return `<div class="emojis">${EMOJIS.map((e) => `<button class="${myEmoji === e ? 'on' : ''}" data-a="pickEmoji" data-v="${e}">${e}</button>`).join('')}
      <input id="emojiIn" value="${esc(custom)}" placeholder="อื่นๆ" aria-label="พิมพ์อีโมจิเอง" class="${custom ? 'on' : ''}">
      <button class="none ${myEmoji ? '' : 'on'}" data-a="pickEmoji" data-v="">ไม่ใช้</button></div>`;
  }
  function setEmoji(v) {
    myEmoji = cleanEmoji(v);
    store.set('pk:emoji', myEmoji);
    document.querySelectorAll('.emojis [data-a=pickEmoji]').forEach((b) => b.classList.toggle('on', b.dataset.v === myEmoji));
    if (role && S && pById(myId)) send({ c: 'avatar', pid: myId, emoji: myEmoji });
  }
  const avatarOf = (p) => esc(p.emoji || Array.from(p.name.trim())[0] || '?');

  function recentRooms() {
    const rooms = store.get(ROOMS_KEY, []);
    if (!rooms.length) return '';
    const ago = (t) => {
      const m = Math.floor((Date.now() - t) / 60000);
      return m < 1 ? 'เมื่อกี้' : m < 60 ? `${m} นาทีก่อน` : m < 1440 ? `${Math.floor(m / 60)} ชม.ก่อน` : `${Math.floor(m / 1440)} วันก่อน`;
    };
    const rows = rooms.map((r) => {
      const mine = r.role === 'host' && store.get(hostKey(r.code), null);
      const meta = [mine ? '👑 เจ้ามือ' : 'ผู้เล่น', r.mode === 'tournament' ? 'Tournament' : r.mode === 'cash' ? 'Cash' : '',
        r.players ? `${r.players} คน` : '', r.handNo ? `มือที่ ${r.handNo}` : '', ago(r.at)].filter(Boolean).join(' · ');
      return `<div class="room" data-code="${esc(r.code)}">
        <div class="rinfo"><b>${esc(r.code)}</b> <span class="rstat" data-st="${esc(r.code)}">${mine ? '' : '<span class="dot"></span> กำลังเช็ก…'}</span><div class="muted small">${meta}</div></div>
        <button class="${mine ? 'primary' : 'blue'} sm" data-a="${mine ? 'resume' : 'joinRoom'}" data-code="${esc(r.code)}">${mine ? 'เปิดต่อ' : 'เข้า'}</button>
        <button class="sm ghost" data-a="forgetRoom" data-code="${esc(r.code)}" aria-label="ลบออกจากรายการ">✕</button>
      </div>`;
    }).join('');
    setTimeout(checkRooms, 0);
    return `<div class="card"><h2>ห้องล่าสุด</h2>${rows}
      <p class="muted small" style="margin:8px 0 0">ห้องที่คุณเป็นเจ้ามือ กด "เปิดต่อ" แล้วเล่นต่อจากเดิมได้เลย (ระหว่างที่ปิดแอป คนอื่นจะเข้าห้องไม่ได้)</p></div>`;
  }

  // Ask the signalling server whether each joined room's host is up right now.
  let roomsChecked = false;
  function checkRooms() {
    if (roomsChecked) return;
    roomsChecked = true;
    document.querySelectorAll('.rstat[data-st]').forEach((el) => {
      if (!el.innerHTML) return;
      Net.probe(el.dataset.st).then((alive) => {
        const cur = document.querySelector(`.rstat[data-st="${el.dataset.st}"]`);
        if (cur) cur.innerHTML = alive ? '<span class="dot on"></span> เปิดอยู่' : '<span class="dot off"></span> ไม่พบเจ้ามือ';
      });
    });
  }

  function renderKicked() {
    if (kicked === 'full') {
      $app.innerHTML = `<div class="wrap"><div class="card center"><h2>ห้องเต็มแล้ว</h2>
        <p class="muted">ห้องนี้รับได้สูงสุด ${ui.fullMax || ''} คน ตามจำนวนไพ่ในสำรับ · ถ้ามีคนออก กดลองใหม่ได้</p>
        <button class="primary" data-a="rejoin">ลองเข้าอีกครั้ง</button></div></div>`;
      return;
    }
    $app.innerHTML = `<div class="wrap"><div class="card center"><h2>คุณถูกนำออกจากโต๊ะ</h2>
      <p class="muted">ถ้าเป็นการกดผิด กดปุ่มด้านล่างเพื่อขอกลับเข้าห้อง</p>
      <button class="primary" data-a="rejoin">กลับเข้าห้อง</button></div></div>`;
  }

  function renderConnecting() {
    const msg = { 'no-host': 'ยังไม่พบห้องนี้ — เช็กรหัส หรือรอเจ้ามือเปิดแอป', reconnecting: 'กำลังเชื่อมต่อใหม่…', unsupported: 'เบราว์เซอร์นี้ใช้ไม่ได้ — ลองเปิดด้วย Chrome หรือ Safari' }[netStatus] || 'กำลังเชื่อมต่อห้อง…';
    $app.innerHTML = `<div class="wrap"><div class="card center"><div class="bigcode">${esc(code)}</div><p>${msg}</p>
      <button class="ghost" data-a="leave">ยกเลิก</button></div></div>`;
  }

  function statusDot() {
    const ok = netStatus === 'online';
    const title = { online: 'เชื่อมต่อแล้ว', claiming: 'กำลังเปิดห้อง…', reconnecting: 'กำลังเชื่อมต่อใหม่…', connecting: 'กำลังเชื่อมต่อ…', 'no-host': 'ไม่พบเจ้ามือ', unsupported: 'เบราว์เซอร์ไม่รองรับ' }[netStatus] || netStatus;
    return `<span class="dot ${ok ? 'on' : 'off'}" title="${title}"></span>${ok ? '' : `<span class="small muted">${title}</span>`}`;
  }

  function topBar() {
    const b = E.blinds(S);
    const tour = S.settings.mode === 'tournament';
    return `<div class="topbar"><div class="in">
      ${statusDot()}
      <span class="code" data-a="sheet" data-v="invite">${esc(code)}</span>
      <span class="blinds">${isPD() ? `ป๊อกเด้ง${S.pd ? ` · รอบ ${S.pd.round.no}` : ''}` : `${tour ? `Lv${S.level + 1} · ` : ''}${fmt(b.sb)}/${fmt(b.bb)}${b.ante ? ` · ante ${fmt(b.ante)}` : ''}`}</span>
      ${tour || S.settings.sessionMin > 0 ? `<span class="timer ${S.pausedAt != null ? 'paused' : ''}" id="timer"></span>` : ''}
      <span class="spacer"></span>
      ${isHost() ? `<button class="sm" data-a="sheet" data-v="menu">☰ ${hostWord()}</button>` : `<button class="sm ghost" data-a="sheet" data-v="menu">☰</button>`}
    </div></div>`;
  }

  function lobby() {
    const list = S.players.map((p, i) => `<div class="pl"><span class="muted">${i + 1}</span><div class="nm"><b>${nameHtml(p.name)}${p.id === myId ? ' <span class="me-tag">(คุณ)</span>' : ''}</b></div>
      <span class="dot ${isOnline(p.id) ? 'on' : ''}"></span><div class="stack">${isPD() ? (S.pd && S.pd.bankerId === p.id ? '🏦' : '') : credit() ? '' : fmt(p.stack)}</div></div>`).join('');
    return `<div class="card center">
      <div class="muted small">สแกนเพื่อเข้าห้อง</div>
      <div class="qr">${qrSvg(joinUrl())}</div>
      <div class="bigcode">${esc(code)}</div>
      <div class="link">${esc(joinUrl())}</div>
    </div>
    <div class="card">
      <h2>ผู้เล่น (${S.players.length}/${seatLimit()}) · ${isPD() ? 'ป๊อกเด้ง' : `${S.settings.mode === 'cash' ? 'Cash game' : 'Tournament'} · ${GAME_TAG[S.settings.game] ? GAME_TAG[S.settings.game] + ' · ' : ''}${credit() ? 'ไม่ต้อง buy-in (ยอด +/-)' : `ชิปเริ่ม ${fmt(S.settings.startStack)}`}${S.settings.appCards ? ' · 📱 แอปแจกไพ่' : ''}`}</h2>
      <div class="players">${list || '<p class="muted">ยังไม่มีผู้เล่น</p>'}</div>
      ${isHost() ? `<p class="muted small">${isPD() ? 'คนแรกในรายการเป็นเจ้ามือป๊อกเด้ง (🏦) เปลี่ยนได้ทีหลัง' : 'เรียงที่นั่งได้ที่ ☰ เจ้ามือ → ผู้เล่น (ลำดับ = เวียนตามเข็มนาฬิกา)'}</p>
        ${isPD() ? '' : '<button class="ghost" style="width:100%;margin-bottom:8px" data-a="cmd" data-c="addBot">🤖 เพิ่มบอท (เล่นคนเดียว / ทดสอบ)</button>'}
        <div class="grid2"><button data-a="sheet" data-v="settings">ตั้งค่า</button><button class="primary" data-a="cmd" data-c="start" ${S.players.length < 2 ? 'disabled' : ''}>เริ่มเกม</button></div>`
        : `<p class="muted center">รอ${hostWord()}เริ่มเกม…</p>`}
    </div>`;
  }

  function isOnline(id) {
    if ((pById(id) || {}).bot) return true;
    if (isHost()) return id === myId || online.has(id);
    return netStatus === 'online' && (id === myId || id === S.hostId || online.has(id));
  }

  // Automatic takeover: every phone holds the latest state, so another phone can carry on as host.
  // Phones take turns in seat order (people at the table first) so two don't race for the room:
  // the first after AUTO_FIRST_S, the next AUTO_STEP_S later if the first is gone too, and so on.
  const AUTO_FIRST_S = 12, AUTO_STEP_S = 8;
  function takeoverOrder() {
    const cands = S.players.filter((p) => p.id !== S.hostId && !p.bot && online.has(p.id));
    return cands.filter((p) => !p.left).concat(cands.filter((p) => p.left));
  }
  function myTakeoverAt() {
    const order = takeoverOrder();
    const i = order.findIndex((p) => p.id === myId);
    return AUTO_FIRST_S + (i < 0 ? order.length : i) * AUTO_STEP_S;
  }

  function hostLostBanner() {
    if (isHost() || hostLostAt == null) return '';
    const secs = Math.floor((Date.now() - hostLostAt) / 1000);
    const hw = hostWord();
    const hostName = (pById(S.hostId) || {}).name || hw;
    const left = Math.max(0, myTakeoverAt() - secs);
    const next = takeoverOrder().find((p) => AUTO_FIRST_S + takeoverOrder().indexOf(p) * AUTO_STEP_S > secs);
    const who = next && next.id !== myId ? `<b>${esc(next.name)}</b> จะรับเป็น${hw}แทนอัตโนมัติ` : `เครื่องคุณจะรับเป็น${hw}แทนอัตโนมัติใน ${left} วิ`;
    const body = `<span>⚠️ ติดต่อ${hw} (${esc(hostName)}) ไม่ได้ ${secs} วิ · ${who}</span>
      <button class="primary sm" style="flex:none" data-a="takeover">👑 รับแทนเลย</button>`;
    return `<div class="banner row hostlost">${body}</div>`;
  }
  setInterval(() => {
    if (role !== 'client' || hostLostAt == null || !S) return;
    const secs = (Date.now() - hostLostAt) / 1000;
    // a phone in the background (locked, another app open) would make a poor host: let the next one take it
    if (secs >= myTakeoverAt() && document.visibilityState === 'visible' && !kicked) return takeOver(true);
    render();
  }, 1000);

  function takeOver(auto) {
    const was = (pById(S.hostId) || {}).name || hostWord();
    S.hostId = myId;
    S.log.push(`👑 ${myName} รับเป็นเจ้ามือแทน (${was} หลุด${auto ? ' · อัตโนมัติ' : ''})`);
    // the app-dealt deck left with the old host: re-dealing mid-hand would change cards already seen
    if (S.hand && !S.hand.done && S.hand.appCards) E.voidHand(S, 'สำรับไพ่อยู่ในเครื่องเจ้ามือเดิม');
    net.destroy();
    startHost(code, S, [], true);
    toast(auto ? `${was} หลุด — เครื่องคุณเป็นเจ้ามือแทนแล้ว (เปิดแอปค้างไว้นะ)` : 'คุณเป็นเจ้ามือแล้ว', true);
  }

  function table() {
    const h = S.hand;
    hl = highlightFor(h);
    const pot = h && !h.done ? E.potTotal(h) : 0;
    let potHtml;
    if (!h) potHtml = `<div class="lbl">พร้อมเริ่มมือแรก</div>`;
    else if (h.done) {
      const total = Object.values(h.result || {}).reduce((a, b) => a + b, 0);
      potHtml = `<div class="lbl">มือที่ ${h.no} จบแล้ว</div><div class="amt">${fmt(total)}</div>
        <div class="hint">${h.voided ? 'ยกเลิกมือนี้ — คืนชิปทุกคนแล้ว' : ''}${Object.entries(h.result || {}).map(([id, a]) => `${esc((pById(id) || {}).name)} ได้ ${fmt(a)}`).join(' · ')}</div>`;
    } else {
      const hint = h.appCards ? '' : h.street === 'showdown' ? (h.runout ? 'เปิดไพ่กลางให้ครบ 5 ใบ แล้วหงายไพ่' : 'หงายไพ่ — เจ้ามือเลือกผู้ชนะ')
        : { flop: 'ดีลเลอร์เปิด Flop 3 ใบ', turn: 'ดีลเลอร์เปิด Turn', river: 'ดีลเลอร์เปิด River', preflop: h.game === 'short' ? 'แจกไพ่คนละ 2 ใบ (เอาไพ่ 2–5 ออก เหลือ 36 ใบ)' : `แจกไพ่คนละ ${h.game === 'plo' ? 4 : 2} ใบ` }[h.street];
      const side = h.pots && h.pots.length > 1 ? `<div class="sidepots">${h.pots.map((p, i) => `${i ? 'Side ' + i : 'Main'} ${fmt(p.amount)}`).join(' · ')}</div>` : '';
      potHtml = `<div class="lbl">Pot · มือที่ ${h.no}</div><div class="amt">${fmt(pot)}</div>${side}
        <span class="street">${E.streetName(h.street)}${GAME_TAG[h.game] ? ' · ' + GAME_TAG[h.game] : ''}</span>${hint ? `<div class="hint">${hint}</div>` : ''}`;
    }
    if (h && h.appCards) potHtml += boardHtml(h.board || []);
    const lastLog = S.log.slice(-2).map(esc).join('<br>');
    const me = pById(myId);
    const away = S.players.filter((p) => p.left);
    const standBanner = me && me.left && !me.watching ? `<div class="banner row"><span>คุณลุกจากโต๊ะแล้ว · ${chipWord()} ${chips(me)}</span>
      <button class="primary sm" style="flex:none" data-a="cmd" data-c="stand" data-pid="${esc(myId)}" data-v="">นั่งกลับ</button></div>` : '';
    const timeUp = ui.timeUp ? `<div class="banner row"><span>⏰ หมดเวลาเล่นแล้ว — เล่นมือนี้ให้จบแล้วดูว่าใครโอนให้ใคร</span>
      <button class="primary sm" style="flex:none" data-a="sheet" data-v="summary">💸 สรุป</button></div>` : '';
    const feed = h ? `<div class="card feed" data-a="sheet" data-v="hands"><div class="muted small">มือที่ ${h.no} · ทุก action ในมือนี้</div>${actionLines(h, (id) => esc((pById(id) || {}).name || '?'))}</div>` : '';
    const watchers = away.filter((p) => p.watching); const stood = away.filter((p) => !p.watching);
    const awayHtml = (stood.length ? `<div class="away"><span>ลุกแล้ว:</span> ${stood.map((p) => `${esc(p.name)} <b>${chips(p)}</b>`).join(' · ')}</div>` : '')
      + (watchers.length ? `<div class="away"><span>👀 ดูอยู่:</span> ${watchers.map((p) => esc(p.name)).join(' · ')}</div>` : '');
    if (ui.view === 'table') {
      return `${timeUp}${standBanner}${feltTable(potHtml)}${awayHtml}
        ${h && h.street === 'showdown' && !h.done ? showdown() : ''}`;
    }
    return `${timeUp}${standBanner}<p class="center small viewsw"><u data-a="view" data-v="table">🃏 เปลี่ยนเป็นมุมมองโต๊ะ</u></p><div class="card pot">${potHtml}</div>${myCardsPanel()}${hostTools()}
      <div class="players">${S.players.filter((p) => !p.left).map(playerRow).join('')}</div>
      ${awayHtml}
      ${h && h.street === 'showdown' && !h.done ? showdown() : ''}
      ${feed}
      <div class="lastlog" data-a="sheet" data-v="hands">${h && !h.done ? '' : `${lastLog}<br>`}<u>ประวัติรายมือ</u></div>
      <p class="center small"><u data-a="sheet" data-v="ranks">🏆 อันดับไพ่ (มือไหนชนะ)</u></p>`;
  }

  // The host menu items used every few hands, one tap from the table.
  function hostTools() {
    if (!isHost()) return '';
    const tour = S.settings.mode === 'tournament';
    const clock = tour || S.settings.sessionMin > 0;
    const paused = S.pausedAt != null;
    const pause = `<button data-a="cmd" data-c="pause" data-v="${paused ? '' : '1'}" ${S.levelStart == null ? 'disabled' : ''}>${paused ? '▶️<span>เดินเวลา</span>' : '⏸️<span>หยุดเวลา</span>'}</button>`;
    return `<div class="hosttools" style="grid-template-columns:repeat(${clock && !tour ? 5 : 4},1fr)">
      <button data-a="cmd" data-c="undo" title="Undo" ${hist.length ? '' : 'disabled'}>↩️<span>Undo</span></button>
      <button data-a="sheet" data-v="players" title="ผู้เล่น/ชิป">👥<span>ผู้เล่น/ชิป</span></button>
      ${tour ? pause : `<button data-a="sheet" data-v="settings">⚙️<span>Blinds</span></button>${clock ? pause : ''}`}
      <button data-a="sheet" data-v="summary">📊<span>สรุป</span></button>
    </div>`;
  }

  // Names too long for their row scroll round like a ticker (the name twice, moved left by one
  // copy). The timing follows the clock, so a re-render picks the motion up where it was.
  const nameHtml = (name) => `<span class="nmtxt"><span>${esc(name)}</span></span>`;
  function runNames() {
    document.querySelectorAll('.nmtxt').forEach((box) => {
      const inner = box.firstChild;
      if (inner.scrollWidth - box.clientWidth <= 2) return;
      const name = inner.textContent;
      inner.innerHTML = `<i>${esc(name)}</i><i>${esc(name)}</i>`;
      const step = inner.firstChild.getBoundingClientRect().width;
      const ms = Math.round(step * 40); // ~25 px a second
      box.classList.add('run');
      box.style.setProperty('--dist', `${step}px`);
      box.style.setProperty('--dur', `${ms}ms`);
      inner.style.animationDelay = `${-(Date.now() % ms)}ms`;
    });
  }

  // Players around a felt like a real table, me at the bottom; pot, board and menus in the middle.
  // The box is sized to the phone so the table, my cards and the action bar fit on one screen.
  function tableBox() {
    const W = Math.min(window.innerWidth, 560) - 24;
    // where the table starts: below the top bar and any banner (stood up, host lost, time up)
    const top = ui.tableTop || (document.querySelector('.topbar') || { offsetHeight: 52 }).offsetHeight + 16;
    const H = Math.round(Math.max(340, Math.min(window.innerHeight - top - (ui.actbarH || 150) - 10, W * 1.9)));
    return { W, H };
  }

  // The seat track follows the table's octagon (corners cut by c), so seats either side of a corner
  // keep their spacing. trackPoint walks distance d from bottom centre, clockwise.
  function trackPath(x0, y0, x1, y1, c) {
    const cx = (x0 + x1) / 2;
    return [[cx, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c], [x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c], [x1 - c, y1], [cx, y1]];
  }
  const trackLength = (pts) => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  function trackPoint(d, pts) {
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]; const [bx, by] = pts[i];
      const len = Math.hypot(bx - ax, by - ay);
      if (d <= len) return [ax + ((bx - ax) * d) / (len || 1), ay + ((by - ay) * d) / (len || 1)];
      d -= len;
    }
    return pts[0];
  }

  function feltTable(potHtml) {
    const h = S.hand;
    const { W, H } = tableBox();
    // short screens (small phones, Safari bars showing) shrink the seats, cards and middle a little
    const k = Math.max(0.72, Math.min(1, (H - 60) / 470));
    const seated = S.players.filter((p) => !p.left);
    const mine = seated.findIndex((p) => p.id === myId);
    const order = mine > 0 ? seated.slice(mine).concat(seated.slice(0, mine)) : seated;
    const n = order.length;
    // seat centres run along the rail
    const x0 = 42 * k, x1 = W - 42 * k, y0 = 56 * k, y1 = H - 52 * k;
    const path = trackPath(x0, y0, x1, y1, 40 * k);
    const per = trackLength(path);
    // a crowded table (more than 12) drops the status line, keeps bets inside the seats and
    // shrinks seats to fit the gap between them
    const dense = n > 12;
    const ks = Math.max(0.5, Math.min(k, (per / Math.max(n, 1)) / (dense ? 118 : 104)));
    const pct = (x, y) => `left:${(x / W * 100).toFixed(2)}%;top:${(y / H * 100).toFixed(2)}%`;
    const cx = W / 2; const cy = H / 2;
    const seats = order.map((p, i) => {
      const [x, y] = trackPoint((i * per) / n, path);
      const s = seatInfo(p);
      const shown = h && h.shown && h.shown[p.id] && p.id !== myId ? h.shown[p.id] : null;
      // bet chips sit between the seat and the middle, clear of the seat's labels
      const vx = cx - x; const vy = cy - y; const len = Math.hypot(vx, vy) || 1;
      const side = Math.abs(vx / len) > 0.7 || n > 8; // crowded: every bet stays inside its seat
      const reach = (vy > 0 ? 58 : 64) * ks; // top seats: just below their labels, clear of the pot
      // side seats share their height with the middle of the table, so their bet stays in the seat;
      // top and bottom seats put it toward the middle
      // straight up/down from the seat, just past its labels, never diagonally into the middle
      const bet = s.betAmt && p.id !== myId && !side ? `<span class="tbet" style="${pct(x, y + Math.sign(vy) * reach)}">${fmt(s.betAmt)}</span>` : '';
      const seatBet = s.betAmt && p.id !== myId && side ? `<div><span class="tbet inline">${fmt(s.betAmt)}</span></div>` : '';
      return `<div class="seat ${s.cls}${p.id === myId ? ' me' : ''}" data-pid="${esc(p.id)}" style="${pct(x, y)}">
          <div class="av${p.emoji ? ' emo' : ''}">${avatarOf(p)}<span class="dot ${isOnline(p.id) ? 'on' : 'off'}"></span></div>
          <div class="snm">${p.id === S.hostId ? '<i class="crown">👑</i>' : ''}${nameHtml(p.name)}${s.badges.length ? `<span class="sbadges">${s.badges.join('')}</span>` : ''}</div>
          <div class="sstk ${credit() ? toneOf(balance(p)) : ''}">${chips(p)}${s.wonAmt ? ` <span class="won">+${fmt(s.wonAmt)}</span>` : ''}</div>
          ${seatBet}${shown ? '' : `<div class="sst">${esc(s.status)}${s.clock}</div>`}
          ${shown ? `<div class="sshown${y < cy ? ' inl' : ''}">${cardsHtml(shown.cards, 'sm', `s${h.no}${p.id}`)}${shown.hand ? `<div>${esc(shown.hand)}</div>` : ''}</div>` : ''}
        </div>${bet}`;
    }).join('');
    const meSeat = mine >= 0 ? trackPoint(0, path) : null;
    const meP = mine >= 0 ? seatInfo(seated[mine]) : null;
    return `<div class="ptable${dense ? ' dense' : ''}" style="height:${H}px;--k:${k.toFixed(3)};--ks:${ks.toFixed(3)}"><div class="rail"></div><div class="felt"></div>
      <div class="tcenter"><div class="pot">${potHtml}</div>
        <div class="tlinks">${isHost() ? `<button data-a="cmd" data-c="undo" title="Undo" ${hist.length ? '' : 'disabled'}>↩️</button><button data-a="sheet" data-v="players" title="ผู้เล่น/ชิป">👥</button><button data-a="sheet" data-v="settings" title="ตั้งค่า">⚙️</button><button data-a="sheet" data-v="summary" title="สรุป">📊</button><button data-a="sheet" data-v="ranks" title="อันดับไพ่">🏆</button>`
          : '<button data-a="sheet" data-v="summary" title="สรุป">📊</button><button data-a="sheet" data-v="ranks" title="อันดับไพ่">🏆</button><button data-a="sheet" data-v="hands" title="ประวัติรายมือ">📜</button>'}</div>
        ${tableLog(h, H > 620 ? 5 : H > 560 ? 4 : H > 480 ? 3 : 2)}
      </div>${seats}${meSeat ? myCardsAtSeat(meSeat[0] / W * 100, (meSeat[1] - 80 * k) / H * 100, meP.betAmt) : ''}</div>`;
  }

  // The latest actions of this hand, newest on top and older ones fading out; tap for the whole hand.
  function tableLog(h, max) {
    if (!h) return '';
    const nm = (id) => esc((pById(id) || {}).name || '?');
    const lines = [];
    let st = null;
    h.actions.forEach((a) => {
      if (a.st !== st) { if (st) lines.push(`<i>— ${E.streetName(a.st)} —</i>`); st = a.st; }
      lines.push(`${tmHtml(a.at)}${a.id ? `<b>${nm(a.id)}</b> ` : ''}${esc(a.t)}`);
    });
    if (h.done && !h.voided) Object.entries(h.result || {}).forEach(([id, amt]) => lines.push(`${tmHtml(h.doneAt)}🏆 <b>${nm(id)}</b> ได้ ${fmt(amt)}`));
    const recent = lines.slice(-max).reverse();
    const fade = [1, 0.62, 0.42, 0.28, 0.18];
    return `<div class="tlog" data-a="sheet" data-v="hands">${recent.map((l, i) => `<div style="opacity:${fade[i] || 0.15}">${l}</div>`).join('')}
</div>`;
  }

  // My hole cards in front of my seat, with what I hold, my chance to win and my bet.
  // After folding, the hand you'd have held so far (for the regret): empty until the flop
  function regretHand(h, cards) {
    if (!h.folded[myId] || !cards || !h.board || h.board.length < 3) return null;
    const b = Cards.bestFor(cards, h.board, h.game);
    return b ? b.name : null;
  }
  function myCardsAtSeat(xPct, yPct, myBet) {
    const h = S.hand; const cards = myHole();
    const bet = myBet ? `<span class="tbet inline">${fmt(myBet)}</span>` : '';
    if (!h || !cards) return bet ? `<div class="tmycards" style="left:${xPct.toFixed(2)}%;top:${(yPct + 6).toFixed(2)}%">${bet}</div>` : '';
    const folded = h.folded[myId];
    const made = !folded && h.board && h.board.length >= 3 ? Cards.bestFor(cards, h.board, h.game) : null;
    const eq = folded || h.done || h.street === 'showdown' ? null : winChance(h, cards);
    const shownMine = h.shown && h.shown[myId];
    const regret = regretHand(h, cards);
    const info = [folded ? `Fold แล้ว${regret ? ` · 😢 <b class="gold">${regret}</b>` : ''}` : made ? `<b class="gold">${made.name}</b>` : '', eq == null ? '' : `ชนะ <b class="gold">${eq === undefined ? '…' : Math.round(eq * 100) + '%'}</b>`].filter(Boolean).join(' · ');
    const showBtn = h.done && !shownMine ? `<button class="sm" data-a="cmd" data-c="show" data-pid="${esc(myId)}">🃏 โชว์ไพ่</button>` : '';
    const cardRow = ui.holeHidden ? cards.map(() => cardHtml(null)).join('') : cards.map((c, i) => cardHtml(c, '', `m${h.no}`, i)).join('');
    return `<div class="tmycards ${folded ? 'fold' : ''}${regret ? ' regret' : ''}${cards.length > 2 ? ' four' : ''}" style="left:${xPct.toFixed(2)}%;top:${yPct.toFixed(2)}%">
      ${info || showBtn || bet ? `<div class="tinfo">${bet}${info}${showBtn}</div>` : ''}
      <div class="pcs" data-a="holeHide" title="แตะเพื่อซ่อน/ดู">${cardRow}</div></div>`;
  }

  // When a hand ends, chips fly from the pot to each winner, clicking as they land, and the amount
  // pops up over the winner. The flying chips live outside #app so re-renders don't cut them off.
  let flown = null;
  let watched = null; // only hands this phone saw being played, not one already over when it opened
  function winFly() {
    const h = S && S.hand;
    if (h && !h.done) watched = h.no;
    if (!h || !h.done || h.voided || !h.result || isPD()) return;
    if (flown === h.no || watched !== h.no) return;
    flown = h.no;
    const from = document.querySelector('.tcenter .pot .amt, .card.pot .amt');
    if (!from) return;
    const a = from.getBoundingClientRect();
    const sx = a.left + a.width / 2; const sy = a.top + a.height / 2;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // a big win is a pot of 50 BB or more (the whole pot, so a split big pot counts for each winner)
    const bigPot = Object.values(h.result).reduce((a, b) => a + b, 0) >= BIG_POT_BB * (h.bb || 1);
    Object.entries(h.result).forEach(([id, amt], w) => {
      const seat = document.querySelector(`[data-pid="${CSS.escape(id)}"] .av, .pl[data-pid="${CSS.escape(id)}"] .stack`);
      if (!seat) return;
      const b = seat.getBoundingClientRect();
      const tx = b.left + b.width / 2; const ty = b.top + b.height / 2;
      const n = reduce ? 3 : Math.min(10, 4 + Math.floor(Math.log10(Math.max(1, amt)) * 2));
      for (let i = 0; i < n; i++) {
        const delay = 250 + w * 350 + i * 70;
        const c = document.createElement('div');
        c.className = 'flychip';
        c.style.left = `${sx + (Math.random() - 0.5) * 24}px`;
        c.style.top = `${sy + (Math.random() - 0.5) * 12}px`;
        document.body.appendChild(c);
        setTimeout(() => {
          c.style.transform = `translate(${tx - sx}px, ${ty - sy}px) scale(.8)`;
          c.style.opacity = '1';
        }, delay);
        setTimeout(() => { Sfx.play('land', i); c.remove(); }, delay + 620);
      }
      setTimeout(() => {
        const pop = document.createElement('div');
        pop.className = 'winpop';
        pop.textContent = `+${fmt(amt)}`;
        pop.style.left = `${tx}px`; pop.style.top = `${ty - 18}px`;
        document.body.appendChild(pop);
        setTimeout(() => pop.remove(), 1600);
      }, 250 + w * 350 + n * 70 + 450);
      // a big pot: chips rain down the winner's own screen; everyone else sees their seat glow
      if (bigPot) {
        const at = 250 + w * 350 + n * 70 + 300;
        const who = pById(id);
        // the winning hand's name: shown cards, or our own hole cards; unknown when everyone else folded
        let hand = h.shown && h.shown[id] ? h.shown[id].hand : null;
        if (!hand && id === myId) { const hole = myHole(); const b = hole && h.board && h.board.length >= 3 ? Cards.bestFor(hole, h.board, h.game) : null; hand = b ? b.name : null; }
        if (id === myId) setTimeout(() => { chipRain(reduce); bigWin(who ? who.name : '', amt, true, reduce, hand); }, at);
        else setTimeout(() => { seatGlow(id); bigWin(who ? who.name : '', amt, false, reduce, hand); }, at);
      }
    });
  }

  const BIG_POT_BB = 50;
  // BIG WIN banner: full-screen burst with a counting amount for the winner, a slim banner for everyone else
  function bigWin(name, amt, mine, reduce, hand) {
    const box = document.createElement('div');
    box.className = `bigwin ${mine ? 'mine' : 'other'}`;
    box.innerHTML = `${mine ? '<div class="rays"></div>' : ''}<div class="bwin"><div class="bw1">${mine ? esc(hand || 'BIG WIN') : `🏆 ${esc(name)}${hand ? ` · ${esc(hand)}` : ''}`}</div><div class="bw2">+0</div></div>`;
    document.body.appendChild(box);
    Sfx.play('bigwin');
    const out = box.querySelector('.bw2');
    const dur = reduce ? 0 : 1400; const t0 = performance.now();
    const step = (t) => {
      const k = dur ? Math.min(1, (t - t0) / dur) : 1;
      out.textContent = `+${fmt(Math.round(amt * (1 - Math.pow(1 - k, 3))))}`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    setTimeout(() => { box.classList.add('out'); setTimeout(() => box.remove(), 500); }, mine ? 3200 : 2400);
  }
  function chipRain(reduce) {
    const box = document.createElement('div');
    box.className = 'chiprain';
    const n = reduce ? 30 : 170;
    for (let i = 0; i < n; i++) {
      const c = document.createElement('i');
      const dur = 1.3 + Math.random() * 1.2; const delay = Math.random() * 1.9;
      c.style.left = `${Math.random() * 100}%`;
      c.style.animationDuration = `${dur}s`;
      c.style.animationDelay = `${delay}s`;
      c.style.setProperty('--spin', `${(Math.random() * 2 - 1) * 720}deg`);
      c.style.setProperty('--s', (0.7 + Math.random() * 0.7).toFixed(2));
      box.appendChild(c);
      if (i % 9 === 0) setTimeout(() => Sfx.play('land', i % 12), (delay + dur * 0.9) * 1000);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 5400);
    try { navigator.vibrate && navigator.vibrate([60, 40, 60, 40, 200]); } catch (e) { /* ignore */ }
  }
  function seatGlow(id) {
    const seat = document.querySelector(`.seat[data-pid="${CSS.escape(id)}"], .pl[data-pid="${CSS.escape(id)}"]`);
    if (!seat) return;
    const r = seat.getBoundingClientRect();
    const g = document.createElement('div');
    g.className = 'seatglow';
    Object.assign(g.style, { left: `${r.left - 10}px`, top: `${r.top - 10}px`, width: `${r.width + 20}px`, height: `${r.height + 20}px` });
    document.body.appendChild(g);
    setTimeout(() => g.remove(), 3200);
  }

  // keep the table fitted when the action bar or the screen size changes
  function fitTable() {
    if (ui.view !== 'table' || ui.raiseOpen || !document.querySelector('.ptable')) return;
    const bar = document.querySelector('.actbar');
    const hgt = bar ? bar.offsetHeight : 0;
    const top = Math.round(document.querySelector('.ptable').getBoundingClientRect().top + window.scrollY);
    if (Math.abs(hgt - (ui.actbarH || 150)) > 8 || Math.abs(top - (ui.tableTop || 0)) > 8) { ui.actbarH = hgt; ui.tableTop = top; render(); }
  }
  window.addEventListener('resize', () => { if (ui.view === 'table' && document.querySelector('.ptable')) render(); });

  function seatInfo(p) {
    const h = S.hand;
    const live = h && !h.done;
    const inH = h && h.ids.includes(p.id);
    const badges = [];
    if (h && inH) {
      if (h.btn === p.id) badges.push('<span class="badge d">D</span>');
      if (h.sbId === p.id && h.sbId !== h.btn) badges.push('<span class="badge sb">SB</span>');
      if (h.bbId === p.id) badges.push('<span class="badge bb">BB</span>');
      if (live && h.allIn[p.id]) badges.push('<span class="badge ai">ALL-IN</span>');
    } else if (!h && S.buttonId === p.id) badges.push('<span class="badge d">D</span>');
    let status = '';
    let cls = '';
    if (p.out) { status = S.settings.mode === 'tournament' ? `ตกรอบ (ที่ ${S.players.length - S.finishOrder.indexOf(p.id)})` : 'ชิปหมด'; cls = 'idle'; }
    else if (p.sitOut) { status = 'พักโต๊ะ'; cls = 'idle'; }
    else if (live && !inH) { status = 'รอมือถัดไป'; cls = 'idle'; }
    else if (live && h.folded[p.id]) { status = 'Fold'; cls = 'fold'; }
    else if (live && h.toAct === p.id) { status = 'กำลังคิด…'; cls = 'turn'; }
    else if (live && h.lastAct[p.id]) status = h.lastAct[p.id];
    const clock = live && h.toAct === p.id && turnEnds(h) ? ` <span class="tclock">⏱ ${cdHtml(turnEnds(h))}</span>` : '';
    if (!p.out && p.stack === 0 && !(live && inH)) status = S.settings.mode === 'cash' ? 'ชิปหมด — Rebuy?' : status;
    return { badges, status, cls, clock, betAmt: live ? h.bets[p.id] || 0 : 0, wonAmt: h && h.done && h.result ? h.result[p.id] || 0 : 0 };
  }

  function playerRow(p) {
    const h = S.hand;
    const s = seatInfo(p);
    const bet = s.betAmt ? `<span class="bet">${fmt(s.betAmt)}</span>` : '';
    const won = s.wonAmt ? `<div class="won">+${fmt(s.wonAmt)}</div>` : '';
    return `<div class="pl ${s.cls}" data-pid="${esc(p.id)}">
      <span class="dot ${isOnline(p.id) ? 'on' : 'off'}"></span>
      <div class="nm"><b>${p.emoji ? `<span class="pemo">${esc(p.emoji)}</span>` : ''}${nameHtml(p.name)}${p.id === S.hostId ? ' <span title="เจ้ามือ">👑</span>' : ''}${s.badges.join('')}${p.id === myId ? ' <span class="me-tag">คุณ</span>' : ''}</b><span class="st">${esc(s.status)}${s.clock}</span>${h && h.shown && h.shown[p.id] ? `<span class="shown">${cardsHtml(h.shown[p.id].cards, 'sm', `s${h.no}${p.id}`)} ${esc(h.shown[p.id].hand)}</span>` : ''}</div>
      <div class="stack ${credit() ? toneOf(balance(p)) : ''}">${chips(p)}${bet ? '<br>' + bet : ''}${won}</div>
    </div>`;
  }

  // ---------- app-dealt cards ----------
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  // Flip a card in the first time it is drawn. The page re-renders often, so each card keeps the
  // time it first appeared and later renders resume the animation where it is (negative delay).
  const FLIP_MS = 450; const FLIP_GAP = 120;
  const flipSeen = new Map();
  let flipReady = false; // cards already on the table when the room first shows don't animate
  function flipAttr(key, i) {
    const t = Date.now();
    if (!flipReady && !flipSeen.size) setTimeout(() => { flipReady = true; }, 300);
    if (!flipSeen.has(key)) {
      if (flipSeen.size > 300) flipSeen.clear();
      flipSeen.set(key, flipReady ? t + i * FLIP_GAP : 0);
    }
    const since = t - flipSeen.get(key);
    return since < FLIP_MS ? { cls: ' flip', style: ` style="animation-delay:${-since}ms"` } : { cls: '', style: '' };
  }
  // The cards that make the hand that matters right now light up and the rest of that hand dims:
  // my best hand while I'm in it, the winner's once the hand is shown down.
  let hl = null;
  function highlightFor(h) {
    if (!h || !h.appCards || !h.board || h.board.length < 3) return null;
    let cards = null;
    if (h.done && h.shown) {
      const win = Object.keys(h.result || {}).find((id) => h.shown[id]);
      if (win) cards = h.shown[win].cards;
    } else cards = myHole(); // still lit after folding: the hand you would have had
    const b = cards && Cards.bestFor(cards, h.board, h.game);
    if (!b) return null;
    return { on: new Set(b.made), pool: new Set(cards.concat(h.board)) };
  }
  function cardHtml(c, size, key, i) {
    if (c == null) return `<span class="pc back ${size || ''}"></span>`;
    const r = Cards.RANKS[Cards.rankOf(c)]; const su = Cards.SUITS[Cards.suitOf(c)];
    const f = key ? flipAttr(`${key}:${c}`, i || 0) : { cls: '', style: '' };
    const lit = hl && hl.pool.has(c) ? (hl.on.has(c) ? ' hi' : ' lo') : '';
    return `<span class="pc ${size || ''} su-${su}${f.cls}${lit}"${f.style}>${r === 'T' ? '10' : r}<i>${SUIT_SYM[su]}</i></span>`;
  }
  const cardsHtml = (list, size, key) => `<span class="pcs">${list.map((c, i) => cardHtml(c, size, key, i)).join('')}</span>`;
  function boardHtml(board) {
    const firstNew = board.findIndex((c) => !flipSeen.has(`b${S.hand.no}:${c}`));
    const slots = [0, 1, 2, 3, 4].map((i) => (i < board.length ? cardHtml(board[i], '', `b${S.hand.no}`, firstNew < 0 ? 0 : i - firstNew) : '<span class="pc slot"></span>')).join('');
    return `<div class="board">${slots}</div>`;
  }

  // My chance to win against the other live hands, unseen (simulated off the main render).
  function winChance(h, cards) {
    const opps = h.ids.filter((id) => id !== myId && !h.folded[id]).length;
    const board = h.board || [];
    const key = [h.no, cards.join(), board.join(), opps].join('|');
    if (ui.eq && ui.eq.key === key) return ui.eq.val;
    ui.eq = { key, val: undefined };
    setTimeout(() => {
      if (!ui.eq || ui.eq.key !== key) return;
      ui.eq.val = Cards.equity(cards, board, opps, h.game, h.game === 'plo' || opps > 8 ? 700 : 1500); // fewer runs on crowded tables
      render();
    }, 30);
    return undefined;
  }

  function myCardsPanel() {
    const h = S.hand; const cards = myHole();
    if (!h || !cards) return '';
    const folded = h.folded[myId];
    const made = !folded && h.board && h.board.length >= 3 ? Cards.bestFor(cards, h.board, h.game) : null;
    const eq = folded || h.done || h.street === 'showdown' ? null : winChance(h, cards);
    const shown = h.shown && h.shown[myId];
    const showBtn = h.done ? (shown ? '<br><span class="muted">ทุกคนเห็นไพ่คุณแล้ว</span>'
      : `<br><button class="sm" data-a="cmd" data-c="show" data-pid="${esc(myId)}">🃏 โชว์ไพ่ให้ทุกคนดู</button>`) : '';
    const eqHtml = eq === null ? '' : `<br>โอกาสชนะ: <b class="gold">${eq === undefined ? '…' : `${Math.round(eq * 100)}%`}</b>`;
    if (ui.holeHidden) {
      return `<div class="card mycards hidden" data-a="holeHide"><span class="pcs">${cardHtml(null, 'lg')}${cardHtml(null, 'lg')}</span><span class="muted small">ไพ่ของคุณ · แตะเพื่อดู</span></div>`;
    }
    return `<div class="card mycards ${folded ? 'fold' : ''}${regretHand(h, cards) ? ' regret' : ''}" data-a="holeHide">${cardsHtml(cards, 'lg', `m${h.no}`)}
      <span class="small"><b>ไพ่ของคุณ</b>${h.game === 'plo' ? ' <span class="muted">(ใช้ 2 ใบ + กลาง 3 ใบ)</span>' : ''}${folded ? ` · Fold แล้ว${regretHand(h, cards) ? `<br>😢 ถ้าไม่หมอบ: <b class="gold">${regretHand(h, cards)}</b>` : ''}` : made ? `<br>ตอนนี้: <b class="gold">${made.name}</b>` : ''}${eqHtml}${showBtn}<br><span class="muted">แตะเพื่อซ่อน</span></span></div>`;
  }

  function showdown() {
    if (S.hand.appCards) return '';
    const h = S.hand;
    if (!isHost()) return `<div class="card center muted">รอเจ้ามือเลือกผู้ชนะ…</div>`;
    const pots = h.pots.map((pot, i) => `<div class="pot-pick"><div class="h">${h.pots.length > 1 ? (i ? `Side pot ${i}` : 'Main pot') : 'Pot'} · ${fmt(pot.amount)} — แตะผู้ชนะ (เสมอเลือกได้หลายคน)</div>
      <div class="pick">${pot.elig.map((id) => `<button class="${ui.sd[i].includes(id) ? 'on' : ''}" data-a="sd" data-i="${i}" data-id="${esc(id)}">${esc(pById(id).name)}</button>`).join('')}</div></div>`).join('');
    const ready = ui.sd.every((w) => w.length);
    return `<div class="card"><h2>เลือกผู้ชนะ</h2>${pots}
      <button class="primary" style="width:100%" data-a="award" ${ready ? '' : 'disabled'}>ยืนยันผู้ชนะ</button></div>`;
  }

  function bottomBar(actor) {
    const h = S.hand;
    if (!h && S.handNo === 0) return '';
    if (actor) return actionBar(actor);
    const meW = pById(myId);
    if (meW && meW.watching) {
      return `<div class="actbar"><div class="in"><div class="sitbar"><span class="muted small">👀 คุณกำลังดูอยู่ · ได้ไพ่ตั้งแต่มือถัดไปหลังนั่ง</span>
        <button class="primary sitbtn" data-a="cmd" data-c="stand" data-pid="${esc(myId)}" data-v="">🪑 นั่งเล่น · ${chipWord()} ${chips(meW)}</button></div></div></div>`;
    }
    let inner = '';
    if (!h || h.done) {
      const me = pById(myId);
      const rebuy = me && S.settings.mode === 'cash' && !credit() && me.stack === 0 ? `<button class="blue" data-a="cmd" data-c="rebuy" data-pid="${esc(myId)}">Rebuy +${fmt(S.settings.startStack)}</button>` : '';
      if (isHost()) {
        const over = S.settings.mode === 'tournament' && E.eligible(S).length < 2 && S.handNo > 0;
        inner = over ? `<div class="grid2">${rebuy || ''}<button class="primary" data-a="sheet" data-v="summary">🏆 สรุปผล</button></div>`
          : `<div class="row">${rebuy}<button class="primary" style="padding:16px" data-a="cmd" data-c="start">เริ่มมือถัดไป ▶${nextStarts(h) ? ` <small>(อัตโนมัติใน ${cdHtml(nextStarts(h))} วิ)</small>` : ''}</button></div>`;
      } else {
        const wait = nextStarts(h) ? `มือถัดไปเริ่มใน ${cdHtml(nextStarts(h))} วิ` : 'รอเจ้ามือเริ่มมือถัดไป…';
        inner = rebuy ? `<div class="row">${rebuy}</div>${nextStarts(h) ? `<div class="waitbar" style="margin-top:6px">${wait}</div>` : ''}` : `<div class="waitbar">${wait}</div>`;
      }
    } else if (h.toAct) {
      const p = pById(h.toAct);
      inner = `<div class="waitbar">ตาของ <b>${esc(p.name)}</b>${turnEnds(h) ? ` · ⏱ ${cdHtml(turnEnds(h))} วิ` : ''}${isHost() ? ` · <button class="sm ghost" data-a="proxy">กดแทน</button>` : ''}</div>${preBar(h)}`;
    } else return '';
    return `<div class="actbar"><div class="in">${inner}</div></div>`;
  }

  // Pre-actions: while someone else is deciding, the player picks what to do on their turn and
  // the app does it the moment the turn comes. Check is dropped if a bet comes in, and Call X if
  // the amount changes; Check/Fold and Call Any hold.
  function preState(h) {
    const me = pById(myId);
    if (!h || h.done || !me || !h.ids.includes(myId) || h.folded[myId] || h.allIn[myId] || h.street === 'showdown') return null;
    return { toCall: Math.max(0, h.currentBet - (h.bets[myId] || 0)), stack: me.stack };
  }
  function preAction(h) {
    const p = ui.pre; const st = preState(h);
    if (!p || !st || p.no !== h.no) return null;
    if (p.t === 'checkfold') return st.toCall ? 'fold' : 'check';
    if (p.t === 'check') return st.toCall ? null : 'check';
    if (p.t === 'call') return st.toCall && st.toCall === p.amt ? 'call' : st.toCall ? null : 'check';
    if (p.t === 'callany') return st.toCall ? 'call' : 'check';
    return null;
  }
  function preBar(h) {
    const st = preState(h);
    if (!st) return '';
    // an earlier choice that no longer applies (a bet came in, the amount changed) is dropped
    if (ui.pre && (ui.pre.no !== h.no || (ui.pre.t === 'check' && st.toCall) || (ui.pre.t === 'call' && st.toCall !== ui.pre.amt))) ui.pre = null;
    const on = (t) => (ui.pre && ui.pre.t === t ? ' on' : '');
    const call = st.toCall ? Math.min(st.toCall, st.stack) : 0;
    return `<div class="prelabel">${ui.pre ? '✅ เลือกไว้แล้ว — ถึงตาแอปกดให้เอง' : '⏳ กดรอไว้ก่อนได้ · ถึงตาแล้วแอปกดให้'}</div><div class="btns prebtns">
      <button class="danger${on('checkfold')}" data-a="pre" data-t="checkfold">${on('checkfold') ? '✓ ' : ''}${st.toCall ? 'Fold' : 'Check / Fold'}</button>
      ${st.toCall ? `<button class="blue${on('call')}" data-a="pre" data-t="call" data-v="${st.toCall}">${on('call') ? '✓ ' : ''}Call ${fmt(call)}</button>` : `<button class="blue${on('check')}" data-a="pre" data-t="check">${on('check') ? '✓ ' : ''}Check</button>`}
      <button class="primary${on('callany')}" data-a="pre" data-t="callany">${on('callany') ? '✓ ' : ''}Call Any</button></div>
`;
  }

  function actionBar(id) {
    const a = actorInfo(id);
    if (!ui.typingRaise && (!ui.raiseTo || ui.raiseTo < a.minTo || ui.raiseTo > a.maxTo)) ui.raiseTo = a.minTo;
    const proxy = id !== myId;
    const callBtn = a.toCall > 0
      ? `<button class="blue" data-a="act" data-t="call">${a.toCall >= a.p.stack ? 'All-in ' + fmt(a.p.stack) : 'Call ' + fmt(a.toCall)}</button>`
      : `<button class="blue" data-a="act" data-t="check">Check</button>`;
    const raiseBtn = a.canRaise
      ? `<button class="primary" data-a="raiseToggle">${a.isBet ? 'Bet' : 'Raise'} ${ui.raiseOpen ? '▾' : '▸'}</button>`
      : `<button class="primary" disabled>${a.isBet ? 'Bet' : 'Raise'}</button>`;
    let raise = '';
    if (ui.raiseOpen && a.canRaise) {
      const q = (f) => Math.round(S.hand.currentBet + (a.pot + a.toCall) * f);
      const quick = [['Min', a.minTo], ['½ Pot', q(0.5)], ['¾ Pot', q(0.75)], ['Pot', q(1)]].concat(a.plo ? [] : credit() ? [['2× Pot', q(2)]] : [['All-in', a.maxTo]])
        .map(([l, v]) => `<button data-a="quick" data-v="${Math.max(a.minTo, Math.min(a.maxTo, v))}">${l}</button>`).join('');
      const step = S.hand.bb;
      const rangeMax = credit() && !a.plo ? Math.max(a.minTo + step * 10, q(2)) : a.maxTo;
      raise = `<div class="raise">
        <div class="amt"><span class="muted small">${a.isBet ? 'Bet' : 'Raise to'}</span>
          <input id="raiseInput" type="number" inputmode="numeric" enterkeyhint="done" min="${a.minTo}" max="${a.maxTo}" value="${ui.raiseTo}" aria-label="จำนวนชิป"></div>
        <div class="raisehint" id="raiseHint">ขั้นต่ำ ${fmt(a.minTo)}${a.capped ? ` · สูงสุด ${fmt(a.maxTo)} (Pot)` : credit() ? ' · ไม่จำกัดสูงสุด' : ` · สูงสุด ${fmt(a.maxTo)} (All-in)`}</div>
        <div class="row"><button class="sm" style="flex:none" data-a="step" data-v="${-step}">−</button>
          <input type="range" id="raiseRange" min="${a.minTo}" max="${rangeMax}" step="1" value="${ui.raiseTo}">
          <button class="sm" style="flex:none" data-a="step" data-v="${step}">+</button></div>
        <div class="quick">${quick}</div>
        <button class="primary" style="width:100%;padding:16px" data-a="act" data-t="raise" id="raiseGo">ยืนยัน ${a.isBet ? 'Bet' : 'Raise to'} ${fmt(ui.raiseTo)}</button>
      </div>`;
    }
    return `<div class="actbar"><div class="in">
      <div class="who"><span>${proxy ? `เจ้ามือกดแทน <b>${esc(a.p.name)}</b> · <u data-a="proxy">ยกเลิก</u>` : `<b>ถึงตาคุณ!</b>${turnEnds(S.hand) ? ` <span class="tclock">⏱ ${cdHtml(turnEnds(S.hand))}</span>` : ''}`}</span><span>${!proxy && myHole() && !ui.holeHidden ? cardsHtml(myHole(), 'sm') + ' ' : ''}${chipWord()} ${chips(a.p)}${a.toCall ? ` · ต้อง call ${fmt(Math.min(a.toCall, a.p.stack))}` : ''}</span></div>
      <div class="btns"><button class="danger" data-a="act" data-t="fold">Fold</button>${callBtn}${raiseBtn}</div>
      ${raise}
    </div></div>`;
  }

  // ---------- Pok Deng ----------
  const PD = window.PokDeng;
  function isPD() { return !!S && S.settings.mode === 'pokdeng'; }
  // in Pok Deng "เจ้ามือ" means the banker, so the phone that runs the room gets another name
  function hostWord() { return isPD() ? 'คนคุมห้อง' : 'เจ้ามือ'; }
  function signedFmt(n) { return `${n > 0 ? '+' : ''}${fmt(n)}`; }
  const toneOf = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  const canRunRound = () => isHost() || (S.pd && S.pd.bankerId === myId);
  const RES_LABEL = { win: 'ชนะ', lose: 'แพ้', tie: 'เสมอ' };

  function pdTable() {
    const pd = S.pd; const r = pd.round;
    const banker = pById(pd.bankerId);
    const bettors = Object.keys(r.bets);
    const total = bettors.reduce((a, id) => a + r.bets[id], 0);
    const last = pd.rounds[pd.rounds.length - 1];
    if (ui.pdRound !== r.no + r.phase) { ui.pdRound = r.no + r.phase; ui.pdRes = {}; }
    const lastHtml = last ? `<div class="sidepots">รอบที่ ${last.no}: ${Object.entries(last.delta).filter(([, d]) => d)
      .map(([id, d]) => `${esc(last.names[id])} <span class="${toneOf(d)}">${signedFmt(d)}</span>`).join(' · ') || 'เสมอทั้งวง'}</div>` : '';
    const me = pById(myId);
    const away = S.players.filter((p) => p.left);
    const standBanner = me && me.left ? `<div class="banner row"><span>คุณลุกจากวงแล้ว · ยอด ${signedFmt(me.net || 0)}</span>
      <button class="primary sm" style="flex:none" data-a="cmd" data-c="stand" data-pid="${esc(myId)}" data-v="">นั่งกลับ</button></div>` : '';
    return `${standBanner}<div class="card pot">
        <div class="lbl">ป๊อกเด้ง · รอบที่ ${r.no}</div>
        <div class="amt">${r.phase === 'bet' ? 'วางเดิมพัน' : 'เปิดไพ่'}</div>
        <div class="hint">🏦 เจ้ามือ: ${esc(banker ? banker.name : '-')} · ลง ${bettors.length} คน รวม ${fmt(total)} บาท</div>
        ${lastHtml}
      </div>${pdHostTools()}
      <div class="players">${S.players.filter((p) => !p.left).map(pdRow).join('')}</div>
      ${away.length ? `<div class="away"><span>ลุกแล้ว:</span> ${away.map((p) => `${esc(p.name)} <b class="${toneOf(p.net || 0)}">${signedFmt(p.net || 0)}</b>`).join(' · ')}</div>` : ''}
      ${r.phase === 'result' ? (canRunRound() ? pdResultPanel() : '<div class="card center muted">เปิดไพ่ — รอเจ้ามือบันทึกผล…</div>') : ''}
      <div class="lastlog" data-a="sheet" data-v="hands">${S.log.slice(-2).map(esc).join('<br>')}<br><u>ประวัติแต่ละรอบ</u></div>`;
  }

  function pdHostTools() {
    if (!isHost()) return '';
    return `<div class="hosttools">
      <button data-a="cmd" data-c="undo" ${hist.length ? '' : 'disabled'}>↩️<span>Undo</span></button>
      <button data-a="sheet" data-v="players">👥<span>ผู้เล่น/ยอด</span></button>
      <button data-a="sheet" data-v="pdBanker" ${S.pd.round.phase === 'bet' ? '' : 'disabled'}>🏦<span>เปลี่ยนเจ้ามือ</span></button>
      <button data-a="sheet" data-v="summary">📊<span>สรุป</span></button>
    </div>`;
  }

  function pdRow(p) {
    const pd = S.pd; const r = pd.round;
    const isBanker = p.id === pd.bankerId;
    const bet = r.bets[p.id];
    let status = isBanker ? 'เจ้ามือ' : p.sitOut ? 'พัก' : bet ? '' : 'ไม่ลงตานี้';
    let cls = 'pl' + (isBanker ? ' banker' : '') + (!isBanker && (p.sitOut || !bet) ? ' idle' : '');
    const editable = canRunRound() && r.phase === 'bet' && !isBanker && !p.sitOut;
    return `<div class="${cls}" ${editable ? `data-a="pdBetFor" data-pid="${esc(p.id)}"` : ''}>
      <span class="dot ${isOnline(p.id) ? 'on' : 'off'}"></span>
      <div class="nm"><b>${nameHtml(p.name)}${p.id === S.hostId ? ' <span title="คนคุมห้อง">👑</span>' : ''}${isBanker ? ' <span class="badge bank">🏦 เจ้ามือ</span>' : ''}${p.id === myId ? ' <span class="me-tag">คุณ</span>' : ''}</b>
        <span class="st">${bet ? `<span class="bet">ลง ${fmt(bet)}</span>` : esc(status)}${editable ? ' <u class="small">แก้</u>' : ''}</span></div>
      <div class="stack ${toneOf(p.net || 0)}">${signedFmt(p.net || 0)}</div>
    </div>`;
  }

  function pdResultPanel() {
    const r = S.pd.round;
    const rows = Object.keys(r.bets).map((id) => {
      const p = pById(id); const x = ui.pdRes[id] || {}; const m = x.m || 1;
      const d = x.r === 'win' ? r.bets[id] * m : x.r === 'lose' ? -r.bets[id] * m : 0;
      const rb = (k) => `<button class="${x.r === k ? 'on ' + k : ''}" data-a="pdRes" data-pid="${esc(id)}" data-r="${k}">${RES_LABEL[k]}</button>`;
      const mb = PD.MULTS.map((k) => `<button class="${x.r && x.r !== 'tie' && m === k ? 'on' : ''}" data-a="pdRes" data-pid="${esc(id)}" data-m="${k}" ${x.r === 'tie' ? 'disabled' : ''}>×${k}</button>`).join('');
      return `<div class="pdres"><div class="top"><b>${esc(p ? p.name : '?')}</b><span class="muted small">ลง ${fmt(r.bets[id])}</span>
        <span class="${toneOf(d)}">${x.r ? signedFmt(d) : ''}</span></div>
        <div class="seg rseg">${rb('lose')}${rb('tie')}${rb('win')}</div><div class="seg mseg">${mb}</div></div>`;
    }).join('');
    const ready = Object.keys(r.bets).every((id) => ui.pdRes[id] && ui.pdRes[id].r);
    const bank = Object.keys(r.bets).reduce((a, id) => {
      const x = ui.pdRes[id]; if (!x || !x.r || x.r === 'tie') return a;
      return a - (x.r === 'win' ? 1 : -1) * r.bets[id] * (x.m || 1);
    }, 0);
    return `<div class="card"><h2>บันทึกผล (เทียบกับเจ้ามือ)</h2>
      <div class="row small muted" style="margin-bottom:6px"><span style="flex:none">ทั้งวง:</span>
        <button class="sm" data-a="pdAll" data-r="lose">แพ้หมด</button><button class="sm" data-a="pdAll" data-r="win">ชนะหมด</button></div>
      ${rows}
      <div class="pdbank">🏦 เจ้ามือรอบนี้ <b class="${toneOf(bank)}">${signedFmt(bank)}</b></div>
      <p class="muted small" style="margin:4px 0 8px">×2 = สองเด้ง/ป๊อกเด้ง · ×3 = สามเด้ง/เซียน/เรียง · ×5 = ตอง (ใช้ตัวคูณของมือที่ชนะ)</p>
      <button class="primary" style="width:100%" data-a="pdSettle" ${ready ? '' : 'disabled'}>ยืนยันผลรอบนี้</button></div>`;
  }

  function pdBottom() {
    if (S.handNo === 0) return '';
    const pd = S.pd; const r = pd.round; const me = pById(myId);
    const bettor = me && me.id !== pd.bankerId && !me.left && !me.sitOut;
    let inner = '';
    if (r.phase === 'bet') {
      const n = Object.keys(r.bets).length;
      const dealBtn = canRunRound() ? `<button class="primary" style="width:100%;padding:14px;margin-top:${bettor ? 8 : 0}px" data-a="cmd" data-c="pdDeal" ${n ? '' : 'disabled'}>ปิดรับเดิมพัน · แจกไพ่ ▶ (${n} คน)</button>` : '';
      if (bettor) {
        const base = S.settings.defaultBet || 10;
        const cur = r.bets[myId] || 0;
        const draft = ui.pdDraft != null ? ui.pdDraft : String(cur || base);
        const quick = [base, base * 2, base * 5, base * 10].map((v) => `<button data-a="pdQuick" data-v="${v}">${fmt(v)}</button>`).join('');
        inner = `<div class="who"><span>${cur ? `ลงไว้ <b>${fmt(cur)}</b> บาท` : '<b>วางเดิมพันรอบนี้</b>'}</span><span>ยอดคุณ <span class="${toneOf(me.net || 0)}">${signedFmt(me.net || 0)}</span></span></div>
          <div class="row"><input id="pdBetInput" type="number" inputmode="numeric" enterkeyhint="done" min="0" value="${esc(draft)}" aria-label="เดิมพัน">
            <button class="primary" style="flex:none" data-a="pdBetGo" id="pdBetGo">${cur ? 'แก้เป็น' : 'ลง'} ${fmt(Number(draft) || 0)}</button></div>
          <div class="quick pdquick">${quick}<button class="ghost" data-a="pdSkip">ไม่ลง</button></div>${dealBtn}`;
      } else if (dealBtn) inner = dealBtn;
      else inner = `<div class="waitbar">${me && me.id === pd.bankerId ? 'คุณเป็นเจ้ามือ — รอทุกคนลงเดิมพัน' : 'รอผู้เล่นลงเดิมพัน…'}</div>`;
    } else {
      inner = canRunRound()
        ? `<div class="row"><button class="ghost" style="flex:none" data-a="cmd" data-c="pdReopen">↩ แก้เดิมพัน</button><div class="waitbar">บันทึกผลด้านบน แล้วกดยืนยัน</div></div>`
        : `<div class="waitbar">เปิดไพ่! ${r.bets[myId] ? `คุณลง <b>${fmt(r.bets[myId])}</b> · ` : ''}รอเจ้ามือบันทึกผล</div>`;
    }
    return `<div class="actbar"><div class="in">${inner}</div></div>`;
  }

  function syncPdBet() {
    const g = document.getElementById('pdBetGo');
    if (g) g.textContent = g.textContent.replace(/[\d,]*$/, fmt(Number(ui.pdDraft) || 0));
  }

  function pdMenuSheet(me) {
    if (!isHost()) {
      return ['เมนู', `<div class="menu">
        <button data-a="sheet" data-v="invite">📱 ชวนเพื่อน (QR)</button>
        <button data-a="sheet" data-v="summary">📊 สรุปยอด</button>
        <button data-a="sheet" data-v="hands">🎴 ประวัติแต่ละรอบ</button>
        ${me ? `${standButton(me)}${me.left ? '' : `<button data-a="cmd" data-c="sitout" data-pid="${esc(myId)}" data-v="${me.sitOut ? '' : '1'}">${me.sitOut ? '▶ กลับมาเล่น' : '⏸ พัก (ไม่ลงเดิมพันชั่วคราว)'}</button>`}
        <button data-a="rename">✏️ เปลี่ยนชื่อ</button>` : ''}
        <button class="ghost" data-a="leave">ออกจากห้อง</button></div>`];
    }
    return ['เมนูคนคุมห้อง', `<div class="menu">
      <button data-a="cmd" data-c="undo">↩️ Undo (ย้อน 1 ขั้น)</button>
      <button data-a="sheet" data-v="players">👥 ผู้เล่น · ยอด · ลำดับ</button>
      <button data-a="sheet" data-v="pdBanker">🏦 เปลี่ยนเจ้ามือป๊อกเด้ง</button>
      <button data-a="sheet" data-v="settings">⚙️ ตั้งค่า (เดิมพันตั้งต้น)</button>
      <button data-a="sheet" data-v="invite">📱 ชวนเพื่อน (QR)</button>
      <button data-a="sheet" data-v="handoff">👑 ส่งต่อการคุมห้องให้คนอื่น</button>
      <button data-a="sheet" data-v="summary">📊 สรุปยอด / ใครโอนให้ใคร</button>
      <button data-a="sheet" data-v="hands">🎴 ประวัติแต่ละรอบ</button>
      ${me ? standButton(me) : `<button data-a="hostJoin">🙋 ร่วมเล่นด้วย</button>`}
      <button data-a="goHome">🏠 กลับหน้าแรก (เก็บห้องไว้)</button>
      <button class="danger" data-a="endRoom">ปิดห้อง (ลบเกมนี้)</button>
    </div>`];
  }

  function pdBankerSheet() {
    const rows = S.players.filter((p) => !p.left).map((p) => `<button data-a="pdBanker" data-pid="${esc(p.id)}" ${p.id === S.pd.bankerId ? 'disabled' : ''}>
      ${p.id === S.pd.bankerId ? '🏦 ' : ''}${esc(p.name)}${p.id === S.pd.bankerId ? ' (เจ้ามืออยู่)' : ''}</button>`).join('');
    return ['เปลี่ยนเจ้ามือป๊อกเด้ง', `<p class="muted small" style="margin-top:0">เปลี่ยนได้ตอนรับเดิมพัน · เดิมพันของคนที่มาเป็นเจ้ามือจะถูกยกเลิก</p><div class="menu">${rows}</div>`];
  }

  function pdPlayersSheet() {
    const rows = S.players.map((p, i) => `<div class="prow"><div class="top"><b>${i + 1}. ${esc(p.name)}${p.id === myId ? ' (คุณ)' : ''}${p.id === S.pd.bankerId ? ' 🏦' : ''}${p.left ? ' <span class="muted small">· ลุกแล้ว</span>' : ''}</b>
        <span class="${toneOf(p.net || 0)}">${signedFmt(p.net || 0)}</span></div>
      <div class="acts">
        <button class="sm" data-a="cmd" data-c="move" data-pid="${esc(p.id)}" data-d="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="sm" data-a="cmd" data-c="move" data-pid="${esc(p.id)}" data-d="1" ${i === S.players.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="sm" data-a="pdNet" data-pid="${esc(p.id)}">แก้ยอด</button>
        <button class="sm" data-a="cmd" data-c="sitout" data-pid="${esc(p.id)}" data-v="${p.sitOut ? '' : '1'}" ${p.left ? 'disabled' : ''}>${p.sitOut ? 'กลับมาเล่น' : 'พัก'}</button>
        ${p.left ? `<button class="sm primary" data-a="cmd" data-c="stand" data-pid="${esc(p.id)}" data-v="">นั่งกลับ</button>`
          : `<button class="sm" data-a="stand" data-pid="${esc(p.id)}">ลุก</button>`}
        <button class="sm danger" data-a="remove" data-pid="${esc(p.id)}">ลบ</button>
      </div></div>`).join('');
    return ['ผู้เล่น', `<p class="muted small" style="margin-top:0">แก้ยอด = ปรับยอดได้/เสียสะสมด้วยมือ (เช่น จ่ายกันไปแล้วระหว่างเกม)</p>${rows}`];
  }

  function pdSummarySheet() {
    const data = S.players.map((p) => ({ p, net: p.net || 0 })).sort((a, b) => b.net - a.net);
    const rows = data.map(({ p, net }) => `<tr><td>${esc(p.name)}${p.left ? ' 🚪' : ''}${p.id === S.pd.bankerId ? ' 🏦' : ''}</td>
      <td class="${toneOf(net)}"><b>${signedFmt(net)}</b> บาท</td></tr>`).join('');
    const sum = data.reduce((a, x) => a + x.net, 0);
    const tx = settle(data.map(({ p, net }) => ({ name: p.name, amt: net })));
    const txHtml = tx.length ? tx.map((t) => `<div class="tx"><span>${esc(t.from)}</span><span class="arrow">→</span><span>${esc(t.to)}</span><b>${fmt(t.amt)} บาท</b></div>`).join('')
      : '<p class="muted small">ยังไม่มีใครได้หรือเสีย</p>';
    return ['สรุปยอดป๊อกเด้ง', `<p class="muted small" style="margin-top:0">เล่นไป ${S.pd.rounds.length} รอบ</p>
      <table class="summary"><tr><th>ผู้เล่น</th><th>ได้/เสีย</th></tr>${rows}
      <tr class="total"><td>รวม</td><td>${sum === 0 ? '✓ ลงตัว' : signedFmt(sum)}</td></tr></table>
      <h2 style="margin:16px 0 6px">💸 ใครโอนให้ใคร</h2>${txHtml}
      ${sum ? '<p class="muted small">* ยอดรวมไม่เป็นศูนย์ เพราะมีการแก้ยอดด้วยมือ</p>' : ''}`];
  }

  function pdRoundsSheet() {
    const rs = S.pd.rounds.slice().reverse();
    const items = rs.map((r, i) => {
      const nm = (id) => esc(r.names[id] || (pById(id) || {}).name || '?');
      const lines = Object.keys(r.bets).map((id) => {
        const x = r.results[id];
        return `<span>${nm(id)} ลง ${fmt(r.bets[id])} · ${RES_LABEL[x.r]}${x.r !== 'tie' && x.m > 1 ? ` ×${x.m}` : ''} <b class="${toneOf(r.delta[id])}">${signedFmt(r.delta[id])}</b></span>`;
      }).join('');
      const mine = r.delta[myId] != null ? ` · คุณ <span class="${toneOf(r.delta[myId])}">${signedFmt(r.delta[myId])}</span>` : '';
      return `<details class="hand" ${i === 0 ? 'open' : ''}><summary><b>รอบที่ ${r.no}</b> · 🏦 ${nm(r.bankerId)} <span class="${toneOf(r.delta[r.bankerId])}">${signedFmt(r.delta[r.bankerId])}</span>${mine}</summary>
        <div class="hdelta pdlines">${lines}</div></details>`;
    }).join('');
    return ['ประวัติแต่ละรอบ', `${items || '<p class="muted">ยังไม่มีรอบที่จบ</p>'}
      <p class="center small" style="margin-top:12px"><u data-a="sheet" data-v="log">ดูบันทึกเหตุการณ์ทั้งหมด</u> <span class="muted">· เก็บ 50 รอบล่าสุด</span></p>`];
  }

  // ---------- sheets ----------
  function sheet() {
    hl = null; // the table's card highlight is for the hand in play, not the cards in a sheet
    if (!ui.sheet) return '';
    const body = { menu: menuSheet, invite: inviteSheet, settings: settingsSheet, players: playersSheet, summary: summarySheet, log: logSheet, hands: handsSheet, handoff: handoffSheet, pdBanker: pdBankerSheet, ranks: ranksSheet, avatar: avatarSheet }[ui.sheet];
    if (!body) return '';
    const [title, html, action] = body();
    return `<div class="sheet-bg" data-a="closeSheet" data-sheet="${ui.sheet}"><div class="sheet" data-stop="1">
      <div class="head"><h2 style="margin:0">${title}</h2><span class="row" style="gap:6px">${action || ''}<button class="sm ghost" data-a="closeSheet">ปิด</button></span></div>${html}</div></div>`;
  }

  function menuSheet() {
    const tour = S.settings.mode === 'tournament';
    const me = pById(myId);
    if (isPD()) return pdMenuSheet(me);
    if (!isHost()) {
      return ['เมนู', `<div class="menu">
        <button data-a="sheet" data-v="invite">📱 ชวนเพื่อน (QR)</button>
        <button data-a="sheet" data-v="summary">📊 สรุปประจำโต๊ะ</button>
        <button data-a="sheet" data-v="hands">🃏 ประวัติรายมือ</button>
        <button data-a="sheet" data-v="ranks">🏆 อันดับไพ่</button>
        ${me ? '<button data-a="sheet" data-v="avatar">😀 เปลี่ยนรูปแทนตัว</button>' : ''}
        <button data-a="mute">${Sfx.isMuted() ? '🔇 เสียงเอฟเฟกต์: ปิด (แตะเพื่อเปิด)' : '🔊 เสียงเอฟเฟกต์: เปิด (แตะเพื่อปิด)'}</button>
        <button data-a="view" data-v="${ui.view === 'table' ? 'list' : 'table'}">${ui.view === 'table' ? '📋 เปลี่ยนเป็นมุมมองรายการ' : '🃏 เปลี่ยนเป็นมุมมองโต๊ะ'}</button>
        ${me ? `${standButton(me)}${me.left ? '' : `<button data-a="cmd" data-c="sitout" data-pid="${esc(myId)}" data-v="${me.sitOut ? '' : '1'}">${me.sitOut ? '▶ กลับมาเล่น' : '⏸ พักโต๊ะ (ข้ามมือถัดไป)'}</button>`}
        <button data-a="rename">✏️ เปลี่ยนชื่อ</button>` : ''}
        <button class="ghost" data-a="leave">ออกจากห้อง</button></div>`];
    }
    return ['เมนูเจ้ามือ', `<div class="menu">
      <button data-a="cmd" data-c="undo">↩️ Undo (ย้อน 1 ขั้น)</button>
      <button data-a="sheet" data-v="players">👥 ผู้เล่น · ชิป · Rebuy · ที่นั่ง</button>
      <button data-a="sheet" data-v="settings">⚙️ ตั้งค่า Blinds / เกม</button>
      ${tour || S.settings.sessionMin > 0 ? `<button data-a="cmd" data-c="pause" data-v="${S.pausedAt != null ? '' : '1'}">${S.pausedAt != null ? '▶ เดินเวลาต่อ' : '⏸ หยุดเวลา'}</button>` : ''}
      ${tour ? `
        <div class="grid2"><button data-a="cmd" data-c="level" data-d="-1">◀ Level ก่อน</button><button data-a="cmd" data-c="level" data-d="1">Level ถัดไป ▶</button></div>` : ''}
      <button data-a="sheet" data-v="invite">📱 ชวนเพื่อน (QR)</button>
      <button data-a="sheet" data-v="handoff">👑 เปลี่ยนเจ้ามือ (ส่งต่อให้คนอื่น)</button>
      <button data-a="sheet" data-v="summary">📊 สรุปผล / เงิน</button>
      <button data-a="sheet" data-v="hands">🃏 ประวัติรายมือ</button>
      <button data-a="sheet" data-v="ranks">🏆 อันดับไพ่</button>
      ${me ? '<button data-a="sheet" data-v="avatar">😀 เปลี่ยนรูปแทนตัว</button>' : ''}
      <button data-a="mute">${Sfx.isMuted() ? '🔇 เสียงเอฟเฟกต์: ปิด (แตะเพื่อเปิด)' : '🔊 เสียงเอฟเฟกต์: เปิด (แตะเพื่อปิด)'}</button>
        <button data-a="view" data-v="${ui.view === 'table' ? 'list' : 'table'}">${ui.view === 'table' ? '📋 เปลี่ยนเป็นมุมมองรายการ' : '🃏 เปลี่ยนเป็นมุมมองโต๊ะ'}</button>
      ${me ? standButton(me) : `<button data-a="hostJoin">🙋 ให้เจ้ามือร่วมเล่นด้วย</button>`}
      <button data-a="goHome">🏠 กลับหน้าแรก (เก็บห้องไว้)</button>
      <button class="danger" data-a="endRoom">ปิดห้อง (ลบเกมนี้)</button>
    </div>`];
  }

  function handoffSheet() {
    const cands = S.players.filter((p) => p.id !== myId);
    const rows = cands.map((p) => `<button data-a="handoff" data-id="${esc(p.id)}" ${online.has(p.id) ? '' : 'disabled'}>
      <span class="dot ${online.has(p.id) ? 'on' : 'off'}"></span> ${esc(p.name)}${online.has(p.id) ? '' : ' (ออฟไลน์)'}</button>`).join('');
    return [`เปลี่ยน${hostWord()}`, `<p class="muted small" style="margin-top:0">มือถือของคนที่เลือกจะเป็นเครื่องหลักแทน (ข้อมูลเกมย้ายไปทั้งหมด เล่นต่อจากเดิมได้เลย) เครื่องนี้จะกลายเป็นผู้เล่นธรรมดา ทุกคนอยู่ห้อง ${esc(code)} เดิม</p>
      <div class="menu">${rows || '<p class="muted">ยังไม่มีผู้เล่นคนอื่น</p>'}</div>`];
  }

  function standButton(me) {
    if (isPD()) {
      return me.left
        ? `<button class="primary" data-a="cmd" data-c="stand" data-pid="${esc(me.id)}" data-v="">🪑 นั่งกลับ</button>`
        : `<button data-a="stand" data-pid="${esc(me.id)}">🚪 ลุกจากวง (ยอด ${signedFmt(me.net || 0)})</button>`;
    }
    return me.left
      ? `<button class="primary" data-a="cmd" data-c="stand" data-pid="${esc(me.id)}" data-v="">🪑 นั่งกลับ (${chipWord()} ${chips(me)})</button>`
      : `<button data-a="stand" data-pid="${esc(me.id)}">🚪 ลุกจากโต๊ะ (${credit() ? 'ยอด' : 'เก็บชิป'} ${chips(me)})</button>`;
  }

  function avatarSheet() {
    return ['รูปแทนตัว', `<p class="muted small" style="margin-top:0">แตะเพื่อเปลี่ยนได้ทันที · ไม่ใช้ = ตัวแรกของชื่อ</p>${emojiPicker()}`];
  }

  function ranksSheet() {
    const short = S && S.settings.game === 'short';
    return ['อันดับไพ่', `${short ? '<p class="tip" style="margin-top:0">Short Deck ต่างจากรูปนี้: <b>Flush ชนะ Full House</b> · <b>ตอง ชนะ Straight</b> · A-6-7-8-9 เป็น Straight ที่เล็กที่สุด</p>' : ''}<img class="ranks" src="img/hand-rankings.jpg?v=21" alt="อันดับไพ่โป๊กเกอร์ จาก Royal Flush ถึง High Card">`];
  }

  function inviteSheet() {
    return ['ชวนเพื่อน', `<div class="qr">${qrSvg(joinUrl())}</div><div class="bigcode">${esc(code)}</div>
      <div class="link">${esc(joinUrl())}</div>
      <div class="grid2" style="margin-top:12px"><button data-a="copy">คัดลอกลิงก์</button>${navigator.share ? '<button data-a="share">แชร์</button>' : ''}</div>`];
  }

  function settingsSheet() {
    const st = S.settings;
    if (isPD()) {
      return ['ตั้งค่าป๊อกเด้ง', `
        <label>เดิมพันตั้งต้น (บาท)</label><input id="s_pdbet" type="number" inputmode="numeric" value="${st.defaultBet || 10}">
        <p class="muted small">ใช้เป็นยอดเริ่มต้นตอนผู้เล่นวางเดิมพัน และเป็นฐานของปุ่มลัด (×1 ×2 ×5 ×10)</p>
        <button class="primary" style="width:100%;margin-top:14px" data-a="saveSettings">บันทึก</button>`];
    }
    const locked = S.handNo > 0;
    const midHand = S.hand && !S.hand.done;
    const levels = st.levels.map((l, i) => levelRow(l, i, st.mode === 'tournament' && S.levelStart != null && i === S.level)).join('');
    // label with a small ⓘ that opens its explanation underneath
    const lab = (text, k, tip) => `<label>${text} <button class="tipbtn" data-a="tip" data-k="${k}" aria-label="คำอธิบาย">ⓘ</button></label><p class="tip" id="tip_${k}" hidden>${tip}</p>`;
    const seg = (id, cur, opts, act) => `<div class="seg" ${id ? `id="${id}"` : ''}>${opts.map(([v, l]) => `<button class="${String(cur) === String(v) ? 'on' : ''}" data-a="${act}" data-v="${v}">${l}</button>`).join('')}</div>`;
    const timeRow = (inputId, val, presets, unit) => `<div class="row trow"><div class="seg">${presets.map(([v, l]) => `<button class="${Number(val) === v ? 'on' : ''}" data-a="fillNum" data-t="${inputId}" data-v="${v}">${l}</button>`).join('')}</div>
      <input id="${inputId}" type="number" inputmode="numeric" min="0" value="${val}" aria-label="${unit}"></div>`;
    return ['ตั้งค่า', `<div class="settings">
      ${lab('รูปแบบ', 'mode', 'Cash game: ซื้อชิป/Rebuy ได้ เล่นจนเลิก · Tournament: ชิปเท่ากัน Blind ขึ้นตามเวลา เล่นจนเหลือคนเดียว · เปลี่ยนไม่ได้หลังเริ่มเกม')}
      <select id="s_mode" ${locked ? 'disabled' : ''}><option value="cash" ${st.mode === 'cash' ? 'selected' : ''}>Cash game</option><option value="tournament" ${st.mode === 'tournament' ? 'selected' : ''}>Tournament</option></select>
      ${lab('เกม', 'game', "Texas Hold'em: No-Limit แจกคนละ 2 ใบ · Omaha (PLO): Pot-Limit แจกคนละ 4 ใบ ต้องใช้ไพ่ในมือ 2 ใบพอดี + ไพ่กลาง 3 ใบ Raise ได้สูงสุดเท่า Pot · Short Deck: Hold'em ที่เอาไพ่ 2–5 ออก (36 ใบ) Flush ชนะ Full House, ตอง ชนะ Straight, A-6-7-8-9 เป็น Straight · ห้องรับได้ Hold'em 22 / Omaha 11 / Short Deck 14 คน · เปลี่ยนได้หลังจบมือ")}
      <input type="hidden" id="s_game" value="${GAME_NAMES[st.game] ? st.game : 'nlh'}">
      ${seg('gameSeg', GAME_NAMES[st.game] ? st.game : 'nlh', [['nlh', "Hold'em"], ['plo', 'Omaha'], ['short', 'Short Deck']], 'gameType')}
      ${lab('ไพ่', 'cards', 'ใช้ไพ่จริง: แจกไพ่บนโต๊ะ เจ้ามือเลือกผู้ชนะเอง · แอปแจกไพ่ให้: สับแบบสุ่มเท่ากันทุกใบ แต่ละคนเห็นแค่ไพ่ตัวเองในมือถือ เปิดไพ่กลางและตัดสินผู้ชนะให้เอง (ต้องใช้ถ้ามีบอท) · เปลี่ยนได้หลังจบมือ')}
      <input type="hidden" id="s_cards" value="${st.appCards ? 1 : 0}">
      ${seg('cardsSeg', st.appCards ? 1 : 0, [[0, '🃏 ไพ่จริง'], [1, '📱 แอปแจกไพ่']], 'cardsMode')}
      ${lab('⏱ เวลาตัดสินใจ (วินาที)', 'actsec', 'ถึงตาแล้วนับถอยหลัง หมดเวลาแอป Check ให้ถ้า Check ได้ ไม่งั้น Fold · 0 = ไม่จำกัด')}
      ${timeRow('s_actsec', st.actSec || 0, [[0, 'ปิด'], [15, '15'], [30, '30'], [60, '60']], 'วิ')}
      ${lab('▶ เริ่มมือถัดไปเอง (วินาที)', 'autonext', 'จบมือแล้วนับถอยหลัง ถ้าเจ้ามือไม่ได้กดเริ่ม เกมเริ่มมือใหม่เอง · 0 = เจ้ามือกดเอง')}
      ${timeRow('s_autonext', st.autoNext || 0, [[0, 'ปิด'], [5, '5'], [10, '10'], [20, '20']], 'วิ')}
      <div id="buyInBox" ${st.mode === 'cash' ? '' : 'hidden'}>
        ${lab('Buy-in', 'credit', 'ซื้อชิปก่อนเล่น: ทุกคนเริ่มด้วยชิปเท่ากัน หมดแล้ว Rebuy · ไม่ต้อง buy-in: ทุกคนเริ่มที่ 0 ลงได้ไม่จำกัด ยอดติดลบได้ (ไม่มี All-in) จบเกมดูว่าใครโอนให้ใคร · เปลี่ยนไม่ได้หลังเริ่มเกม')}
        <input type="hidden" id="s_credit" value="${st.credit ? 1 : 0}">
        <div class="seg" id="creditSeg">${[[0, 'ซื้อชิปก่อน'], [1, 'ไม่ต้อง buy-in']].map(([v, l]) => `<button class="${(st.credit ? 1 : 0) === v ? 'on' : ''}" data-a="creditMode" data-v="${v}" ${locked ? 'disabled' : ''}>${l}</button>`).join('')}</div>
      </div>
      <div id="stackBox" ${st.mode === 'cash' && st.credit ? 'hidden' : ''}>${lab('ชิปเริ่มต้น', 'stack', 'ชิปที่แต่ละคนได้ตอนเริ่ม และต่อ 1 Rebuy · แก้ระหว่างเกมมีผลกับ Rebuy ครั้งต่อไป')}<input id="s_stack" type="number" inputmode="numeric" value="${st.startStack}"></div>
      <div id="cashBox" ${st.mode === 'cash' ? '' : 'hidden'}>
        ${lab('Blinds', 'blinds', 'SB / BB / Ante · ใส่ SB หรือ BB อย่างใดอย่างหนึ่ง อีกฝั่งคิดให้เอง (BB = 2 × SB) แก้ทับได้ · Ante = ทุกคนจ่ายก่อนแจกไพ่ ใส่ 0 = ไม่มี · เปลี่ยนแล้วมีผลตั้งแต่มือถัดไป')}
        <div class="grid3"><input id="s_sb" type="number" inputmode="numeric" value="${st.sb}" placeholder="SB" aria-label="SB"><input id="s_bb" type="number" inputmode="numeric" value="${st.bb}" placeholder="BB" aria-label="BB"><input id="s_ante" type="number" inputmode="numeric" value="${st.ante || 0}" placeholder="Ante" aria-label="Ante"></div>
        <div class="grid3 sub"><span>SB</span><span>BB</span><span>Ante</span></div>
        <div id="moneyBuyIn" ${st.credit ? 'hidden' : ''}>${lab('บาท / 1 buy-in', 'money', 'ใช้คิดเงินในหน้าสรุปว่าใครโอนให้ใคร · 0 = ไม่คิดเป็นเงิน')}<input id="s_money" type="number" inputmode="numeric" value="${st.buyInValue || 0}"></div>
        <div id="moneyCredit" ${st.credit ? '' : 'hidden'}>${lab('บาท / 1 ชิป', 'rate', 'ใช้คิดเงินในหน้าสรุปว่าใครโอนให้ใคร · 0 = ไม่คิดเป็นเงิน')}<input id="s_rate" type="number" inputmode="decimal" step="any" min="0" value="${st.chipBaht || 0}"></div>
      </div>
      <div id="tourBox" ${st.mode === 'tournament' ? '' : 'hidden'}>
        ${lab('โครงสร้าง Blind', 'levels', 'แต่ละ Level เล่นตามนาทีที่ตั้ง แล้ว Blind ขึ้นเอง · Ante ใส่ 0 = ไม่มี · พิมพ์ BB แล้ว SB เติมให้ครึ่งหนึ่ง')}
        <div class="lvhead"><span>Lv</span><span>SB</span><span>BB</span><span>Ante</span><span>นาที</span><span></span></div>
        <div id="lvRows">${levels}</div>
        <button class="ghost" style="width:100%;margin-top:8px" data-a="lvAdd">+ เพิ่ม Level</button>
        <div class="lvall"><span>ตั้งทุก Level เป็น</span><input id="lvAllMin" type="number" inputmode="numeric" value="${st.levels[0] ? st.levels[0].min : 3}"><span>นาที</span><button class="sm" data-a="lvAllMin">ใช้</button></div>
      </div>
      ${midHand ? '<p class="muted small center">เกม / แบบไพ่ เปลี่ยนได้หลังจบมือ</p>' : ''}</div>`,
      '<button class="primary sm" data-a="saveSettings">บันทึก</button>'];
  }

  function levelRow(l, i, current) {
    const f = (k, v) => `<input type="number" inputmode="numeric" min="0" data-k="${k}" value="${v}">`;
    return `<div class="lvrow${current ? ' cur' : ''}"><span class="lvn">${i + 1}</span>${f('sb', l.sb)}${f('bb', l.bb)}${f('ante', l.ante || 0)}${f('min', l.min)}
      <button class="lvdel" data-a="lvDel" aria-label="ลบ Level">✕</button></div>`;
  }

  function readLevels() {
    return [...document.querySelectorAll('#lvRows .lvrow')].map((r) => {
      const v = (k) => Math.max(0, Math.floor(Number(r.querySelector(`[data-k=${k}]`).value) || 0));
      return { sb: v('sb'), bb: v('bb'), ante: v('ante'), min: v('min') };
    });
  }

  function renumberLevels() {
    document.querySelectorAll('#lvRows .lvn').forEach((el, i) => { el.textContent = i + 1; });
  }

  // round a blind to a number people actually use at the table
  function niceBlind(x) {
    const step = x >= 2000 ? 500 : x >= 1000 ? 100 : x >= 200 ? 50 : x >= 50 ? 10 : 5;
    return Math.max(step, Math.round(x / step) * step);
  }

  function playersSheet() {
    if (isPD()) return pdPlayersSheet();
    const rows = S.players.map((p, i) => {
      const busy = E.inHand(S, p.id);
      return `<div class="prow"><div class="top"><b>${i + 1}. ${esc(p.name)}${p.id === myId ? ' (คุณ)' : ''}${p.left ? ' <span class="muted small">· ลุกแล้ว</span>' : ''}</b><span class="${credit() ? toneOf(balance(p)) : ''}">${chips(p)}${credit() ? '' : ` <span class="muted small">· buy-in ${p.buyIns}</span>`}</span></div>
      <div class="acts">
        <button class="sm" data-a="cmd" data-c="move" data-pid="${esc(p.id)}" data-d="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="sm" data-a="cmd" data-c="move" data-pid="${esc(p.id)}" data-d="1" ${i === S.players.length - 1 ? 'disabled' : ''}>↓</button>
        ${credit() ? '' : `<button class="sm" data-a="cmd" data-c="rebuy" data-pid="${esc(p.id)}" ${busy ? 'disabled' : ''}>Rebuy</button>`}
        <button class="sm" data-a="setStack" data-pid="${esc(p.id)}" ${busy ? 'disabled' : ''}>แก้${chipWord()}</button>
        <button class="sm" data-a="cmd" data-c="sitout" data-pid="${esc(p.id)}" data-v="${p.sitOut ? '' : '1'}" ${p.left ? 'disabled' : ''}>${p.sitOut ? 'กลับมาเล่น' : 'พัก'}</button>
        ${p.left ? `<button class="sm primary" data-a="cmd" data-c="stand" data-pid="${esc(p.id)}" data-v="">นั่งกลับ</button>`
          : `<button class="sm" data-a="stand" data-pid="${esc(p.id)}">ลุก</button>`}
        <button class="sm danger" data-a="remove" data-pid="${esc(p.id)}" ${busy ? 'disabled' : ''}>ลบ</button>
      </div></div>`;
    }).join('');
    return ['ผู้เล่น', `<button style="width:100%;margin-bottom:10px" data-a="cmd" data-c="addBot">🤖 เพิ่มบอท</button><p class="muted small" style="margin-top:0">บอทเล่นเองในโหมดแอปแจกไพ่ · ลำดับในรายการ = ลำดับที่นั่งเวียนตามเข็มนาฬิกา · ${credit() ? 'แก้ยอด/ลบ' : 'แก้ชิป/Rebuy/ลบ'} ได้เมื่อคนนั้นไม่ได้อยู่ในมือที่กำลังเล่น</p>${rows}`];
  }

  // Fewest transfers that settle everyone: biggest loser pays biggest winner first.
  function settle(list) {
    const cred = list.filter((x) => x.amt > 0).map((x) => ({ name: x.name, amt: x.amt })).sort((a, b) => b.amt - a.amt);
    const debt = list.filter((x) => x.amt < 0).map((x) => ({ name: x.name, amt: -x.amt })).sort((a, b) => b.amt - a.amt);
    const out = [];
    let i = 0, j = 0;
    while (i < debt.length && j < cred.length) {
      const a = Math.min(debt[i].amt, cred[j].amt);
      if (a > 0) out.push({ from: debt[i].name, to: cred[j].name, amt: a });
      debt[i].amt -= a; cred[j].amt -= a;
      if (!debt[i].amt) i++;
      if (!cred[j].amt) j++;
    }
    return out;
  }

  function transfersHtml(owed, unit) {
    const tx = settle(owed);
    return tx.length ? tx.map((t) => `<div class="tx"><span>${esc(t.from)}</span><span class="arrow">→</span><span>${esc(t.to)}</span><b>${fmt(t.amt)} ${unit}</b></div>`).join('')
      : `<p class="muted small">${owed.some((o) => o.amt) ? 'คำนวณการโอนไม่ได้ เพราะยอดรวมไม่ลงตัว (ดูหมายเหตุด้านล่าง)' : 'ยังไม่มีใครได้หรือเสีย'}</p>`;
  }

  // no buy-in: everyone started at 0, so the balance is the profit/loss
  function creditSummary() {
    const rate = S.settings.chipBaht || 0;
    const baht = (n) => Math.round(n * rate);
    const data = S.players.map((p) => ({ p, net: balance(p) })).sort((a, b) => b.net - a.net);
    const rows = data.map(({ p, net }) => `<tr><td>${esc(p.name)}${p.left ? ' 🚪' : ''}</td>
      <td class="${toneOf(net)}"><b>${signedFmt(net)}</b></td>${rate ? `<td class="${toneOf(net)}">${signedFmt(baht(net))}</td>` : ''}</tr>`).join('');
    const inPot = S.hand && !S.hand.done ? E.potTotal(S.hand) : 0;
    const sum = data.reduce((a, x) => a + x.net, 0) + inPot;
    const totals = `<tr class="total"><td>รวมทั้งโต๊ะ${inPot ? `<div class="sub">+ ใน pot ${fmt(inPot)}</div>` : ''}</td>
      <td class="${toneOf(sum)}">${sum ? signedFmt(sum) : '✓ ลงตัว'}</td>${rate ? '<td></td>' : ''}</tr>`;
    const owed = data.map(({ p, net }) => ({ name: p.name, amt: rate ? baht(net) : net }));
    const unit = rate ? 'บาท' : 'ชิป';
    const off = inPot ? 0 : owed.reduce((a, o) => a + o.amt, 0);
    return ['สรุปประจำโต๊ะ', `<p class="muted small" style="margin-top:0">ไม่ต้อง buy-in · ทุกคนเริ่มที่ 0 แล้วได้/เสียตามที่เล่น</p>
      <table class="summary"><tr><th>ผู้เล่น</th><th>ได้/เสีย (ชิป)</th>${rate ? '<th>บาท</th>' : ''}</tr>${rows}${totals}</table>
      <h2 style="margin:16px 0 6px">💸 ใครโอนให้ใคร</h2>${transfersHtml(owed, unit)}
      ${off ? `<p class="muted small">* ยอดรวมไม่ลงตัว ${off > 0 ? '+' : ''}${fmt(off)} ${unit} (มีการแก้ยอด${rate ? ' หรือปัดเศษ' : ''})</p>` : ''}
      ${inPot ? '<p class="muted small">* มือนี้ยังไม่จบ ชิปที่อยู่ใน pot ยังไม่ถูกนับ</p>' : ''}
      ${rate ? '' : '<p class="muted small">ตั้ง "1 ชิป = กี่บาท" ในตั้งค่า เพื่อให้คำนวณเป็นบาท</p>'}`];
  }

  function summarySheet() {
    const st = S.settings;
    if (isPD()) return pdSummarySheet();
    if (st.mode === 'tournament') {
      const alive = S.players.filter((p) => !p.out).sort((a, b) => b.stack - a.stack);
      const outs = S.finishOrder.slice().reverse().map(pById).filter(Boolean);
      const rows = alive.concat(outs).map((p, i) => `<tr><td>${i + 1}. ${esc(p.name)}</td><td>${p.out ? 'ตกรอบ' : fmt(p.stack)}</td></tr>`).join('');
      return ['อันดับ', `<table><tr><th>ผู้เล่น</th><th>ชิป</th></tr>${rows}</table>`];
    }
    if (credit()) return creditSummary();
    const money = st.buyInValue > 0;
    const baht = (chips) => Math.round(chips / st.startStack * st.buyInValue);
    const signed = (n) => `${n > 0 ? '+' : ''}${fmt(n)}`;
    const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
    const data = S.players.map((p) => {
      const inn = E.invested(S, p);
      // money in/out are rounded separately so each row's profit is exactly out − in
      return { p, inn, out: p.stack, net: p.stack - inn, cash: money ? baht(p.stack) - baht(inn) : 0 };
    }).sort((a, b) => b.net - a.net);
    const cell = (chips, b) => `${fmt(chips)}${money ? `<div class="sub">${fmt(b)} บาท</div>` : ''}`;
    const rows = data.map(({ p, inn, out, net, cash }) => `<tr>
      <td>${esc(p.name)}${p.left ? ' 🚪' : ''}<div class="sub">ซื้อ ${p.buyIns} ครั้ง${p.left ? ' · ลุกแล้ว' : ''}</div></td>
      <td>${cell(inn, baht(inn))}</td>
      <td>${cell(out, baht(out))}</td>
      <td class="${tone(net)}"><b>${signed(net)}</b>${money ? `<div class="sub ${tone(cash)}">${signed(cash)} บาท</div>` : ''}</td></tr>`).join('');
    const tIn = data.reduce((a, x) => a + x.inn, 0);
    const tOut = data.reduce((a, x) => a + x.out, 0);
    const inPot = S.hand && !S.hand.done ? E.potTotal(S.hand) : 0;
    const totals = `<tr class="total"><td>รวมทั้งโต๊ะ${inPot ? `<div class="sub">+ ใน pot ${fmt(inPot)}</div>` : ''}</td>
      <td>${cell(tIn, data.reduce((a, x) => a + baht(x.inn), 0))}</td>
      <td>${cell(tOut, data.reduce((a, x) => a + baht(x.out), 0))}</td>
      <td class="${tone(tOut + inPot - tIn)}">${tOut + inPot === tIn ? '✓ ลงตัว' : signed(tOut + inPot - tIn)}</td></tr>`;
    const owed = data.map(({ p, net, cash }) => ({ name: p.name, amt: money ? cash : net }));
    const unit = money ? 'บาท' : 'ชิป';
    const off = owed.reduce((a, o) => a + o.amt, 0);
    const txHtml = transfersHtml(owed, unit);
    return ['สรุปประจำโต๊ะ', `<table class="summary"><tr><th>ผู้เล่น</th><th>เข้า</th><th>ออก</th><th>กำไร/ขาดทุน</th></tr>${rows}${totals}</table>
      <p class="muted small" style="margin:6px 0 0">เข้า = ชิปที่ซื้อทั้งหมด (รวม Rebuy) · ออก = ชิปที่ถืออยู่ตอนนี้ หรือตอนลุกจากโต๊ะ</p>
      <h2 style="margin:16px 0 6px">💸 ใครโอนให้ใคร</h2>${txHtml}
      ${off ? `<p class="muted small">* ยอดรวมไม่ลงตัว ${off > 0 ? '+' : ''}${fmt(off)} ${unit} (ชิปบนโต๊ะไม่ตรงกับยอด buy-in เช่น มีการแก้ชิป${money ? ' หรือปัดเศษ' : ''})</p>` : ''}
      ${S.hand && !S.hand.done ? '<p class="muted small">* มือนี้ยังไม่จบ ชิปที่อยู่ใน pot ยังไม่ถูกนับ</p>' : ''}
      ${money ? '' : '<p class="muted small">ตั้ง "มูลค่าเงินต่อ 1 buy-in" ในตั้งค่า เพื่อให้คำนวณเป็นบาท</p>'}`];
  }

  // every action of a hand, one line per street
  function actionLines(h, nm) {
    return E.STREETS.slice(0, 4).map((st) => {
      const acts = h.actions.filter((a) => a.st === st);
      if (!acts.length) return '';
      return `<div class="hst"><b>${E.streetName(st)}</b> ${acts.map((a) => `${a.id ? nm(a.id) + ' ' : 'ทุกคน '}${esc(a.t)}${a.at ? ` <span class="tm">${clockAt(a.at)}</span>` : ''}`).join(' · ')}</div>`;
    }).join('');
  }

  function handsSheet() {
    if (isPD()) return pdRoundsSheet();
    const hs = (S.history || []).slice().reverse();
    const cur = S.hand && !S.hand.done ? S.hand : null;
    const live = cur ? `<details class="hand" open><summary><b>มือที่ ${cur.no}</b>${cur.actions[0] && cur.actions[0].at ? ` <span class="tm">${clockAt(cur.actions[0].at)}</span>` : ''} · <span class="gold">กำลังเล่น (${E.streetName(cur.street)})</span></summary>
        <div class="muted small">Blinds ${fmt(cur.blinds.sb)}/${fmt(cur.blinds.bb)}${cur.blinds.ante ? ` ante ${fmt(cur.blinds.ante)}` : ''} · Dealer ${esc((pById(cur.btn) || {}).name || '?')} · Pot ${fmt(E.potTotal(cur))}</div>
        ${cur.appCards && cur.board && cur.board.length ? `<div class="hst"><b>Board</b> ${cardsHtml(cur.board, 'sm')}</div>` : ''}
        ${actionLines(cur, (id) => esc((pById(id) || {}).name || '?'))}</details>` : '';
    const signed = (n) => `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted'}">${n > 0 ? '+' : ''}${fmt(n)}</span>`;
    const items = hs.map((h, i) => {
      const nm = (id) => esc(h.names[id] || (pById(id) || {}).name || '?');
      const winners = h.ids.filter((id) => h.delta[id] > 0).map((id) => `${nm(id)} ${signed(h.delta[id])}`).join(', ');
      const mine = h.delta[myId] != null ? ` · คุณ ${signed(h.delta[myId])}` : '';
      const streets = actionLines(h, nm);
      const pots = h.pots.map((p, j) => `${h.pots.length > 1 ? (j ? `Side ${j}` : 'Main') : 'Pot'} ${fmt(p.amount)} → ${p.winners.map(nm).join(' + ')}`).join(' · ');
      const ended = h.street === 'showdown' ? (h.runout ? 'All-in showdown' : 'Showdown') : `จบที่ ${E.streetName(h.street)} (คนอื่น Fold)`;
      const deltas = h.ids.slice().sort((a, b) => h.delta[b] - h.delta[a]).map((id) => `<span>${nm(id)} ${signed(h.delta[id])}</span>`).join('');
      return `<details class="hand" ${i === 0 && !cur ? 'open' : ''}><summary><b>มือที่ ${h.no}</b>${h.actions[0] && h.actions[0].at ? ` <span class="tm">${clockAt(h.actions[0].at)}</span>` : ''} · ${winners || '-'}${mine}</summary>
        <div class="muted small">Blinds ${fmt(h.blinds.sb)}/${fmt(h.blinds.bb)}${h.blinds.ante ? ` ante ${fmt(h.blinds.ante)}` : ''} · Dealer ${nm(h.btn)} · ${ended}</div>
        ${h.board ? `<div class="hst"><b>Board</b> ${h.board.length ? cardsHtml(h.board, 'sm') : '-'}</div>` : ''}
        ${h.shown ? Object.entries(h.shown).map(([id, x]) => `<div class="hst">${nm(id)} ${cardsHtml(x.cards, 'sm')} ${esc(x.hand)}</div>`).join('') : ''}
        ${streets}<div class="hst"><b>ผล</b> ${pots}</div><div class="hdelta">${deltas}</div></details>`;
    }).join('');
    return ['ประวัติรายมือ', `${live}${items || (cur ? '' : '<p class="muted">ยังไม่มีมือที่จบ</p>')}
      <p class="center small" style="margin-top:12px"><u data-a="sheet" data-v="log">ดูบันทึกเหตุการณ์ทั้งหมด</u> <span class="muted">· เก็บ 30 มือล่าสุด</span></p>`];
  }

  function logSheet() {
    return ['ประวัติ', `<div class="log">${S.log.slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('')}</div>`];
  }

  function qrSvg(text) {
    try { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
    catch (e) { return ''; }
  }

  // ---------- timer ----------
  function updateTimer() {
    const el = document.getElementById('timer');
    if (!el || !S) return;
    if (isHost()) {
      const lv = S.level; E.tick(S, Date.now());
      if (S.level !== lv) { saveHost(); broadcast(); return render(); }
    }
    const pre = S.levelStart != null && S.pausedAt != null ? '⏸ ' : '';
    if (S.settings.mode === 'cash') {
      const left = E.sessionRemainingMs(S, now());
      const up = left != null && left <= 0;
      if (up && !ui.timeUp) {
        toast('⏰ หมดเวลาเล่นแล้ว — จบมือนี้แล้วดูสรุปการโอน', true);
        try { navigator.vibrate && navigator.vibrate([300, 100, 300]); } catch (e) { /* ignore */ }
        Sfx.play('alarm');
      }
      const changed = up !== !!ui.timeUp;
      ui.timeUp = up;
      if (changed) return render();
      el.textContent = up ? '⏰ หมดเวลา' : '⏰ ' + pre + clockText(left == null ? S.settings.sessionMin * 60000 : left);
      el.classList.toggle('over', up);
      return;
    }
    el.textContent = pre + clockText(E.levelRemainingMs(S, now()));
  }

  function clockText(ms) {
    const t = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(t / 3600); const m = Math.floor(t / 60) % 60; const sec = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }
  setInterval(updateTimer, 1000);

  // ---------- events ----------
  let createMode = 'cash';

  document.addEventListener('input', (e) => {
    if (e.target.id === 'raiseRange') { ui.raiseTo = Number(e.target.value); syncRaise(); }
    if (e.target.id === 'raiseInput') { ui.raiseTo = Math.floor(Number(e.target.value) || 0); syncRaise(true); }
    if (e.target.id === 'pdBetInput') { ui.pdDraft = e.target.value; syncPdBet(); }
    if (e.target.id === 'emojiIn') { const v = cleanEmoji(e.target.value); e.target.classList.toggle('on', !!v); setEmoji(v); }
    const k = e.target.dataset && e.target.dataset.k;
    // blinds: type one side and the other is worked out (BB = 2 × SB); the other can still be overwritten
    const twin = (id, val) => { const o = document.getElementById(id); if (o) o.value = val; };
    if (e.target.id === 's_sb') twin('s_bb', (Math.floor(Number(e.target.value)) || 0) * 2);
    if (e.target.id === 's_bb') twin('s_sb', Math.floor((Number(e.target.value) || 0) / 2));
    if (k === 'sb' || k === 'bb') {
      const row = e.target.closest('.lvrow');
      if (k === 'sb') row.querySelector('[data-k=bb]').value = (Math.floor(Number(e.target.value)) || 0) * 2;
      else row.querySelector('[data-k=sb]').value = Math.floor((Number(e.target.value) || 0) / 2);
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 's_mode') {
      document.getElementById('cashBox').hidden = e.target.value !== 'cash';
      document.getElementById('buyInBox').hidden = e.target.value !== 'cash';
      document.getElementById('tourBox').hidden = e.target.value !== 'tournament';
      markCredit();
    }
  });

  // settings sheet: show the fields that apply to buy-in or no-buy-in cash games
  function markCredit() {
    const v = Number(document.getElementById('s_credit').value);
    const on = v === 1 && document.getElementById('s_mode').value === 'cash';
    document.querySelectorAll('#creditSeg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === v));
    document.getElementById('stackBox').hidden = on;
    document.getElementById('moneyBuyIn').hidden = on;
    document.getElementById('moneyCredit').hidden = !on;
  }

  // highlight the preset matching the minutes box (none for a custom value)

  // typing: leave the input alone so the cursor doesn't jump while the user types
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'raiseInput' && e.key === 'Enter') { e.preventDefault(); const g = document.getElementById('raiseGo'); if (!g.disabled) g.click(); }
  });
  document.addEventListener('focusin', (e) => { if (e.target.id === 'raiseInput') e.target.select(); });

  function syncRaise(typing) {
    const inp = document.getElementById('raiseInput');
    if (!inp) return;
    if (!typing) inp.value = ui.raiseTo;
    const r = document.getElementById('raiseRange'); if (r && Number(r.value) !== ui.raiseTo) r.value = ui.raiseTo;
    const ok = ui.raiseTo >= Number(inp.min) && ui.raiseTo <= Number(inp.max);
    inp.classList.toggle('bad', !ok);
    document.getElementById('raiseHint').classList.toggle('bad', !ok);
    const g = document.getElementById('raiseGo');
    g.disabled = !ok;
    g.textContent = g.textContent.replace(/[\d,]*$/, ok ? fmt(ui.raiseTo) : '');
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el) return;
    if (el.dataset.a === 'closeSheet' && e.target.closest('[data-stop]') && !e.target.closest('button')) return;
    const d = el.dataset;
    switch (d.a) {
      case 'mode':
        createMode = d.v;
        document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === createMode));
        break;
      case 'create': {
        if (!readName()) return;
        const g = E.newGame({ mode: createMode });
        if (document.getElementById('plays').checked) { E.addPlayer(g, myId, myName); g.players[g.players.length - 1].emoji = myEmoji; }
        if (createMode === 'pokdeng') PD.init(g);
        startHost(Net.randomCode(), g, [], false);
        ui.sheet = 'settings'; render();
        break;
      }
      case 'resume': {
        if (!readName(true)) return;
        const saved = store.get(hostKey(d.code), null);
        if (!saved) return toast('ไม่พบข้อมูลห้องนี้ในเครื่อง');
        startHost(saved.code, saved.S, saved.hist || [], true, saved.secrets);
        break;
      }
      case 'joinRoom':
        if (!readName()) return;
        startClient(d.code);
        break;
      case 'forgetRoom': {
        const mine = store.get(hostKey(d.code), null);
        if (!confirm(mine ? `ลบห้อง ${d.code}? เกมที่บันทึกไว้ในเครื่องนี้จะหายไป` : `ลบห้อง ${d.code} ออกจากรายการ?`)) return;
        forgetRoom(d.code); roomsChecked = false; renderHome();
        break;
      }
      case 'goHome':
        if (!confirm('กลับหน้าแรก? ห้องยังบันทึกไว้ แต่ระหว่างนี้คนอื่นจะเล่นต่อไม่ได้จนกว่าคุณจะกด "เปิดต่อ" (หรือมีคนรับเป็นเจ้ามือแทน)')) return;
        saveHost(); net && net.destroy(); location.href = location.pathname + (params.get('pid') ? '?pid=' + params.get('pid') : '');
        break;
      case 'join': {
        if (!readName()) return;
        const c = (document.getElementById('code').value || '').trim().toUpperCase();
        if (c.length < 4) return toast('ใส่รหัสห้อง');
        startClient(c);
        break;
      }
      case 'rejoin': kicked = false; S = null; net.destroy(); startClient(code, { rejoin: true }); break;
      case 'leave':
        if (!confirm('ออกจากห้อง? (ถ้ากำลังเล่นอยู่ จะ Fold ให้แล้วลุกจากโต๊ะ)')) return;
        if (S && pById(myId) && !pById(myId).left) send({ c: 'leaveSeat', pid: myId });
        setTimeout(() => { net && net.destroy(); location.href = location.pathname + (params.get('pid') ? '?pid=' + params.get('pid') : ''); }, 400);
        break;
      case 'endRoom':
        if (!confirm('ปิดห้องและลบเกมนี้? (กู้คืนไม่ได้)')) return;
        forgetRoom(code); net && net.destroy(); location.href = location.pathname + (params.get('pid') ? '?pid=' + params.get('pid') : '');
        break;
      case 'sheet': ui.sheet = d.v; render(); break;
      case 'closeSheet': ui.sheet = null; render(); break;
      case 'cmd': {
        const cmd = { c: d.c };
        if (d.pid) cmd.pid = d.pid;
        if (d.v !== undefined) cmd.v = !!d.v;
        if (d.d) { cmd.dir = Number(d.d); cmd.d = Number(d.d); }
        if (d.c === 'start' || d.c === 'undo') ui.sheet = null;
        send(cmd);
        break;
      }
      case 'act': {
        const id = actorId(); if (!id) return;
        const cmd = { c: 'act', pid: id, type: d.t, seq: S.seq || 0 };
        if (d.t === 'raise') cmd.amount = ui.raiseTo;
        if (d.t === 'fold' && S.hand.currentBet - (S.hand.bets[id] || 0) === 0 && !confirm('Check ได้ฟรี — ยืนยันจะ Fold?')) return;
        ui.raiseOpen = false; ui.raiseTo = 0;
        if (id !== myId) ui.proxy = false;
        send(cmd);
        break;
      }
      case 'raiseToggle': ui.raiseOpen = !ui.raiseOpen; render(); break;
      case 'pre':
        ui.pre = ui.pre && ui.pre.t === d.t ? null : { t: d.t, amt: Number(d.v) || 0, no: S.hand && S.hand.no };
        render();
        break;
      case 'quick': ui.raiseTo = Number(d.v); syncRaise(); break;
      case 'step': {
        const a = actorInfo(actorId());
        ui.raiseTo = Math.max(a.minTo, Math.min(a.maxTo, ui.raiseTo + Number(d.v)));
        syncRaise(); break;
      }
      case 'proxy': ui.proxy = !ui.proxy; render(); break;
      case 'sd': {
        const i = Number(d.i); const id = d.id;
        const cur = ui.sd[i];
        ui.sd[i] = cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id);
        // whoever wins a pot also wins every smaller side pot they're eligible for
        const pots = S.hand.pots;
        for (let j = i + 1; j < pots.length; j++) {
          const w = ui.sd[i].filter((x) => pots[j].elig.includes(x));
          if (w.length) ui.sd[j] = w;
        }
        render(); break;
      }
      case 'award': send({ c: 'award', winners: ui.sd }); break;
      case 'setStack': {
        const p = pById(d.pid);
        if (credit()) {
          const v = prompt(`ยอดได้/เสียของ ${p.name} (ติดลบ = เสีย)`, balance(p));
          if (v != null && v !== '' && !isNaN(Number(v)) && Number(v) !== balance(p)) send({ c: 'stack', pid: d.pid, v: Number(v) });
          break;
        }
        const v = prompt(`ชิปของ ${p.name}`, p.stack);
        if (v == null || v === '' || Number(v) === p.stack) break;
        // in cash games the settlement needs to know whether money changed hands
        const asBuyIn = S.settings.mode === 'cash' && confirm(`นับเป็นการซื้อชิปเพิ่ม / คืนชิป (มีผลกับยอดเงินตอนสรุป) ใช่ไหม?\n\nตกลง = ซื้อ/คืนชิป\nยกเลิก = แค่แก้ยอดที่นับผิด`);
        send({ c: 'stack', pid: d.pid, v: Number(v), asBuyIn });
        break;
      }
      case 'remove': {
        const p = pById(d.pid);
        if (confirm(`ลบ ${p.name} ออกจากโต๊ะ?`)) send({ c: 'remove', pid: d.pid });
        break;
      }
      case 'rename': {
        const v = prompt('ชื่อใหม่', myName);
        if (v && v.trim()) { myName = v.trim().slice(0, NAME_MAX); store.set('pk:name', myName); send({ c: 'rename', pid: myId, name: myName }); }
        break;
      }
      case 'stand': {
        const p = pById(d.pid);
        const who = p.id === myId ? 'คุณ' : p.name;
        const msg = isPD() ? `${who}จะลุกจากวง? (ยอด ${signedFmt(p.net || 0)} ยังเก็บไว้ในสรุป)` : `${who}จะลุกจากโต๊ะพร้อม${chipWord()} ${chips(p)}?\nไม่ถูกแจกไพ่จนกว่าจะกด "นั่งกลับ"`;
        if (confirm(msg)) { ui.sheet = null; send({ c: 'stand', pid: d.pid, v: true }); }
        break;
      }
      case 'pdQuick': ui.pdDraft = d.v; { const i = document.getElementById('pdBetInput'); if (i) i.value = d.v; } syncPdBet(); break;
      case 'pdBetGo': {
        const v = Math.floor(Number(ui.pdDraft != null ? ui.pdDraft : document.getElementById('pdBetInput').value) || 0);
        ui.pdDraft = null;
        send({ c: 'pdBet', pid: myId, amount: v });
        break;
      }
      case 'pdSkip': ui.pdDraft = null; send({ c: 'pdBet', pid: myId, amount: 0 }); break;
      case 'pdBetFor': {
        const p = pById(d.pid);
        const v = prompt(`เดิมพันของ ${p.name} (0 = ไม่ลง)`, (S.pd.round.bets[p.id] || S.settings.defaultBet || 10));
        if (v != null && v !== '') send({ c: 'pdBet', pid: d.pid, amount: Number(v) });
        break;
      }
      case 'pdRes': {
        const cur = ui.pdRes[d.pid] || { m: 1 };
        if (d.r) cur.r = d.r;
        if (d.m) { cur.m = Number(d.m); if (!cur.r || cur.r === 'tie') cur.r = cur.r || 'win'; }
        ui.pdRes[d.pid] = cur; render();
        break;
      }
      case 'pdAll':
        Object.keys(S.pd.round.bets).forEach((id) => { ui.pdRes[id] = { r: d.r, m: (ui.pdRes[id] && ui.pdRes[id].m) || 1 }; });
        render(); break;
      case 'pdSettle': send({ c: 'pdSettle', results: ui.pdRes }); break;
      case 'pdNet': {
        const p = pById(d.pid);
        const v = prompt(`ยอดได้/เสียของ ${p.name} (ติดลบ = เสีย)`, p.net || 0);
        if (v != null && v !== '' && !isNaN(Number(v))) send({ c: 'pdNet', pid: d.pid, v: Number(v) });
        break;
      }
      case 'pdBanker':
        if (confirm(`ให้ ${pById(d.pid).name} เป็นเจ้ามือป๊อกเด้ง?`)) { ui.sheet = null; send({ c: 'pdBanker', pid: d.pid }); }
        break;
      case 'handoff': {
        const p = pById(d.id);
        if (handoffTimer) return toast('กำลังส่งต่ออยู่…');
        if (confirm(`ให้ ${p.name} เป็นเจ้ามือแทน?`)) { ui.sheet = null; handoff(d.id); render(); }
        break;
      }
      case 'takeover':
        if (!confirm('รับเป็นเจ้ามือแทนเลย? มือถือเครื่องนี้ต้องเปิดแอปค้างไว้ตลอดเกม')) return;
        takeOver(false);
        break;
      case 'fillNum':
        document.getElementById(d.t).value = d.v;
        el.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
        break;
      case 'tip': { const t = document.getElementById('tip_' + d.k); if (t) t.hidden = !t.hidden; break; }
      case 'gameType':
        document.getElementById('s_game').value = d.v;
        document.querySelectorAll('#gameSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === d.v));
        break;
      case 'cardsMode':
        document.getElementById('s_cards').value = d.v;
        document.querySelectorAll('#cardsSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === d.v));
        break;
      case 'mute': Sfx.setMuted(!Sfx.isMuted()); render(); break;
      case 'randName': {
        const i = document.getElementById('name');
        const pool = RANDOM_NAMES.filter((n) => n !== i.value.trim());
        i.value = pool[Math.floor(Math.random() * pool.length)];
        el.classList.remove('roll'); void el.offsetWidth; el.classList.add('roll');
        break;
      }
      case 'pickEmoji': { const i = document.getElementById('emojiIn'); if (i) { i.value = ''; i.classList.remove('on'); } setEmoji(d.v); break; }
      case 'view': ui.view = d.v; store.set('pk:view', d.v); ui.sheet = null; render(); break;
      case 'holeHide': ui.holeHidden = !ui.holeHidden; render(); break;
      case 'creditMode': document.getElementById('s_credit').value = d.v; markCredit(); break;
      case 'hostJoin': send({ c: 'join' }); ui.sheet = null; break;
      case 'saveSettings': saveSettings(); break;
      case 'lvAdd': {
        const lv = readLevels(); const last = lv[lv.length - 1] || { sb: 5, bb: 10, ante: 0, min: 3 };
        const bb = lv.length ? niceBlind(last.bb * 1.5) : 20;
        const box = document.getElementById('lvRows');
        box.insertAdjacentHTML('beforeend', levelRow({ sb: bb / 2, bb, ante: last.ante, min: last.min }, lv.length, false));
        box.lastElementChild.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'lvDel':
        if (document.querySelectorAll('#lvRows .lvrow').length <= 1) return toast('ต้องมีอย่างน้อย 1 Level');
        el.closest('.lvrow').remove(); renumberLevels();
        break;
      case 'lvAllMin': {
        const m = Math.max(1, Math.floor(Number(document.getElementById('lvAllMin').value) || 0));
        document.querySelectorAll('#lvRows [data-k=min]').forEach((i) => { i.value = m; });
        toast(`ตั้งทุก Level เป็น ${m} นาทีแล้ว (กดบันทึก)`, true);
        break;
      }
      case 'copy':
        (navigator.clipboard ? navigator.clipboard.writeText(joinUrl()) : Promise.reject()).then(() => toast('คัดลอกแล้ว', true), () => prompt('คัดลอกลิงก์นี้', joinUrl()));
        break;
      case 'share': navigator.share({ title: 'Kapoke Chip', text: `เข้าห้องโป๊กเกอร์ ${code}`, url: joinUrl() }).catch(() => {}); break;
      default: break;
    }
  });

  function readName(optional) {
    const el = document.getElementById('name');
    const v = (el && el.value || '').trim().slice(0, NAME_MAX);
    if (!v && !optional) { toast('ใส่ชื่อก่อน'); el && el.focus(); return false; }
    if (v) { myName = v; store.set('pk:name', v); }
    return true;
  }

  function saveSettings() {
    const num = (id) => Math.max(0, Math.floor(Number(document.getElementById(id).value) || 0));
    if (isPD()) {
      send({ c: 'settings', settings: { defaultBet: num('s_pdbet') || 10 } });
      ui.sheet = null; return render();
    }
    const mode = document.getElementById('s_mode').value;
    const settings = { mode, startStack: num('s_stack') || 1000, appCards: document.getElementById('s_cards').value === '1', game: document.getElementById('s_game').value,
      actSec: Math.min(600, num('s_actsec')), autoNext: Math.min(600, num('s_autonext')) };
    if (mode === 'cash') {
      Object.assign(settings, { sb: num('s_sb'), bb: num('s_bb'), ante: num('s_ante'), buyInValue: num('s_money'), sessionMin: 0,
        credit: document.getElementById('s_credit').value === '1', chipBaht: Math.max(0, Number(document.getElementById('s_rate').value) || 0) });
      if (!settings.bb || settings.sb > settings.bb) return toast('Blind ไม่ถูกต้อง');
    } else {
      const levels = readLevels();
      if (!levels.length) return toast('ต้องมีอย่างน้อย 1 Level');
      const bad = levels.findIndex((x) => !x.bb || !x.min || x.sb > x.bb);
      if (bad >= 0) return toast(`Level ${bad + 1}: ใส่ BB และนาทีให้ครบ (SB ต้องไม่เกิน BB)`);
      settings.levels = levels;
    }
    send({ c: 'settings', settings });
    ui.sheet = null; render();
  }

  // keep the screen on and reconnect quickly when the phone wakes up
  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && role) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); if (role === 'client' && net) net.poke(); }
  });
  document.addEventListener('click', () => { if (!wakeLock && role) keepAwake(); }, { once: false, passive: true });

  window.addEventListener('beforeunload', (e) => { if (isHost() && S && S.players.length > 1) { e.preventDefault(); e.returnValue = ''; } });

  render();
})();
