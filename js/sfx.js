// Sound effects, synthesized with Web Audio (no audio files). Sfx.update(S, myId) is called on
// every render and plays whatever happened at the table since the last call.
(function (root) {
  'use strict';

  const KEY = 'pk:mute';
  let muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch (e) { /* private mode */ }
  let ctx = null;
  let prev = null;

  function ac() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // phones only allow audio after a tap
  ['pointerdown', 'keydown'].forEach((ev) => root.addEventListener(ev, () => { if (!muted) ac(); }, { capture: true }));

  function tone(freq, at, dur, opts) {
    const c = ac(); if (!c) return;
    const o = opts || {};
    const t = c.currentTime + at;
    const osc = c.createOscillator(); const g = c.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol || 0.2, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  function noise(at, dur, opts) {
    const c = ac(); if (!c) return;
    const o = opts || {};
    const t = c.currentTime + at;
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(o.freq || 2000, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    f.Q.value = o.q || 1;
    const g = c.createGain();
    g.gain.setValueAtTime(o.vol || 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t);
  }

  const sounds = {
    // ceramic chips clicking together
    chip(n) {
      for (let i = 0; i < (n || 3); i++) {
        const at = i * 0.055 + Math.random() * 0.02;
        tone(3200 + Math.random() * 1400, at, 0.07, { vol: 0.12 });
        noise(at, 0.03, { freq: 5000, q: 2, vol: 0.15 });
      }
    },
    allin() { sounds.chip(7); tone(220, 0.05, 0.35, { type: 'triangle', to: 440, vol: 0.12 }); },
    check() { [0, 0.11].forEach((at) => { tone(180, at, 0.08, { type: 'triangle', vol: 0.35 }); noise(at, 0.03, { freq: 900, vol: 0.2 }); }); },
    fold() { noise(0, 0.22, { freq: 3000, to: 400, filter: 'lowpass', vol: 0.25 }); },
    deal(n) { for (let i = 0; i < (n || 1); i++) noise(i * 0.09, 0.06, { freq: 4500, filter: 'highpass', vol: 0.22 }); },
    turn() { tone(659, 0, 0.18, { vol: 0.18 }); tone(880, 0.13, 0.3, { vol: 0.18 }); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.28, { type: 'triangle', vol: 0.15 })); sounds.chip(5); },
    pot() { sounds.chip(4); },
    // a card slapped face up
    flip(n) { for (let i = 0; i < (n || 1); i++) { noise(i * 0.12, 0.09, { freq: 1400, to: 600, q: 0.8, vol: 0.35 }); tone(140, i * 0.12, 0.06, { type: 'triangle', vol: 0.2 }); } },
    join() { tone(523, 0, 0.15, { vol: 0.14 }); tone(784, 0.1, 0.25, { vol: 0.14 }); },
    leave() { tone(659, 0, 0.15, { vol: 0.12 }); tone(440, 0.1, 0.25, { vol: 0.12 }); },
    buyin() { sounds.chip(6); },
    level() { [0, 0.18, 0.36].forEach((at) => tone(988, at, 0.12, { type: 'square', vol: 0.07 })); },
    bust() { [440, 370, 311, 220].forEach((f, i) => tone(f, i * 0.12, 0.2, { type: 'triangle', vol: 0.14 })); },
    alarm() { for (let i = 0; i < 4; i++) { tone(880, i * 0.3, 0.12, { type: 'square', vol: 0.08 }); tone(660, i * 0.3 + 0.13, 0.12, { type: 'square', vol: 0.08 }); } },
    undo() { noise(0, 0.25, { freq: 400, to: 3000, filter: 'bandpass', q: 1.5, vol: 0.2 }); },
  };

  function play(name, arg) {
    if (root.sfxLog) root.sfxLog.push(name); // debugging: set window.sfxLog = [] to trace
    if (muted) return;
    try { sounds[name](arg); } catch (e) { /* audio unavailable */ }
  }

  function actionSound(t) {
    if (/All-in/.test(t)) return ['allin'];
    if (/^Fold/.test(t)) return ['fold'];
    if (/^Check/.test(t)) return ['check'];
    if (/^(Call|Bet|Raise)/.test(t)) return ['chip', 3];
    return null;
  }

  // a few numbers that tell what changed at the table between two renders
  function snapshot(S, me) {
    const h = S.hand;
    const ps = S.players;
    const x = {
      players: ps.length,
      away: ps.filter((p) => p.left).length,
      bought: ps.reduce((a, p) => a + (p.buyIns || 0), 0),
      level: S.level || 0,
      busted: (S.finishOrder || []).length,
    };
    if (S.settings.mode === 'pokdeng' && S.pd) {
      const r = S.pd.round;
      Object.assign(x, { pd: true, pdNo: r.no, pdPhase: r.phase, pdBets: Object.values(r.bets || {}).reduce((a, b) => a + (Number(b) || 0), 0), banker: S.pd.bankerId });
      const last = S.pd.rounds && S.pd.rounds[S.pd.rounds.length - 1];
      x.pdMine = last && last.delta ? last.delta[me] || 0 : 0;
    } else if (h) {
      Object.assign(x, { no: h.no, n: h.actions.length, street: h.street, done: !!h.done, myTurn: !h.done && h.toAct === me,
        shown: h.shown ? Object.keys(h.shown).length : 0, won: !!(h.result && h.result[me]) });
    }
    return x;
  }

  function update(S, me) {
    const now = S ? snapshot(S, me) : null;
    const was = prev; prev = now;
    if (!now || !was) return;
    const q = []; // [sound, arg, delay ms]
    if (now.players > was.players) q.push(['join']);
    if (now.away > was.away) q.push(['leave']);
    else if (now.away < was.away) q.push(['join']);
    if (now.bought > was.bought && now.players === was.players) q.push(['buyin']);
    if (now.level > was.level) q.push(['level']);
    if (now.busted > was.busted) q.push(['bust']);

    if (now.pd) {
      if (now.pdNo !== was.pdNo) q.push([now.pdMine > 0 ? 'win' : 'pot']);
      else if (now.pdPhase !== was.pdPhase) q.push(now.pdPhase === 'result' ? ['deal', 3] : ['undo']);
      else if (now.pdBets !== was.pdBets) q.push(['chip', 3]);
      if (now.banker !== was.banker && now.pdNo === was.pdNo) q.push(['join']);
    } else if (now.no != null) {
      const h = S.hand;
      if (was.no == null || now.no > was.no) q.push(['deal', 2]);
      else if (now.no < was.no || now.n < was.n || (was.done && !now.done)) q.push(['undo']);
      else {
        const fresh = h.actions.slice(was.n);
        const last = fresh.length ? actionSound(fresh[fresh.length - 1].t) : null;
        if (last) q.push(last);
        let at = last ? 250 : 0;
        if (now.street !== was.street && ['flop', 'turn', 'river'].includes(now.street)) { q.push(['deal', now.street === 'flop' ? 3 : 1, at]); at += 400; }
        const turned = now.shown - (was.shown || 0);
        if (turned > 0) { q.push(['flip', Math.min(turned, 4), at]); at += 150 + Math.min(turned, 4) * 120; }
        if (now.done && !was.done) q.push([now.won ? 'win' : 'pot', null, at + 200]);
        else if (now.myTurn && !was.myTurn) q.push(['turn', null, at + 100]);
      }
    }
    q.forEach(([name, arg, ms]) => (ms ? setTimeout(() => play(name, arg), ms) : play(name, arg)));
  }

  function setMuted(v) {
    muted = !!v;
    try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) { /* private mode */ }
    if (!muted) play('chip', 3);
  }

  root.Sfx = { update, play, setMuted, isMuted: () => muted };
})(this);
