// UI + host/client glue. The host applies every command to the game state and
// broadcasts the whole state; clients only render it and send commands.
(function () {
  'use strict';
  const E = window.Engine;
  const $app = document.getElementById('app');
  const params = new URLSearchParams(location.search);

  // ---------- identity / storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  // ?pid= lets several tabs on one device be different players (testing)
  const myId = params.get('pid') || store.get('pk:id') || (() => { const id = rid(); store.set('pk:id', id); return id; })();
  let myName = store.get('pk:name', '');

  // ---------- app state ----------
  let role = null;        // 'host' | 'client'
  let code = null;
  let S = null;           // game state
  let online = new Set(); // client ids connected to the host
  let netStatus = 'offline';
  let net = null;
  let hist = [];          // host: undo snapshots
  let clockSkew = 0;      // client: host time - local time
  let kicked = false;
  const ui = { raiseOpen: false, raiseTo: 0, sheet: null, proxy: false, sd: null, sdHand: 0, wasMyTurn: false };

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pById = (id) => S && S.players.find((p) => p.id === id);
  const now = () => Date.now() + clockSkew;
  const isHost = () => role === 'host';
  const joinUrl = () => location.origin + location.pathname + '?room=' + code;

  function toast(msg, info) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (info ? ' info' : ''); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2800);
  }

  // ---------- host ----------
  const HOST_KEY = 'pk:host';

  function saveHost() { store.set(HOST_KEY, { code, S, hist: hist.slice(-30) }); }

  function startHost(c, game, h) {
    role = 'host'; code = c; S = game; hist = h || [];
    history.replaceState(null, '', location.pathname + '?room=' + code + (params.get('pid') ? '&pid=' + params.get('pid') : ''));
    net = Net.host(code, {
      onStatus(st) { netStatus = st; render(); },
      onPeers(ids) { online = new Set(ids); broadcast(); render(); },
      onMessage(cid, msg) {
        if (msg.t === 'hello') {
          if ((S.removed || []).includes(cid) && !msg.rejoin) { net.send(cid, { t: 'kicked' }); return; }
          S.removed = (S.removed || []).filter((x) => x !== cid);
          const name = String(msg.name || 'ผู้เล่น').slice(0, 16);
          const p = pById(cid);
          if (!p) { E.addPlayer(S, cid, name); saveHost(); toast(`${name} เข้าห้องแล้ว`, true); }
          else if (p.name !== name) p.name = name;
          broadcast(); render();
        } else if (msg.t === 'cmd') {
          apply(msg.cmd, cid);
        }
      },
    });
    saveHost();
    render();
  }

  function broadcast() {
    if (!net || !isHost()) return;
    const ol = [...online];
    net.broadcast(() => ({ t: 'state', s: S, online: ol, now: Date.now() }));
  }

  setInterval(() => { if (isHost() && net) net.broadcast(() => ({ t: 'ping', now: Date.now() })); }, 4000);

  const PLAYER_CMDS = ['act', 'rebuy', 'sitout', 'stand', 'rename'];

  function apply(cmd, from) {
    const fromHost = from === myId;
    try {
      if (!cmd || typeof cmd !== 'object') throw new Error('คำสั่งไม่ถูกต้อง');
      if (!fromHost) {
        if (!PLAYER_CMDS.includes(cmd.c) || cmd.pid !== from) throw new Error('เฉพาะเจ้ามือเท่านั้น');
        if (cmd.c === 'rebuy' && (S.settings.mode !== 'cash' || pById(from).stack > 0)) throw new Error('Rebuy ได้เมื่อชิปหมด (เฉพาะ Cash game)');
      }
      if (cmd.c === 'undo') {
        if (!hist.length) throw new Error('ไม่มีอะไรให้ย้อน');
        S = JSON.parse(hist.pop());
        toast('ย้อนกลับ 1 ขั้นแล้ว', true);
      } else {
        const before = JSON.stringify(S);
        run(cmd);
        hist.push(before);
        if (hist.length > 40) hist.shift();
      }
      saveHost(); broadcast(); render();
    } catch (e) {
      if (fromHost) toast(e.message); else net.send(from, { t: 'err', msg: e.message });
    }
  }

  function run(cmd) {
    const t = Date.now();
    switch (cmd.c) {
      case 'act': return E.act(S, cmd.pid, cmd.type, cmd.amount);
      case 'start': return E.startHand(S, t);
      case 'award': return E.award(S, cmd.winners);
      case 'rebuy': return E.rebuy(S, cmd.pid);
      case 'stack': return E.setStack(S, cmd.pid, cmd.v);
      case 'sitout': return E.setSitOut(S, cmd.pid, cmd.v);
      case 'stand': return E.setLeft(S, cmd.pid, cmd.v);
      case 'remove':
        E.removePlayer(S, cmd.pid);
        S.removed = (S.removed || []).concat(cmd.pid);
        if (net) { net.send(cmd.pid, { t: 'kicked' }); }
        return;
      case 'move': return E.movePlayer(S, cmd.pid, cmd.dir);
      case 'rename': { const p = pById(cmd.pid); if (p) p.name = String(cmd.name).slice(0, 16); return; }
      case 'join': return E.addPlayer(S, myId, myName);
      case 'pause': return E.setPaused(S, cmd.v, t);
      case 'level': {
        const n = Math.max(0, Math.min(S.settings.levels.length - 1, S.level + cmd.d));
        S.level = n; if (S.levelStart != null) S.levelStart = S.pausedAt != null ? S.pausedAt : t;
        return;
      }
      case 'settings': {
        const old = S.settings;
        S.settings = Object.assign({}, old, cmd.settings);
        if (S.handNo === 0 && S.settings.startStack !== old.startStack) S.players.forEach((p) => { p.stack = S.settings.startStack; });
        if (S.settings.mode !== old.mode && S.handNo === 0) { S.level = 0; S.levelStart = null; S.pausedAt = null; }
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
    net = Net.client(code, myId, myName, hello, {
      onStatus(st) { netStatus = st; render(); },
      onMessage(msg) {
        if (msg.t === 'state') {
          clockSkew = msg.now - Date.now();
          S = msg.s; online = new Set(msg.online); kicked = false;
          render();
        } else if (msg.t === 'ping') {
          clockSkew = msg.now - Date.now();
        } else if (msg.t === 'err') {
          toast(msg.msg);
        } else if (msg.t === 'kicked') {
          kicked = true; render();
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

  function actorInfo(id) {
    const h = S.hand; const p = pById(id);
    const bet = h.bets[id] || 0;
    const toCall = Math.max(0, h.currentBet - bet);
    const maxTo = bet + p.stack;
    const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
    const canRaise = maxTo > h.currentBet && !h.noRaise[id] && p.stack > toCall;
    const pot = E.potTotal(h);
    return { p, bet, toCall, maxTo, minTo, canRaise, pot, isBet: h.currentBet === 0 };
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
    if (myTurn && !ui.wasMyTurn) { try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch (e) { /* ignore */ } }
    ui.wasMyTurn = myTurn;

    const scrollY = window.scrollY;
    $app.innerHTML = topBar() + `<div class="wrap">${S.handNo === 0 && !h ? lobby() : table()}</div>` + bottomBar(actor) + sheet();
    window.scrollTo(0, scrollY);
    updateTimer();
  }

  function renderHome() {
    const saved = store.get(HOST_KEY, null);
    const roomParam = (params.get('room') || '').toUpperCase();
    const resume = saved && saved.code && (!roomParam || roomParam === saved.code);
    $app.innerHTML = `<div class="wrap">
      <svg class="chip-logo" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="#c0392b"/><circle cx="50" cy="50" r="30" fill="none" stroke="#fff" stroke-width="8" stroke-dasharray="12 10"/><circle cx="50" cy="50" r="18" fill="#c0392b" stroke="#fff" stroke-width="2"/></svg>
      <h1>Poker Chips</h1>
      <p class="center muted">ไพ่จริงบนโต๊ะ · ชิปบนมือถือ</p>
      <div class="card">
        <label>ชื่อของคุณ</label>
        <input id="name" maxlength="16" value="${esc(myName)}" placeholder="เช่น โจโจ้" autocomplete="nickname">
      </div>
      ${resume ? `<button class="primary" style="width:100%" data-a="resume">กลับเข้าห้องเดิม ${esc(saved.code)} (เจ้ามือ)</button>` : ''}
      <div class="card">
        <h2>เข้าห้องของเพื่อน</h2>
        <div class="row"><input id="code" maxlength="5" placeholder="รหัสห้อง" value="${esc(roomParam)}" style="text-transform:uppercase;letter-spacing:3px;font-weight:700">
        <button class="${roomParam && !resume ? 'primary' : 'blue'}" data-a="join" style="flex:none">เข้าห้อง</button></div>
      </div>
      <div class="card">
        <h2>สร้างห้องใหม่</h2>
        <p class="muted small" style="margin:0 0 10px">มือถือเครื่องนี้จะเป็นเจ้ามือ (ต้องเปิดแอปค้างไว้ตลอดเกม)</p>
        <div class="seg" id="mode"><button class="on" data-a="mode" data-v="cash">Cash game</button><button data-a="mode" data-v="tournament">Tournament</button></div>
        <label class="check"><input type="checkbox" id="plays" checked> ฉันร่วมเล่นด้วย</label>
        <button class="${resume || roomParam ? '' : 'primary'}" style="width:100%;margin-top:8px" data-a="create">สร้างห้อง</button>
      </div>
    </div>`;
  }

  function renderKicked() {
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
      <span class="blinds">${tour ? `Lv${S.level + 1} · ` : ''}${fmt(b.sb)}/${fmt(b.bb)}${b.ante ? ` · ante ${fmt(b.ante)}` : ''}</span>
      ${tour ? `<span class="timer ${S.pausedAt != null ? 'paused' : ''}" id="timer"></span>` : ''}
      <span class="spacer"></span>
      ${isHost() ? `<button class="sm" data-a="sheet" data-v="menu">☰ เจ้ามือ</button>` : `<button class="sm ghost" data-a="sheet" data-v="menu">☰</button>`}
    </div></div>`;
  }

  function lobby() {
    const list = S.players.map((p, i) => `<div class="pl"><span class="muted">${i + 1}</span><div class="nm"><b>${esc(p.name)}${p.id === myId ? ' <span class="me-tag">(คุณ)</span>' : ''}</b></div>
      <span class="dot ${isOnline(p.id) ? 'on' : ''}"></span><div class="stack">${fmt(p.stack)}</div></div>`).join('');
    return `<div class="card center">
      <div class="muted small">สแกนเพื่อเข้าห้อง</div>
      <div class="qr">${qrSvg(joinUrl())}</div>
      <div class="bigcode">${esc(code)}</div>
      <div class="link">${esc(joinUrl())}</div>
    </div>
    <div class="card">
      <h2>ผู้เล่น (${S.players.length}) · ${S.settings.mode === 'cash' ? 'Cash game' : 'Tournament'} · ชิปเริ่ม ${fmt(S.settings.startStack)}</h2>
      <div class="players">${list || '<p class="muted">ยังไม่มีผู้เล่น</p>'}</div>
      ${isHost() ? `<p class="muted small">เรียงที่นั่งได้ที่ ☰ เจ้ามือ → ผู้เล่น (ลำดับ = เวียนตามเข็มนาฬิกา)</p>
        <div class="grid2"><button data-a="sheet" data-v="settings">ตั้งค่า</button><button class="primary" data-a="cmd" data-c="start" ${S.players.length < 2 ? 'disabled' : ''}>เริ่มเกม</button></div>`
        : '<p class="muted center">รอเจ้ามือเริ่มเกม…</p>'}
    </div>`;
  }

  function isOnline(id) { return (isHost() && id === myId) || online.has(id) || (!isHost() && id === myId && netStatus === 'online'); }

  function table() {
    const h = S.hand;
    const pot = h && !h.done ? E.potTotal(h) : 0;
    let potHtml;
    if (!h) potHtml = `<div class="lbl">พร้อมเริ่มมือแรก</div>`;
    else if (h.done) {
      const total = Object.values(h.result || {}).reduce((a, b) => a + b, 0);
      potHtml = `<div class="lbl">มือที่ ${h.no} จบแล้ว</div><div class="amt">${fmt(total)}</div>
        <div class="hint">${Object.entries(h.result || {}).map(([id, a]) => `${esc((pById(id) || {}).name)} ได้ ${fmt(a)}`).join(' · ')}</div>`;
    } else {
      const hint = h.street === 'showdown' ? (h.runout ? 'เปิดไพ่กลางให้ครบ 5 ใบ แล้วหงายไพ่' : 'หงายไพ่ — เจ้ามือเลือกผู้ชนะ')
        : { flop: 'ดีลเลอร์เปิด Flop 3 ใบ', turn: 'ดีลเลอร์เปิด Turn', river: 'ดีลเลอร์เปิด River', preflop: 'แจกไพ่คนละ 2 ใบ' }[h.street];
      const side = h.pots && h.pots.length > 1 ? `<div class="sidepots">${h.pots.map((p, i) => `${i ? 'Side ' + i : 'Main'} ${fmt(p.amount)}`).join(' · ')}</div>` : '';
      potHtml = `<div class="lbl">Pot · มือที่ ${h.no}</div><div class="amt">${fmt(pot)}</div>${side}
        <span class="street">${E.streetName(h.street)}</span><div class="hint">${hint}</div>`;
    }
    const lastLog = S.log.slice(-2).map(esc).join('<br>');
    const me = pById(myId);
    const away = S.players.filter((p) => p.left);
    const standBanner = me && me.left ? `<div class="banner row"><span>คุณลุกจากโต๊ะแล้ว · ชิป ${fmt(me.stack)}</span>
      <button class="primary sm" style="flex:none" data-a="cmd" data-c="stand" data-pid="${esc(myId)}" data-v="">นั่งกลับ</button></div>` : '';
    return `${standBanner}<div class="card pot">${potHtml}</div>
      <div class="players">${S.players.filter((p) => !p.left).map(playerRow).join('')}</div>
      ${away.length ? `<div class="away"><span>ลุกแล้ว:</span> ${away.map((p) => `${esc(p.name)} <b>${fmt(p.stack)}</b>`).join(' · ')}</div>` : ''}
      ${h && h.street === 'showdown' && !h.done ? showdown() : ''}
      <div class="lastlog" data-a="sheet" data-v="log">${lastLog}<br><u>ดูประวัติทั้งหมด</u></div>`;
  }

  function playerRow(p) {
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
    let cls = 'pl';
    if (p.out) { status = S.settings.mode === 'tournament' ? `ตกรอบ (ที่ ${S.players.length - S.finishOrder.indexOf(p.id)})` : 'ชิปหมด'; cls += ' idle'; }
    else if (p.sitOut) { status = 'พักโต๊ะ'; cls += ' idle'; }
    else if (live && !inH) { status = 'รอมือถัดไป'; cls += ' idle'; }
    else if (live && h.folded[p.id]) { status = 'Fold'; cls += ' fold'; }
    else if (live && h.toAct === p.id) { status = 'กำลังคิด…'; cls += ' turn'; }
    else if (live && h.lastAct[p.id]) status = h.lastAct[p.id];
    if (!p.out && p.stack === 0 && !(live && inH)) status = S.settings.mode === 'cash' ? 'ชิปหมด — Rebuy?' : status;
    const bet = live && h.bets[p.id] ? `<span class="bet">${fmt(h.bets[p.id])}</span>` : '';
    const won = h && h.done && h.result && h.result[p.id] ? `<div class="won">+${fmt(h.result[p.id])}</div>` : '';
    return `<div class="${cls}">
      <span class="dot ${isOnline(p.id) ? 'on' : 'off'}"></span>
      <div class="nm"><b>${esc(p.name)}${badges.join('')}${p.id === myId ? ' <span class="me-tag">คุณ</span>' : ''}</b><span class="st">${esc(status)}</span></div>
      <div class="stack">${fmt(p.stack)}${bet ? '<br>' + bet : ''}${won}</div>
    </div>`;
  }

  function showdown() {
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
    let inner = '';
    if (!h || h.done) {
      const me = pById(myId);
      const rebuy = me && S.settings.mode === 'cash' && me.stack === 0 ? `<button class="blue" data-a="cmd" data-c="rebuy" data-pid="${esc(myId)}">Rebuy +${fmt(S.settings.startStack)}</button>` : '';
      if (isHost()) {
        const over = S.settings.mode === 'tournament' && E.eligible(S).length < 2 && S.handNo > 0;
        inner = over ? `<div class="grid2">${rebuy || ''}<button class="primary" data-a="sheet" data-v="summary">🏆 สรุปผล</button></div>`
          : `<div class="row">${rebuy}<button class="primary" style="padding:16px" data-a="cmd" data-c="start">เริ่มมือถัดไป ▶</button></div>`;
      } else inner = rebuy ? `<div class="row">${rebuy}</div>` : `<div class="waitbar">รอเจ้ามือเริ่มมือถัดไป…</div>`;
    } else if (h.toAct) {
      const p = pById(h.toAct);
      inner = `<div class="waitbar">ตาของ <b>${esc(p.name)}</b>${isHost() ? ` · <button class="sm ghost" data-a="proxy">กดแทน</button>` : ''}</div>`;
    } else return '';
    return `<div class="actbar"><div class="in">${inner}</div></div>`;
  }

  function actionBar(id) {
    const a = actorInfo(id);
    if (!ui.raiseTo || ui.raiseTo < a.minTo || ui.raiseTo > a.maxTo) ui.raiseTo = a.minTo;
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
      const quick = [['Min', a.minTo], ['½ Pot', q(0.5)], ['¾ Pot', q(0.75)], ['Pot', q(1)], ['All-in', a.maxTo]]
        .map(([l, v]) => `<button data-a="quick" data-v="${Math.max(a.minTo, Math.min(a.maxTo, v))}">${l}</button>`).join('');
      const step = S.hand.bb;
      raise = `<div class="raise">
        <div class="amt"><span class="muted small">${a.isBet ? 'Bet' : 'Raise to'}</span> <span id="raiseAmt">${fmt(ui.raiseTo)}</span></div>
        <div class="row"><button class="sm" style="flex:none" data-a="step" data-v="${-step}">−</button>
          <input type="range" id="raiseRange" min="${a.minTo}" max="${a.maxTo}" step="1" value="${ui.raiseTo}">
          <button class="sm" style="flex:none" data-a="step" data-v="${step}">+</button></div>
        <div class="quick">${quick}</div>
        <button class="primary" style="width:100%;padding:16px" data-a="act" data-t="raise" id="raiseGo">ยืนยัน ${a.isBet ? 'Bet' : 'Raise to'} ${fmt(ui.raiseTo)}</button>
      </div>`;
    }
    return `<div class="actbar"><div class="in">
      <div class="who"><span>${proxy ? `เจ้ามือกดแทน <b>${esc(a.p.name)}</b> · <u data-a="proxy">ยกเลิก</u>` : '<b>ถึงตาคุณ!</b>'}</span><span>ชิป ${fmt(a.p.stack)}${a.toCall ? ` · ต้อง call ${fmt(Math.min(a.toCall, a.p.stack))}` : ''}</span></div>
      <div class="btns"><button class="danger" data-a="act" data-t="fold">Fold</button>${callBtn}${raiseBtn}</div>
      ${raise}
    </div></div>`;
  }

  // ---------- sheets ----------
  function sheet() {
    if (!ui.sheet) return '';
    const body = { menu: menuSheet, invite: inviteSheet, settings: settingsSheet, players: playersSheet, summary: summarySheet, log: logSheet }[ui.sheet];
    if (!body) return '';
    const [title, html] = body();
    return `<div class="sheet-bg" data-a="closeSheet"><div class="sheet" data-stop="1">
      <div class="head"><h2 style="margin:0">${title}</h2><button class="sm ghost" data-a="closeSheet">ปิด</button></div>${html}</div></div>`;
  }

  function menuSheet() {
    const tour = S.settings.mode === 'tournament';
    const me = pById(myId);
    if (!isHost()) {
      return ['เมนู', `<div class="menu">
        <button data-a="sheet" data-v="invite">📱 ชวนเพื่อน (QR)</button>
        <button data-a="sheet" data-v="summary">📊 สรุปชิป</button>
        <button data-a="sheet" data-v="log">📜 ประวัติ</button>
        ${me ? `${standButton(me)}${me.left ? '' : `<button data-a="cmd" data-c="sitout" data-pid="${esc(myId)}" data-v="${me.sitOut ? '' : '1'}">${me.sitOut ? '▶ กลับมาเล่น' : '⏸ พักโต๊ะ (ข้ามมือถัดไป)'}</button>`}
        <button data-a="rename">✏️ เปลี่ยนชื่อ</button>` : ''}
        <button class="ghost" data-a="leave">ออกจากห้อง</button></div>`];
    }
    return ['เมนูเจ้ามือ', `<div class="menu">
      <button data-a="cmd" data-c="undo">↩️ Undo (ย้อน 1 ขั้น)</button>
      <button data-a="sheet" data-v="players">👥 ผู้เล่น · ชิป · Rebuy · ที่นั่ง</button>
      <button data-a="sheet" data-v="settings">⚙️ ตั้งค่า Blinds / เกม</button>
      ${tour ? `<button data-a="cmd" data-c="pause" data-v="${S.pausedAt != null ? '' : '1'}">${S.pausedAt != null ? '▶ เดินเวลาต่อ' : '⏸ หยุดเวลา Blind'}</button>
        <div class="grid2"><button data-a="cmd" data-c="level" data-d="-1">◀ Level ก่อน</button><button data-a="cmd" data-c="level" data-d="1">Level ถัดไป ▶</button></div>` : ''}
      <button data-a="sheet" data-v="invite">📱 ชวนเพื่อน (QR)</button>
      <button data-a="sheet" data-v="summary">📊 สรุปผล / เงิน</button>
      <button data-a="sheet" data-v="log">📜 ประวัติ</button>
      ${me ? standButton(me) : `<button data-a="hostJoin">🙋 ให้เจ้ามือร่วมเล่นด้วย</button>`}
      <button class="danger" data-a="endRoom">ปิดห้อง (ลบเกมนี้)</button>
    </div>`];
  }

  function standButton(me) {
    return me.left
      ? `<button class="primary" data-a="cmd" data-c="stand" data-pid="${esc(me.id)}" data-v="">🪑 นั่งกลับ (ชิป ${fmt(me.stack)})</button>`
      : `<button data-a="stand" data-pid="${esc(me.id)}">🚪 ลุกจากโต๊ะ (เก็บชิป ${fmt(me.stack)})</button>`;
  }

  function inviteSheet() {
    return ['ชวนเพื่อน', `<div class="qr">${qrSvg(joinUrl())}</div><div class="bigcode">${esc(code)}</div>
      <div class="link">${esc(joinUrl())}</div>
      <div class="grid2" style="margin-top:12px"><button data-a="copy">คัดลอกลิงก์</button>${navigator.share ? '<button data-a="share">แชร์</button>' : ''}</div>`];
  }

  function settingsSheet() {
    const st = S.settings;
    const locked = S.handNo > 0;
    const levels = st.levels.map((l, i) => levelRow(l, i, st.mode === 'tournament' && S.levelStart != null && i === S.level)).join('');
    return ['ตั้งค่า', `
      <label>รูปแบบเกม${locked ? ' (เปลี่ยนไม่ได้หลังเริ่มเกม)' : ''}</label>
      <select id="s_mode" ${locked ? 'disabled' : ''}><option value="cash" ${st.mode === 'cash' ? 'selected' : ''}>Cash game</option><option value="tournament" ${st.mode === 'tournament' ? 'selected' : ''}>Tournament</option></select>
      <label>ชิปเริ่มต้น / ต่อ 1 buy-in${locked ? ' (มีผลกับ Rebuy ครั้งต่อไป)' : ''}</label><input id="s_stack" type="number" inputmode="numeric" value="${st.startStack}">
      <div id="cashBox" ${st.mode === 'cash' ? '' : 'hidden'}>
        <div class="grid3"><div><label>SB</label><input id="s_sb" type="number" inputmode="numeric" value="${st.sb}"></div>
        <div><label>BB</label><input id="s_bb" type="number" inputmode="numeric" value="${st.bb}"></div>
        <div><label>Ante</label><input id="s_ante" type="number" inputmode="numeric" value="${st.ante || 0}"></div></div>
        <label>มูลค่าเงินต่อ 1 buy-in (บาท, ใส่ 0 ถ้าไม่ใช้)</label><input id="s_money" type="number" inputmode="numeric" value="${st.buyInValue || 0}">
        <p class="muted small">เปลี่ยน blind มีผลตั้งแต่มือถัดไป</p>
      </div>
      <div id="tourBox" ${st.mode === 'tournament' ? '' : 'hidden'}>
        <label>โครงสร้าง Blind</label>
        <div class="lvhead"><span>Lv</span><span>SB</span><span>BB</span><span>Ante</span><span>นาที</span><span></span></div>
        <div id="lvRows">${levels}</div>
        <button class="ghost" style="width:100%;margin-top:8px" data-a="lvAdd">+ เพิ่ม Level</button>
        <div class="lvall"><span>ตั้งทุก Level เป็น</span><input id="lvAllMin" type="number" inputmode="numeric" value="${st.levels[0] ? st.levels[0].min : 3}"><span>นาที</span><button class="sm" data-a="lvAllMin">ใช้</button></div>
        <p class="muted small">Ante = ทุกคนจ่ายก่อนแจกไพ่ (ใส่ 0 = ไม่มี) · พิมพ์ BB แล้ว SB จะเติมให้ครึ่งหนึ่งอัตโนมัติ</p>
      </div>
      <button class="primary" style="width:100%;margin-top:14px" data-a="saveSettings">บันทึก</button>`];
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
    const rows = S.players.map((p, i) => {
      const busy = E.inHand(S, p.id);
      return `<div class="prow"><div class="top"><b>${i + 1}. ${esc(p.name)}${p.id === myId ? ' (คุณ)' : ''}${p.left ? ' <span class="muted small">· ลุกแล้ว</span>' : ''}</b><span>${fmt(p.stack)} <span class="muted small">· buy-in ${p.buyIns}</span></span></div>
      <div class="acts">
        <button class="sm" data-a="cmd" data-c="move" data-pid="${esc(p.id)}" data-d="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="sm" data-a="cmd" data-c="move" data-pid="${esc(p.id)}" data-d="1" ${i === S.players.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="sm" data-a="cmd" data-c="rebuy" data-pid="${esc(p.id)}" ${busy ? 'disabled' : ''}>Rebuy</button>
        <button class="sm" data-a="setStack" data-pid="${esc(p.id)}" ${busy ? 'disabled' : ''}>แก้ชิป</button>
        <button class="sm" data-a="cmd" data-c="sitout" data-pid="${esc(p.id)}" data-v="${p.sitOut ? '' : '1'}" ${p.left ? 'disabled' : ''}>${p.sitOut ? 'กลับมาเล่น' : 'พัก'}</button>
        ${p.left ? `<button class="sm primary" data-a="cmd" data-c="stand" data-pid="${esc(p.id)}" data-v="">นั่งกลับ</button>`
          : `<button class="sm" data-a="stand" data-pid="${esc(p.id)}">ลุก</button>`}
        <button class="sm danger" data-a="remove" data-pid="${esc(p.id)}" ${busy ? 'disabled' : ''}>ลบ</button>
      </div></div>`;
    }).join('');
    return ['ผู้เล่น', `<p class="muted small" style="margin-top:0">ลำดับในรายการ = ลำดับที่นั่งเวียนตามเข็มนาฬิกา · แก้ชิป/Rebuy/ลบ ได้เมื่อคนนั้นไม่ได้อยู่ในมือที่กำลังเล่น</p>${rows}`];
  }

  function summarySheet() {
    const st = S.settings;
    if (st.mode === 'tournament') {
      const alive = S.players.filter((p) => !p.out).sort((a, b) => b.stack - a.stack);
      const outs = S.finishOrder.slice().reverse().map(pById).filter(Boolean);
      const rows = alive.concat(outs).map((p, i) => `<tr><td>${i + 1}. ${esc(p.name)}</td><td>${p.out ? 'ตกรอบ' : fmt(p.stack)}</td></tr>`).join('');
      return ['อันดับ', `<table><tr><th>ผู้เล่น</th><th>ชิป</th></tr>${rows}</table>`];
    }
    const money = st.buyInValue > 0;
    const data = S.players.map((p) => {
      const net = p.stack - p.buyIns * st.startStack;
      return { p, net, cash: net / st.startStack * st.buyInValue };
    }).sort((a, b) => b.net - a.net);
    const rows = data.map(({ p, net, cash }) => `<tr><td>${esc(p.name)}${p.left ? ' <span class="muted small">(ลุก)</span>' : ''}</td><td>${p.buyIns}</td><td>${fmt(p.stack)}</td>
      <td class="${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${net > 0 ? '+' : ''}${fmt(net)}</td>
      ${money ? `<td class="${cash > 0 ? 'pos' : cash < 0 ? 'neg' : ''}">${cash > 0 ? '+' : ''}${fmt(Math.round(cash))}</td>` : ''}</tr>`).join('');
    return ['สรุปชิป', `<table><tr><th>ผู้เล่น</th><th>Buy-in</th><th>ชิป</th><th>กำไร</th>${money ? '<th>บาท</th>' : ''}</tr>${rows}</table>
      ${S.hand && !S.hand.done ? '<p class="muted small">* มือนี้ยังไม่จบ ชิปที่อยู่ใน pot ยังไม่ถูกนับ</p>' : ''}
      ${money ? '' : '<p class="muted small">ตั้ง "มูลค่าเงินต่อ 1 buy-in" ในตั้งค่า เพื่อให้คำนวณเป็นบาท</p>'}`];
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
    const ms = E.levelRemainingMs(S, now());
    const m = Math.floor(ms / 60000); const sec = Math.floor(ms / 1000) % 60;
    el.textContent = (S.levelStart == null ? '' : S.pausedAt != null ? '⏸ ' : '') + m + ':' + String(sec).padStart(2, '0');
  }
  setInterval(updateTimer, 1000);

  // ---------- events ----------
  let createMode = 'cash';

  document.addEventListener('input', (e) => {
    if (e.target.id === 'raiseRange') { ui.raiseTo = Number(e.target.value); syncRaise(); }
    const k = e.target.dataset && e.target.dataset.k;
    if (k === 'sb') e.target.dataset.manual = '1';
    if (k === 'bb') {
      const sb = e.target.closest('.lvrow').querySelector('[data-k=sb]');
      if (!sb.dataset.manual) sb.value = Math.floor((Number(e.target.value) || 0) / 2);
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 's_mode') {
      document.getElementById('cashBox').hidden = e.target.value !== 'cash';
      document.getElementById('tourBox').hidden = e.target.value !== 'tournament';
    }
  });

  function syncRaise() {
    const a = document.getElementById('raiseAmt'); if (a) a.textContent = fmt(ui.raiseTo);
    const r = document.getElementById('raiseRange'); if (r && Number(r.value) !== ui.raiseTo) r.value = ui.raiseTo;
    const g = document.getElementById('raiseGo');
    if (g) g.textContent = g.textContent.replace(/[\d,]+$/, fmt(ui.raiseTo));
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
        if (document.getElementById('plays').checked) E.addPlayer(g, myId, myName);
        startHost(Net.randomCode(), g, []);
        ui.sheet = 'settings'; render();
        break;
      }
      case 'resume': {
        if (!readName(true)) return;
        const saved = store.get(HOST_KEY, null);
        startHost(saved.code, saved.S, saved.hist || []);
        break;
      }
      case 'join': {
        if (!readName()) return;
        const c = (document.getElementById('code').value || '').trim().toUpperCase();
        if (c.length < 4) return toast('ใส่รหัสห้อง');
        startClient(c);
        break;
      }
      case 'rejoin': kicked = false; S = null; net.destroy(); startClient(code, { rejoin: true }); break;
      case 'leave':
        if (!confirm('ออกจากห้อง?')) return;
        net && net.destroy(); location.href = location.pathname;
        break;
      case 'endRoom':
        if (!confirm('ปิดห้องและลบเกมนี้? (กู้คืนไม่ได้)')) return;
        store.del(HOST_KEY); net && net.destroy(); location.href = location.pathname;
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
        const cmd = { c: 'act', pid: id, type: d.t };
        if (d.t === 'raise') cmd.amount = ui.raiseTo;
        if (d.t === 'fold' && S.hand.currentBet - (S.hand.bets[id] || 0) === 0 && !confirm('Check ได้ฟรี — ยืนยันจะ Fold?')) return;
        ui.raiseOpen = false; ui.raiseTo = 0;
        if (id !== myId) ui.proxy = false;
        send(cmd);
        break;
      }
      case 'raiseToggle': ui.raiseOpen = !ui.raiseOpen; render(); break;
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
        const v = prompt(`ชิปของ ${p.name}`, p.stack);
        if (v != null && v !== '') send({ c: 'stack', pid: d.pid, v: Number(v) });
        break;
      }
      case 'remove': {
        const p = pById(d.pid);
        if (confirm(`ลบ ${p.name} ออกจากโต๊ะ?`)) send({ c: 'remove', pid: d.pid });
        break;
      }
      case 'rename': {
        const v = prompt('ชื่อใหม่', myName);
        if (v && v.trim()) { myName = v.trim().slice(0, 16); store.set('pk:name', myName); send({ c: 'rename', pid: myId, name: myName }); }
        break;
      }
      case 'stand': {
        const p = pById(d.pid);
        const who = p.id === myId ? 'คุณ' : p.name;
        if (confirm(`${who}จะลุกจากโต๊ะพร้อมชิป ${fmt(p.stack)}?\nไม่ถูกแจกไพ่จนกว่าจะกด "นั่งกลับ"`)) { ui.sheet = null; send({ c: 'stand', pid: d.pid, v: true }); }
        break;
      }
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
      case 'share': navigator.share({ title: 'Poker Chips', text: `เข้าห้องโป๊กเกอร์ ${code}`, url: joinUrl() }).catch(() => {}); break;
      default: break;
    }
  });

  function readName(optional) {
    const el = document.getElementById('name');
    const v = (el && el.value || '').trim().slice(0, 16);
    if (!v && !optional) { toast('ใส่ชื่อก่อน'); el && el.focus(); return false; }
    if (v) { myName = v; store.set('pk:name', v); }
    return true;
  }

  function saveSettings() {
    const num = (id) => Math.max(0, Math.floor(Number(document.getElementById(id).value) || 0));
    const mode = document.getElementById('s_mode').value;
    const settings = { mode, startStack: num('s_stack') || 1000 };
    if (mode === 'cash') {
      Object.assign(settings, { sb: num('s_sb'), bb: num('s_bb'), ante: num('s_ante'), buyInValue: num('s_money') });
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
