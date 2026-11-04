// Dev aid for the table view, run in the browser console of a room you host:
//   eval(await (await fetch('/tests/layout-check.js')).text()); await layoutSweep([2, 6, 10])
// layoutCheck() lists every overlap or cut-off; layoutSweep() changes the number of bots and
// plays hands, collecting issues seen while waiting, on your turn and after the hand.
window.layoutCheck = function () {
  const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const hit = (a, b, pad) => a.l + pad < b.r && b.l + pad < a.r && a.t + pad < b.b && b.t + pad < a.b;
  const name = (el) => (el.className || el.tagName).toString().split(' ')[0] + (el.closest('[data-pid]') ? '@' + el.closest('[data-pid]').dataset.pid.slice(-4) : '');
  const vis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0; };
  const issues = [];
  const bar = document.querySelector('.actbar');
  const barTop = bar ? R(bar).t : innerHeight;
  const top = document.querySelector('.topbar') ? R(document.querySelector('.topbar')).b : 0;
  const parts = [];
  document.querySelectorAll('.seat').forEach((s) => s.querySelectorAll('.av, .snm, .sstk, .sst, .sshown').forEach((p) => { if (vis(p) && (p.textContent.trim() || p.classList.contains('av'))) parts.push(p); }));
  const center = [...document.querySelectorAll('.tcenter .pot .lbl, .tcenter .pot .amt, .tcenter .street, .tcenter .pot .hint, .tcenter .board, .tcenter .tlinks, .tcenter .tlog > div')].filter(vis);
  const bets = [...document.querySelectorAll('.tbet:not(.inline)')].filter(vis);
  const mine = [...document.querySelectorAll('.tmycards .pcs, .tmycards .tinfo')].filter(vis);
  const all = parts.concat(center, bets, mine);
  all.forEach((el) => {
    const r = R(el);
    if (r.b > barTop + 1) issues.push(`under action bar: ${name(el)}`);
    if (r.t < top - 1) issues.push(`under top bar: ${name(el)}`);
    if (r.l < -1 || r.r > innerWidth + 1) issues.push(`off screen: ${name(el)}`);
  });
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    const sa = a.closest('.seat'), sb = b.closest('.seat');
    if (sa && sa === sb) continue;
    if (a.closest('.tcenter') && b.closest('.tcenter')) continue;
    if (a.closest('.tmycards') && b.closest('.tmycards')) continue;
    if ((a.closest('.tmycards') && sb && sb.classList.contains('me')) || (b.closest('.tmycards') && sa && sa.classList.contains('me'))) continue;
    if (hit(R(a), R(b), 2)) issues.push(`overlap: ${name(a)} × ${name(b)}`);
  }
  return [...new Set(issues)];
};

window.layoutSweep = async function (counts, secs) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (sel) => { const el = document.querySelector(sel); if (el) el.click(); return !!el; };
  const out = {};
  const handOver = async () => {
    for (let i = 0; i < 80 && !document.querySelector('[data-a=cmd][data-c=start]'); i++) {
      if ((document.querySelector('.actbar .who') || {}).innerText && document.querySelector('.actbar .who').innerText.includes('ถึงตาคุณ')) click('[data-a=act][data-t=fold]');
      await wait(400);
    }
  };
  for (const n of counts) {
    await handOver();
    click('[data-a=sheet][data-v=players]'); await wait(300);
    for (let k = 0; k < 30; k++) {
      const rows = document.querySelectorAll('.sheet .prow').length;
      if (rows === n) break;
      if (rows < n) { click('.sheet [data-a=cmd][data-c=addBot]'); await wait(250); continue; }
      const b = [...document.querySelectorAll('.sheet [data-a=remove]')].reverse().find((x) => !x.disabled && x.closest('.prow').innerText.includes('บอท'));
      if (!b) break; b.click(); await wait(250);
    }
    document.querySelectorAll('[data-a=closeSheet]').forEach((e) => e.click()); await wait(300);
    click('[data-a=cmd][data-c=start]');
    const seen = new Set();
    for (let t = 0; t < (secs || 10) * 4; t++) {
      await wait(250); window.scrollTo(0, 0);
      layoutCheck().forEach((x) => seen.add(x));
      if (document.querySelector('[data-a=cmd][data-c=start]') && t > 8) break;
    }
    out[n] = [...seen];
  }
  return { size: `${innerWidth}x${innerHeight}`, out };
};
'layout check ready';
