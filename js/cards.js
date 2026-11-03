// App-dealt cards for games without a physical deck. The host phone shuffles with the
// browser's cryptographic RNG, keeps the deck outside the shared state, sends each player
// only their own hole cards, reveals the board street by street and judges the showdown.
(function (root) {
  'use strict';

  const RANKS = '23456789TJQKA';
  const SUITS = ['s', 'h', 'd', 'c'];
  const HAND_NAMES = ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
  const BOARD_SHOWN = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5 };

  // card = 0..51; rank 0 ('2') .. 12 ('A')
  const rankOf = (c) => c % 13;
  const suitOf = (c) => Math.floor(c / 13);
  const label = (c) => RANKS[rankOf(c)] + SUITS[suitOf(c)];

  const cryptoObj = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto
    : require('crypto').webcrypto;

  // uniform integer in [0, n) — rejection sampling so no value is favoured
  function randInt(n) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    do cryptoObj.getRandomValues(buf); while (buf[0] >= limit);
    return buf[0] % n;
  }

  function shuffle() {
    const d = Array.from({ length: 52 }, (_, i) => i);
    for (let i = d.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }

  // Deal like at a table: one card each around twice, then burn-and-turn the board.
  function deal(ids) {
    const deck = shuffle();
    const hole = {};
    for (let r = 0; r < 2; r++) ids.forEach((id) => { (hole[id] = hole[id] || []).push(deck.pop()); });
    const board = [];
    [3, 1, 1].forEach((n) => { deck.pop(); for (let k = 0; k < n; k++) board.push(deck.pop()); });
    return { hole, board, rest: deck };
  }

  // score of exactly 5 cards: [category, ...tiebreak ranks], compared element by element
  function score5(cs) {
    const ranks = cs.map(rankOf).sort((a, b) => b - a);
    const flush = cs.every((c) => suitOf(c) === suitOf(cs[0]));
    const uniq = [...new Set(ranks)];
    let straightHigh = -1;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      else if (uniq.join() === '12,3,2,1,0') straightHigh = 3; // A-2-3-4-5
    }
    if (flush && straightHigh >= 0) return [8, straightHigh];
    const counts = {};
    ranks.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
    // groups ordered by size, then rank
    const groups = Object.entries(counts).map(([r, n]) => [n, Number(r)]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const byGroup = groups.map((g) => g[1]);
    if (groups[0][0] === 4) return [7, ...byGroup];
    if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...byGroup];
    if (flush) return [5, ...ranks];
    if (straightHigh >= 0) return [4, straightHigh];
    if (groups[0][0] === 3) return [3, ...byGroup];
    if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...byGroup];
    if (groups[0][0] === 2) return [1, ...byGroup];
    return [0, ...ranks];
  }

  function compare(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  // best 5 of up to 7 cards
  function best(cards) {
    if (cards.length < 5) return null;
    let top = null;
    (function pick(start, chosen) {
      if (chosen.length === 5) {
        const sc = score5(chosen);
        if (!top || compare(sc, top) > 0) top = sc;
        return;
      }
      for (let i = start; i <= cards.length - (5 - chosen.length); i++) pick(i + 1, chosen.concat(cards[i]));
    })(0, []);
    return { score: top, name: HAND_NAMES[top[0]] };
  }

  // Bring the shared hand in line with the secret deal. Call on the host after every command.
  // secrets: { [handNo]: deal } kept by the host only. Returns true if it awarded the pot.
  function sync(s, secrets, E) {
    const h = s.hand;
    if (!h || !s.settings.appCards) return false;
    let d = secrets[h.no];
    if (!d) {
      if (h.done) return false;
      d = secrets[h.no] = deal(h.ids);
      Object.keys(secrets).forEach((k) => { if (Number(k) < h.no - 2) delete secrets[k]; });
    }
    // seats that joined the hand after an undo get cards from the same deck
    h.ids.forEach((id) => { if (!d.hole[id]) d.hole[id] = [d.rest.pop(), d.rest.pop()]; });
    h.appCards = true;
    if (!h.done) h.board = d.board.slice(0, BOARD_SHOWN[h.street] || 0);
    let awarded = false;
    if (h.street === 'showdown' && !h.done && h.pots) {
      const live = h.ids.filter((id) => !h.folded[id]);
      const res = {};
      live.forEach((id) => { res[id] = best(d.hole[id].concat(d.board)); });
      const winners = h.pots.map((pot) => {
        const top = pot.elig.reduce((m, id) => (compare(res[id].score, m) > 0 ? res[id].score : m), res[pot.elig[0]].score);
        return pot.elig.filter((id) => compare(res[id].score, top) === 0);
      });
      h.shown = {};
      live.forEach((id) => { h.shown[id] = { cards: d.hole[id], hand: res[id].name }; });
      const i = s.log.length - 1;
      if (i >= 0 && /เลือกผู้ชนะ/.test(s.log[i])) s.log[i] = 'Showdown — เปิดไพ่';
      s.log.push(live.map((id) => `${(s.players.find((p) => p.id === id) || {}).name}: ${res[id].name}`).join(' · '));
      E.award(s, winners);
      awarded = true;
    }
    if (h.done) {
      const last = s.history && s.history[s.history.length - 1];
      if (last && last.no === h.no && !last.board) { last.board = h.board || []; if (h.shown) last.shown = h.shown; }
    }
    return awarded;
  }

  const Cards = { RANKS, SUITS, HAND_NAMES, label, rankOf, suitOf, randInt, shuffle, deal, score5, best, compare, sync };
  if (typeof module !== 'undefined' && module.exports) module.exports = Cards;
  else root.Cards = Cards;
})(this);
