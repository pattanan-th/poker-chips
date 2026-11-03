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
  };

  function play(name, arg) {
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

  function update(S, me) {
    const h = S && S.hand;
    const now = h ? { no: h.no, n: h.actions.length, street: h.street, done: !!h.done, myTurn: !h.done && h.toAct === me } : null;
    const was = prev; prev = now;
    if (!now || !was || S.settings.mode === 'pokdeng') return;
    if (now.no !== was.no) { play('deal', 2); return; }
    const fresh = h.actions.slice(was.n);
    const last = fresh.length ? actionSound(fresh[fresh.length - 1].t) : null;
    if (last) play(...last);
    if (now.street !== was.street && ['flop', 'turn', 'river'].includes(now.street)) setTimeout(() => play('deal', now.street === 'flop' ? 3 : 1), last ? 250 : 0);
    if (now.done && !was.done) setTimeout(() => play(h.result && h.result[me] ? 'win' : 'pot'), 300);
    else if (now.myTurn && !was.myTurn) setTimeout(() => play('turn'), last ? 350 : 0);
  }

  function setMuted(v) {
    muted = !!v;
    try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) { /* private mode */ }
    if (!muted) play('chip', 3);
  }

  root.Sfx = { update, play, setMuted, isMuted: () => muted };
})(this);
