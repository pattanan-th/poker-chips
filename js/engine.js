// No-Limit Hold'em chip/betting engine. Cards are physical — this only tracks
// chips, turns, streets and pots. Every function takes a game state and
// mutates it in place (callers clone first if they need history).
(function (root) {
  'use strict';

  const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];

  const DEFAULT_LEVELS = [
    [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200],
    [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000], [1000, 2000],
  ].map(([sb, bb]) => ({ sb, bb, ante: 0, min: 3 }));

  function newGame(settings) {
    return {
      v: 1,
      settings: Object.assign({
        mode: 'cash',          // 'cash' | 'tournament'
        startStack: 1000,
        sb: 5, bb: 10, ante: 0, // cash blinds
        buyInValue: 0,          // money per buy-in, for the settlement table
        levels: DEFAULT_LEVELS,
      }, settings || {}),
      players: [],
      buttonId: null,
      handNo: 0,
      hand: null,
      level: 0,
      levelStart: null,
      pausedAt: null,
      finishOrder: [],          // tournament: ids in order of elimination
      log: [],
    };
  }

  const fail = (msg) => { throw new Error(msg); };
  const player = (s, id) => s.players.find((p) => p.id === id) || fail('ไม่พบผู้เล่น');

  function addLog(s, text) {
    s.log.push(text);
    if (s.log.length > 60) s.log.splice(0, s.log.length - 60);
  }

  function addPlayer(s, id, name) {
    if (s.players.some((p) => p.id === id)) return;
    const late = s.settings.mode === 'tournament' && s.handNo > 0;
    s.players.push({ id, name, stack: s.settings.startStack, buyIns: 1, sitOut: false, out: false });
    addLog(s, `${name} เข้าร่วม${late ? ' (late entry)' : ''}`);
  }

  function inHand(s, id) {
    const h = s.hand;
    return !!(h && !h.done && h.ids.includes(id));
  }

  function removePlayer(s, id) {
    if (inHand(s, id)) fail('ลบไม่ได้ระหว่างมือ');
    const p = player(s, id);
    s.players = s.players.filter((x) => x.id !== id);
    addLog(s, `${p.name} ออกจากโต๊ะ`);
  }

  function movePlayer(s, id, dir) {
    const i = s.players.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= s.players.length) return;
    [s.players[i], s.players[j]] = [s.players[j], s.players[i]];
  }

  // ---- blinds / tournament clock ----
  function levelDurMs(s, i) { return (s.settings.levels[i].min || 3) * 60000; }

  function tick(s, now) {
    if (s.settings.mode !== 'tournament' || s.levelStart == null || s.pausedAt != null) return;
    while (s.level < s.settings.levels.length - 1 && now - s.levelStart >= levelDurMs(s, s.level)) {
      s.levelStart += levelDurMs(s, s.level);
      s.level++;
      const b = blinds(s);
      addLog(s, `Blind ขึ้นเป็น ${b.sb}/${b.bb}${b.ante ? ` ante ${b.ante}` : ''}`);
    }
  }

  function levelRemainingMs(s, now) {
    if (s.levelStart == null) return levelDurMs(s, s.level);
    const t = s.pausedAt != null ? s.pausedAt : now;
    return Math.max(0, levelDurMs(s, s.level) - (t - s.levelStart));
  }

  function setPaused(s, paused, now) {
    if (s.levelStart == null) return;
    if (paused && s.pausedAt == null) s.pausedAt = now;
    if (!paused && s.pausedAt != null) { s.levelStart += now - s.pausedAt; s.pausedAt = null; }
  }

  function blinds(s) {
    if (s.settings.mode === 'tournament') {
      const l = s.settings.levels[Math.min(s.level, s.settings.levels.length - 1)];
      return { sb: l.sb, bb: l.bb, ante: l.ante || 0 };
    }
    return { sb: s.settings.sb, bb: s.settings.bb, ante: s.settings.ante || 0 };
  }

  // ---- hand flow ----
  const nextOf = (ids, id) => ids[(ids.indexOf(id) + 1) % ids.length];

  function eligible(s) {
    return s.players.filter((p) => !p.sitOut && !p.left && !p.out && p.stack > 0);
  }

  function nextButton(s, ids) {
    if (s.buttonId == null) return ids[0];
    // first eligible seat after the previous button (previous button may be gone)
    const seats = s.players.map((p) => p.id);
    let i = seats.indexOf(s.buttonId);
    if (i < 0) return ids[0];
    for (let k = 1; k <= seats.length; k++) {
      const id = seats[(i + k) % seats.length];
      if (ids.includes(id)) return id;
    }
    return ids[0];
  }

  function post(s, h, id, amt) {
    const p = player(s, id);
    const a = Math.min(amt, p.stack);
    p.stack -= a;
    h.bets[id] = (h.bets[id] || 0) + a;
    h.contrib[id] = (h.contrib[id] || 0) + a;
    if (p.stack === 0) h.allIn[id] = true;
    return a;
  }

  function startHand(s, now) {
    if (s.hand && !s.hand.done) fail('มือปัจจุบันยังไม่จบ');
    if (s.settings.mode === 'tournament') {
      if (s.levelStart == null) s.levelStart = now;
      tick(s, now);
    }
    const ids = eligible(s).map((p) => p.id);
    if (ids.length < 2) fail('ต้องมีผู้เล่นที่มีชิปอย่างน้อย 2 คน');
    const b = blinds(s);
    const btn = nextButton(s, ids);
    const sbId = ids.length === 2 ? btn : nextOf(ids, btn);
    const bbId = nextOf(ids, sbId);
    s.handNo++;
    s.buttonId = btn;
    const h = s.hand = {
      no: s.handNo, street: 'preflop', ids, btn, sbId, bbId, bb: b.bb,
      bets: {}, contrib: {}, folded: {}, allIn: {}, acted: {}, noRaise: {},
      currentBet: b.bb, minRaise: b.bb, toAct: null, last: null,
      pots: null, done: false, result: null, runout: false, lastAct: {},
    };
    if (b.ante) ids.forEach((id) => {
      const p = player(s, id); const a = Math.min(b.ante, p.stack);
      p.stack -= a; h.contrib[id] = a; if (p.stack === 0) h.allIn[id] = true;
    });
    post(s, h, sbId, b.sb);
    post(s, h, bbId, b.bb);
    addLog(s, `— มือที่ ${h.no} · Blinds ${b.sb}/${b.bb} —`);
    findNext(s, h, bbId);
  }

  function needsToAct(h, id) {
    return !h.folded[id] && !h.allIn[id] && (!h.acted[id] || (h.bets[id] || 0) < h.currentBet);
  }

  // Set h.toAct to the next player after `fromId` who still has to act, or close the street.
  function findNext(s, h, fromId) {
    const live = h.ids.filter((id) => !h.folded[id]);
    if (live.length === 1) return winUncontested(s, h, live[0]);
    let id = fromId;
    for (let k = 0; k < h.ids.length; k++) {
      id = nextOf(h.ids, id);
      if (needsToAct(h, id)) { h.toAct = id; return; }
    }
    // street closed
    h.toAct = null;
    const canAct = live.filter((x) => !h.allIn[x]);
    if (h.street === 'river' || canAct.length <= 1) {
      if (h.street !== 'river') h.runout = true;
      return toShowdown(s, h);
    }
    h.street = STREETS[STREETS.indexOf(h.street) + 1];
    h.bets = {}; h.currentBet = 0; h.minRaise = h.bb; h.acted = {}; h.noRaise = {}; h.lastAct = {};
    addLog(s, `${streetName(h.street)}`);
    findNext(s, h, h.btn);
  }

  function act(s, id, type, amount) {
    const h = s.hand;
    if (!h || h.done || h.street === 'showdown') fail('ไม่มีมือที่กำลังเล่น');
    if (h.toAct !== id) fail('ยังไม่ถึงตา');
    const p = player(s, id);
    const bet = h.bets[id] || 0;
    const toCall = h.currentBet - bet;
    const maxTo = bet + p.stack;
    let label = type[0].toUpperCase() + type.slice(1);

    if (type === 'allin') {
      amount = maxTo;
      type = maxTo > h.currentBet && !h.noRaise[id] ? 'raise' : 'call';
    }

    if (type === 'fold') {
      h.folded[id] = true;
      addLog(s, `${p.name} Fold`);
    } else if (type === 'check') {
      if (toCall > 0) fail(`ต้อง Call ${toCall}`);
      addLog(s, `${p.name} Check`);
    } else if (type === 'call') {
      if (toCall <= 0) fail('ไม่มีอะไรให้ Call');
      const a = post(s, h, id, toCall);
      addLog(s, `${p.name} Call ${a}${h.allIn[id] ? ' (All-in)' : ''}`);
    } else if (type === 'raise') {
      amount = Math.floor(Number(amount));
      if (!(amount > h.currentBet)) fail('ยอด Raise ต้องมากกว่า bet ปัจจุบัน');
      if (amount > maxTo) fail('ชิปไม่พอ');
      if (h.noRaise[id]) fail('Raise ไม่ได้ (all-in ก่อนหน้าไม่ครบ min raise) — Call หรือ Fold');
      const size = amount - h.currentBet;
      const isAllIn = amount === maxTo;
      if (size < h.minRaise && !isAllIn) fail(`Min raise คือ ${h.currentBet + h.minRaise}`);
      const wasBet = h.currentBet === 0;
      label = wasBet ? 'Bet' : 'Raise';
      post(s, h, id, amount - bet);
      if (size >= h.minRaise) {
        h.minRaise = size;
        h.ids.forEach((o) => { if (o !== id) h.acted[o] = false; });
        h.noRaise = {};
      } else {
        // incomplete all-in raise: players who already acted must respond but can't re-raise
        h.ids.forEach((o) => { if (o !== id && h.acted[o]) { h.acted[o] = false; h.noRaise[o] = true; } });
      }
      h.currentBet = amount;
      addLog(s, `${p.name} ${wasBet ? 'Bet' : 'Raise to'} ${amount}${isAllIn ? ' (All-in)' : ''}`);
    } else fail('คำสั่งไม่ถูกต้อง');

    h.acted[id] = true;
    h.last = { id, type, amount: h.bets[id] || 0 };
    h.lastAct[id] = h.allIn[id] ? 'All-in' : label;
    findNext(s, h, id);
  }

  // Refund the part of the biggest contribution nobody else matched.
  function returnUncalled(s, h) {
    const sorted = h.ids.map((id) => [id, h.contrib[id] || 0]).sort((a, b) => b[1] - a[1]);
    if (sorted.length < 2) return;
    const [[top, max], [, second]] = sorted;
    if (max > second) {
      const r = max - second;
      player(s, top).stack += r;
      h.contrib[top] -= r;
      if (h.bets[top]) h.bets[top] = Math.max(0, h.bets[top] - r);
      if (player(s, top).stack > 0) h.allIn[top] = false;
      h.refund = { id: top, amount: r };
    }
  }

  function computePots(h) {
    const live = h.ids.filter((id) => !h.folded[id]);
    const levels = [...new Set(live.map((id) => h.contrib[id] || 0))].filter((x) => x > 0).sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const L of levels) {
      let amount = 0;
      h.ids.forEach((id) => { const c = h.contrib[id] || 0; amount += Math.min(c, L) - Math.min(c, prev); });
      const elig = live.filter((id) => (h.contrib[id] || 0) >= L);
      const last = pots[pots.length - 1];
      if (last && last.elig.join() === elig.join()) last.amount += amount;
      else if (amount > 0) pots.push({ amount, elig });
      prev = L;
    }
    // folded chips above the highest live level (rare) go to the last pot
    let extra = 0;
    h.ids.forEach((id) => { const c = h.contrib[id] || 0; if (c > prev) extra += c - prev; });
    if (extra && pots.length) pots[pots.length - 1].amount += extra;
    return pots;
  }

  function potTotal(h) {
    return h ? h.ids.reduce((a, id) => a + (h.contrib[id] || 0), 0) : 0;
  }

  function toShowdown(s, h) {
    h.street = 'showdown';
    h.toAct = null;
    returnUncalled(s, h);
    h.pots = computePots(h);
    addLog(s, h.runout ? 'All-in — เปิดไพ่ให้ครบ 5 ใบ แล้วเลือกผู้ชนะ' : 'Showdown — เลือกผู้ชนะ');
    // pots with a single eligible player need no decision
    if (h.pots.every((p) => p.elig.length === 1)) award(s, h.pots.map((p) => p.elig));
  }

  function winUncontested(s, h, id) {
    h.toAct = null;
    returnUncalled(s, h);
    h.pots = computePots(h);
    award(s, h.pots.map(() => [id]));
  }

  // winners: array (one per pot) of arrays of player ids
  function award(s, winners) {
    const h = s.hand;
    if (!h || h.done || !h.pots) fail('ยังไม่ถึง Showdown');
    if (!Array.isArray(winners) || winners.length !== h.pots.length) fail('เลือกผู้ชนะให้ครบทุก pot');
    const won = {};
    h.pots.forEach((pot, i) => {
      const ws = (winners[i] || []).filter((id) => pot.elig.includes(id));
      if (!ws.length) fail(`ยังไม่ได้เลือกผู้ชนะของ ${i ? 'Side pot ' + i : 'Main pot'}`);
      // odd chips go to the first winner left of the button
      const order = [];
      let id = h.btn;
      for (let k = 0; k < h.ids.length; k++) { id = nextOf(h.ids, id); if (ws.includes(id)) order.push(id); }
      const share = Math.floor(pot.amount / order.length);
      let rem = pot.amount - share * order.length;
      order.forEach((w) => { const a = share + (rem-- > 0 ? 1 : 0); won[w] = (won[w] || 0) + a; });
      pot.winners = order;
    });
    Object.entries(won).forEach(([id, a]) => { player(s, id).stack += a; });
    h.result = won;
    h.done = true;
    h.toAct = null;
    addLog(s, Object.entries(won).map(([id, a]) => `${player(s, id).name} ได้ ${a}`).join(', '));
    if (s.settings.mode === 'tournament') {
      // bust order: smaller starting stack this hand busts "first"
      const busted = h.ids.filter((id) => player(s, id).stack === 0)
        .sort((a, b) => (h.contrib[a] || 0) - (h.contrib[b] || 0));
      busted.forEach((id) => {
        const p = player(s, id); p.out = true; s.finishOrder.push(id);
        addLog(s, `${p.name} ตกรอบ`);
      });
    }
  }

  // ---- off-hand admin ----
  function rebuy(s, id) {
    if (inHand(s, id)) fail('Rebuy ได้หลังจบมือ');
    const p = player(s, id);
    p.stack += s.settings.startStack;
    p.buyIns++;
    p.out = false;
    s.finishOrder = s.finishOrder.filter((x) => x !== id);
    addLog(s, `${p.name} Rebuy +${s.settings.startStack}`);
  }

  function setStack(s, id, stack) {
    if (inHand(s, id)) fail('แก้ชิปได้หลังจบมือ');
    const p = player(s, id);
    stack = Math.max(0, Math.floor(Number(stack) || 0));
    addLog(s, `${p.name} ชิป ${p.stack} → ${stack} (แก้โดยเจ้ามือ)`);
    p.stack = stack;
    if (stack > 0) p.out = false;
  }

  function setSitOut(s, id, v) {
    const p = player(s, id);
    p.sitOut = !!v;
    addLog(s, `${p.name} ${v ? 'พักโต๊ะ' : 'กลับมาเล่น'}`);
  }

  // Stand up: leave the table keeping the chips (cash out); can sit back later.
  function setLeft(s, id, v) {
    const p = player(s, id);
    const h = s.hand;
    if (v && h && !h.done && h.ids.includes(id) && !h.folded[id]) fail('ลุกได้หลังจบมือ หรือหลัง Fold');
    p.left = !!v;
    if (!v) p.sitOut = false;
    addLog(s, v ? `${p.name} ลุกจากโต๊ะ (ชิป ${p.stack})` : `${p.name} กลับมานั่ง`);
  }

  function streetName(st) {
    return { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' }[st] || st;
  }

  const Engine = {
    STREETS, DEFAULT_LEVELS, newGame, addPlayer, removePlayer, movePlayer, startHand, act, award,
    rebuy, setStack, setSitOut, setLeft, tick, setPaused, levelRemainingMs, blinds, potTotal, computePots,
    eligible, inHand, streetName,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(this);
