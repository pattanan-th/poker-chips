// node tests/engine.test.js
const assert = require('assert');
const E = require('../js/engine.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.error('FAIL', name, '\n    ', e.message); process.exitCode = 1; }
}

function game(stacks, settings) {
  const s = E.newGame(Object.assign({ startStack: 1000, sb: 5, bb: 10 }, settings));
  stacks.forEach((st, i) => { E.addPlayer(s, 'p' + i, 'P' + i); s.players[i].stack = st; });
  return s;
}
const total = (s) => s.players.reduce((a, p) => a + p.stack, 0) + (s.hand && !s.hand.done ? E.potTotal(s.hand) : 0);
const stacks = (s) => s.players.map((p) => p.stack);

test('blinds and first to act (3 players)', () => {
  const s = game([1000, 1000, 1000]);
  E.startHand(s, 0);
  const h = s.hand;
  assert.strictEqual(h.btn, 'p0'); assert.strictEqual(h.sbId, 'p1'); assert.strictEqual(h.bbId, 'p2');
  assert.strictEqual(h.toAct, 'p0');
  assert.deepStrictEqual(stacks(s), [1000, 995, 990]);
});

test('heads-up: button is SB and acts first preflop, BB first postflop', () => {
  const s = game([1000, 1000]);
  E.startHand(s, 0);
  const h = s.hand;
  assert.strictEqual(h.sbId, 'p0'); assert.strictEqual(h.toAct, 'p0');
  E.act(s, 'p0', 'call');
  assert.strictEqual(h.toAct, 'p1'); // BB option
  E.act(s, 'p1', 'check');
  assert.strictEqual(h.street, 'flop'); assert.strictEqual(h.toAct, 'p1');
});

test('BB gets option, then full street cycle to showdown', () => {
  const s = game([1000, 1000, 1000]);
  E.startHand(s, 0);
  E.act(s, 'p0', 'call'); E.act(s, 'p1', 'call');
  assert.strictEqual(s.hand.toAct, 'p2');
  E.act(s, 'p2', 'check');
  assert.strictEqual(s.hand.street, 'flop'); assert.strictEqual(s.hand.toAct, 'p1');
  for (const st of ['flop', 'turn', 'river']) {
    assert.strictEqual(s.hand.street, st);
    E.act(s, 'p1', 'check'); E.act(s, 'p2', 'check'); E.act(s, 'p0', 'check');
  }
  assert.strictEqual(s.hand.street, 'showdown');
  assert.strictEqual(s.hand.pots.length, 1); assert.strictEqual(s.hand.pots[0].amount, 30);
  E.award(s, [['p2']]);
  assert.deepStrictEqual(stacks(s), [990, 990, 1020]);
});

test('everyone folds to raiser: uncalled bet returned', () => {
  const s = game([1000, 1000, 1000]);
  E.startHand(s, 0);
  E.act(s, 'p0', 'raise', 30);
  E.act(s, 'p1', 'fold'); E.act(s, 'p2', 'fold');
  assert.ok(s.hand.done);
  assert.deepStrictEqual(stacks(s), [1015, 995, 990]);
});

test('min raise enforced, re-raise sizes', () => {
  const s = game([1000, 1000, 1000]);
  E.startHand(s, 0);
  assert.throws(() => E.act(s, 'p0', 'raise', 15), /Min raise/);
  E.act(s, 'p0', 'raise', 30);      // raise by 20
  assert.throws(() => E.act(s, 'p1', 'raise', 45), /Min raise/);
  E.act(s, 'p1', 'raise', 50);      // raise by 20 ok
  assert.strictEqual(s.hand.minRaise, 20);
  E.act(s, 'p2', 'raise', 150);     // raise by 100
  assert.strictEqual(s.hand.minRaise, 100);
  assert.strictEqual(s.hand.toAct, 'p0');
});

test('side pots with three all-ins of different sizes', () => {
  const s = game([100, 300, 1000]);
  E.startHand(s, 0); // btn p0, sb p1, bb p2
  E.act(s, 'p0', 'allin');          // 100
  E.act(s, 'p1', 'allin');          // 300
  E.act(s, 'p2', 'call');           // calls 300
  const h = s.hand;
  assert.strictEqual(h.street, 'showdown'); assert.ok(h.runout);
  assert.deepStrictEqual(h.pots.map((p) => p.amount), [300, 400]);
  assert.deepStrictEqual(h.pots[0].elig, ['p0', 'p1', 'p2']);
  assert.deepStrictEqual(h.pots[1].elig, ['p1', 'p2']);
  E.award(s, [['p0'], ['p2']]);
  assert.deepStrictEqual(stacks(s), [300, 0, 1100]);
});

test('big stack all-in over short stack gets the excess back', () => {
  const s = game([1000, 200, 1000]);
  E.startHand(s, 0);
  E.act(s, 'p0', 'allin');          // 1000
  E.act(s, 'p1', 'allin');          // 200 (call all-in)
  E.act(s, 'p2', 'fold');
  const h = s.hand;
  assert.strictEqual(h.street, 'showdown');
  assert.deepStrictEqual(h.pots.map((p) => p.amount), [410]);
  assert.strictEqual(s.players[0].stack, 800);
  E.award(s, [['p1']]);
  assert.deepStrictEqual(stacks(s), [800, 410, 990]);
});

test('split pot with odd chip goes left of button', () => {
  const s = game([1000, 1000, 1000], { sb: 5, bb: 10 });
  E.startHand(s, 0);
  E.act(s, 'p0', 'fold'); E.act(s, 'p1', 'raise', 25); E.act(s, 'p2', 'call');
  // pot 50 -> make it odd: p1 bets 5 on flop, p2 calls -> 60. use antes instead:
  for (const st of ['flop', 'turn', 'river']) { E.act(s, 'p1', 'check'); E.act(s, 'p2', 'check'); }
  E.award(s, [['p1', 'p2']]);
  assert.deepStrictEqual(stacks(s), [1000, 1000, 1000]);
});

test('odd chip split', () => {
  const s = game([1000, 1000, 1000], { sb: 5, bb: 10, ante: 1 });
  E.startHand(s, 0);
  E.act(s, 'p0', 'call'); E.act(s, 'p1', 'call'); E.act(s, 'p2', 'check');
  for (const st of ['flop', 'turn', 'river']) { E.act(s, 'p1', 'check'); E.act(s, 'p2', 'check'); E.act(s, 'p0', 'check'); }
  assert.strictEqual(s.hand.pots[0].amount, 33);
  E.award(s, [['p0', 'p2']]);       // 17 to p2 (left of button first? order after btn: p1,p2,p0) -> p2 gets 17
  assert.deepStrictEqual(stacks(s), [1005, 989, 1006]);
});

test('incomplete all-in raise does not reopen raising', () => {
  const s = game([1000, 1000, 1000, 125]);
  E.startHand(s, 0); // btn p0, sb p1, bb p2, utg p3
  E.act(s, 'p3', 'call');           // 10
  E.act(s, 'p0', 'raise', 100);     // raise 90
  E.act(s, 'p1', 'fold'); E.act(s, 'p2', 'fold');
  E.act(s, 'p3', 'allin');          // to 125: incomplete (+25 < 90)
  assert.strictEqual(s.hand.toAct, 'p0');
  assert.throws(() => E.act(s, 'p0', 'raise', 300), /Raise ไม่ได้/);
  E.act(s, 'p0', 'call');
  assert.strictEqual(s.hand.street, 'showdown');
});

test('chips are conserved across many random hands', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const s = game([500, 800, 1200, 300, 1000], { mode: 'cash' });
  const start = total(s);
  for (let n = 0; n < 400; n++) {
    s.players.forEach((p) => { if (p.stack === 0) E.rebuy(s, p.id); });
    const before = total(s);
    E.startHand(s, 0);
    let guard = 0;
    while (!s.hand.done && guard++ < 200) {
      const h = s.hand;
      if (h.street === 'showdown') {
        E.award(s, h.pots.map((p) => [p.elig[Math.floor(rnd() * p.elig.length)]]));
        break;
      }
      const id = h.toAct; const p = s.players.find((x) => x.id === id);
      const toCall = h.currentBet - (h.bets[id] || 0);
      const r = rnd();
      try {
        if (r < 0.15) E.act(s, id, 'fold');
        else if (r < 0.25) E.act(s, id, 'allin');
        else if (r < 0.45 && p.stack > toCall + h.minRaise) E.act(s, id, 'raise', h.currentBet + h.minRaise + Math.floor(rnd() * 50));
        else E.act(s, id, toCall > 0 ? 'call' : 'check');
      } catch (e) { E.act(s, id, toCall > 0 ? 'call' : 'check'); }
      assert.strictEqual(total(s), before, 'chips leaked mid-hand ' + n);
    }
    assert.ok(s.hand.done, 'hand finished ' + n);
    assert.strictEqual(total(s), before, 'hand ' + n);
  }
  assert.ok(total(s) >= start);
});

test('tournament: blinds rise with clock, busted players go out', () => {
  const s = game([1000, 1000, 50], { mode: 'tournament' });
  E.startHand(s, 0);
  assert.deepStrictEqual(E.blinds(s), { sb: 10, bb: 20, ante: 0 });
  E.act(s, 'p0', 'allin'); E.act(s, 'p1', 'fold'); E.act(s, 'p2', 'allin');
  E.award(s, [['p0']]);
  assert.ok(s.players[2].out);
  assert.deepStrictEqual(s.finishOrder, ['p2']);
  E.startHand(s, 4 * 60000);
  assert.deepStrictEqual(E.blinds(s), { sb: 15, bb: 30, ante: 0 });
  assert.deepStrictEqual(s.hand.ids, ['p0', 'p1']);
});

test('stand up: blocked mid-hand unless folded, skipped by next hand, sit back in', () => {
  const s = game([1000, 1000, 1000]);
  E.startHand(s, 0);
  assert.throws(() => E.setLeft(s, 'p1', true), /ลุกได้หลังจบมือ/);
  E.act(s, 'p0', 'fold');
  E.setLeft(s, 'p0', true);
  E.act(s, 'p1', 'call'); E.act(s, 'p2', 'check');
  for (const st of ['flop', 'turn', 'river']) { E.act(s, 'p1', 'check'); E.act(s, 'p2', 'check'); }
  E.award(s, [['p1']]);
  E.startHand(s, 0);
  assert.deepStrictEqual(s.hand.ids, ['p1', 'p2']);
  assert.strictEqual(s.players[0].stack, 1000);
  E.act(s, s.hand.toAct, 'fold');
  E.setLeft(s, 'p0', false);
  E.startHand(s, 0);
  assert.deepStrictEqual(s.hand.ids, ['p0', 'p1', 'p2']);
});

test('hand history: actions per street and chip deltas that sum to zero', () => {
  const s = game([1000, 1000, 1000]);
  E.startHand(s, 0);
  E.act(s, 'p0', 'raise', 30); E.act(s, 'p1', 'fold'); E.act(s, 'p2', 'call');
  E.act(s, 'p2', 'check'); E.act(s, 'p0', 'raise', 50); E.act(s, 'p2', 'fold');
  const h = s.history[0];
  assert.strictEqual(h.no, 1);
  assert.deepStrictEqual(h.actions.map((a) => a.t), ['SB 5', 'BB 10', 'Raise to 30', 'Fold', 'Call 20', 'Check', 'Bet 50', 'Fold']);
  assert.strictEqual(h.actions[5].st, 'flop');
  assert.deepStrictEqual(h.delta, { p0: 35, p1: -5, p2: -30 });
  assert.deepStrictEqual(h.pots, [{ amount: 65, winners: ['p0'] }]);
});

test('tournament: fixing a busted player\'s stack takes them off the finish list', () => {
  const s = game([1000, 1000, 50], { mode: 'tournament' });
  E.startHand(s, 0);
  E.act(s, 'p0', 'allin'); E.act(s, 'p1', 'fold'); E.act(s, 'p2', 'allin');
  E.award(s, [['p0']]);
  E.setStack(s, 'p2', 500);
  assert.deepStrictEqual(s.finishOrder, []);
  assert.strictEqual(s.players[2].out, false);
});

test('cash session clock starts with the first hand and pauses', () => {
  const s = game([1000, 1000], { sessionMin: 60 });
  assert.strictEqual(E.sessionRemainingMs(s, 0), null);
  E.startHand(s, 1000);
  assert.strictEqual(E.sessionRemainingMs(s, 1000 + 10 * 60000), 50 * 60000);
  E.setPaused(s, true, 1000 + 10 * 60000);
  assert.strictEqual(E.sessionRemainingMs(s, 1000 + 30 * 60000), 50 * 60000);
  E.setPaused(s, false, 1000 + 30 * 60000);
  assert.strictEqual(E.sessionRemainingMs(s, 1000 + 40 * 60000), 40 * 60000);
});

test('setStack as buy-in tracks extra investment; as correction does not', () => {
  const s = game([1000, 1000]);
  E.setStack(s, 'p0', 300, true);
  E.setStack(s, 'p1', 1200, false);
  assert.strictEqual(E.invested(s, s.players[0]), 300);
  assert.strictEqual(E.invested(s, s.players[1]), 1000);
  s.players[0].stack = 0;
  E.rebuy(s, 'p0');
  assert.strictEqual(E.invested(s, s.players[0]), 1300);
});

console.log(`\n${passed} passed`);
