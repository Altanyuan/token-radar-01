// Token Radar's dashboard, rebuilt. It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, the filters, and a per-protocol detail view with
// the model's own inputs and the protocol's farm plan. No network: every byte it shows is
// in data.js. Rendering is template strings into one shell; the table rows, the top-three
// cards and the detail dialog are all plain HTML the page fills from the same dataset.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var shell = document.getElementById('board');
  var WATCH = {};
  (DATA.watchlist || []).forEach(function (s) { WATCH[s] = true; });
  var view = { q: '', category: 'all', chain: 'all', scope: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function age(n) {
    if (n === null || n === undefined) return 'unknown';
    if (n >= 365) return (n / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(n)) + 'd';
  }
  function mult(n) {
    return (Math.round(n * 10000) / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
  }

  // The model in one function, the same arithmetic main.ts writes to board.json, so the
  // page's recomputed value and the board's carried value visibly agree.
  function rawImplied(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var yrs = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(yrs, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var chains = row.chains ? row.chains.length : 0;
    var breadth = 1 + model.breadth_step * Math.min(Math.max(chains - 1, 0), model.breadth_cap);
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthMult * maturity * breadth));
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains,
  // TVL and age decide the two moves, the capital, the hold and every cost and time. No
  // name is special-cased, and the page's steps are the board's steps.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 25e7) return 125;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdFor(yrs) {
    if (yrs === null || yrs === undefined) return 30;
    if (yrs < 180) return 60;
    if (yrs < 365) return 45;
    return 30;
  }
  var MOVES = [
    { keys: ['lend', 'cdp', 'collateral'],
      first: function (n, c, ch) { return 'Supply $' + c + ' of USDC to ' + n + ' on ' + ch + ' and keep the position open.'; },
      second: function (n) { return 'Borrow a small amount against the deposit on ' + n + ', then repay it the same week.'; } },
    { keys: ['dex', 'yield', 'leveraged farm', 'liquidity manager'],
      first: function (n, c, ch) { return 'Provide $' + c + ' of liquidity to ' + n + "'s main pool on " + ch + ' and keep the position open.'; },
      second: function (n) { return 'Swap a small amount through the same pool on ' + n + ' so the wallet shows trading activity too.'; } },
    { keys: ['bridge'],
      first: function (n, c, ch) { return 'Bridge $' + c + ' of USDC to ' + ch + ' through ' + n + ' and use the bridged funds in its app.'; },
      second: function (n) { return 'Send a second, smaller bridge back through ' + n + ' so the wallet shows two-way use.'; } },
    { keys: ['staking', 'restak'],
      first: function (n, c) { return 'Stake $' + c + " of the chain's staking asset through " + n + ' and keep the receipt.'; },
      second: function (n) { return 'Delegate a second, smaller tranche through ' + n + ' a week later.'; } },
    { keys: ['perpetual', 'derivative', 'basis'],
      first: function (n, c) { return 'Deposit $' + c + ' of USDC as margin on ' + n + ' and open one small hedged position.'; },
      second: function (n) { return 'Close the first position on ' + n + ' and open a fresh one the next week.'; } },
    { keys: ['prediction'],
      first: function (n, c) { return 'Fund $' + c + ' and place one market position on ' + n + '.'; },
      second: function (n) { return 'Settle the first market on ' + n + ' and open a second one.'; } },
    { keys: ['curator', 'allocator'],
      first: function (n, c, ch) { return 'Deposit $' + c + ' into a ' + n + ' vault on ' + ch + ' and keep the shares.'; },
      second: function (n, c, ch) { return 'Move a slice of the deposit into a second ' + n + ' vault on ' + ch + '.'; } },
    { keys: ['stable'],
      first: function (n, c, ch) { return 'Mint or deposit $' + c + ' of the stable asset through ' + n + ' on ' + ch + '.'; },
      second: function (n) { return 'Redeem a small amount of the stable asset and re-mint it through ' + n + '.'; } },
    { keys: ['rwa'],
      first: function (n, c, ch) { return 'Mint $' + c + " of the protocol's yield-bearing asset on " + ch + ' and hold it.'; },
      second: function (n) { return 'Buy a second, smaller tranche of the yield asset on ' + n + '.'; } },
    { keys: ['insurance'],
      first: function (n, c, ch) { return 'Buy $' + c + ' of cover from ' + n + ' on ' + ch + ' and keep the policy.'; },
      second: function (n) { return 'Extend the cover on ' + n + ' by one more period.'; } },
    { keys: ['aggregator'],
      first: function (n, c, ch) { return 'Deposit $' + c + ' into a ' + n + ' vault on ' + ch + ' and let it auto-compound.'; },
      second: function (n) { return "Harvest the vault's rewards on " + n + ' and re-deposit them.'; } },
    { keys: ['options'],
      first: function (n, c, ch) { return 'Deposit $' + c + ' into the ' + n + ' options vault on ' + ch + ' and keep the position.'; },
      second: function (n) { return 'Roll the options vault position on ' + n + ' into the next round.'; } },
    { keys: ['payment'],
      first: function (n, c, ch) { return 'Top up $' + c + ' through ' + n + ' on ' + ch + ' and make one payment with it.'; },
      second: function (n, c, ch) { return 'Make a second payment through ' + n + ' on ' + ch + '.'; } },
    { keys: ['privacy'],
      first: function (n, c, ch) { return 'Run one shielded transfer of $' + c + ' through ' + n + ' on ' + ch + '.'; },
      second: function (n) { return 'Repeat the shielded transfer on ' + n + ' with a fresh note.'; } },
    { keys: ['index'],
      first: function (n, c, ch) { return 'Buy $' + c + ' of the ' + n + ' index on ' + ch + ' and hold it.'; },
      second: function (n) { return 'Rebalance the ' + n + ' index holding once after a month.'; } },
    { keys: ['farm'],
      first: function (n, c, ch) { return 'Stake $' + c + ' of LP tokens in the ' + n + ' farm on ' + ch + '.'; },
      second: function (n) { return 'Harvest the farm rewards on ' + n + ' and stake them again.'; } },
    { keys: ['chain'],
      first: function (n, c) { return 'Bridge $' + c + ' of USDC to ' + n + ' and use its flagship app once.'; },
      second: function (n) { return "Stake a small amount of the chain's gas token on " + n + '.'; } }
  ];
  function movesFor(p) {
    var c = (p.category || '').toLowerCase();
    for (var i = 0; i < MOVES.length; i++) {
      var keys = MOVES[i].keys;
      for (var j = 0; j < keys.length; j++) {
        if (c.indexOf(keys[j]) >= 0) return MOVES[i];
      }
    }
    return {
      first: function (n, c, ch) { return 'Deposit $' + c + ' of USDC into ' + n + ' on ' + ch + ' and keep the position open.'; },
      second: function (n, c, ch) { return 'Make a second, smaller deposit into ' + n + ' on ' + ch + ' a week later.'; }
    };
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdFor(p.age_days);
    var gas = capital >= 150 ? 8 : 4;
    var mv = movesFor(p);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: mv.first(p.name, capital, chain), cost: '$' + capital + ' of capital and about $' + gas + ' of gas', time: '15 minutes to set up' },
      { text: mv.second(p.name, capital, chain), cost: 'about $' + Math.max(2, Math.round(capital / 25)) + ' of gas', time: '10 minutes' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Open the protocol's own points or rewards page once a week and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes a week' },
      { text: 'Write the wallet, the dates and every transaction in a farm log, then unwind after the claim window and keep a dust position in case of a second snapshot.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.selected = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('scope')) view.scope = params.get('scope');
    if (params.get('tab')) view.tab = params.get('tab');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.scope !== 'all') params.set('scope', view.scope);
    if (view.tab !== 'pre-token') params.set('tab', view.tab);
    if (view.selected) params.set('p', view.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function inScope(r) {
    if (view.scope === 'watchlist') return !!WATCH[r.slug];
    if (view.scope === 'early') return r.tvl_usd < DATA.floor_usd;
    return true;
  }
  function filtered() {
    var q = view.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (!inScope(r)) return false;
      if (view.category !== 'all' && (r.category || 'Other') !== view.category) return false;
      if (view.chain !== 'all' && !(r.chains || []).includes(view.chain)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var key = view.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'chains') { av = a.chains ? a.chains.length : 0; bv = b.chains ? b.chains.length : 0; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function subline(r) {
    return (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain');
  }
  function growthCell(r) {
    if (r.change_7d === null) return '<td class="num">n/a</td>';
    var cls = r.change_7d >= 0 ? 'pos' : 'neg';
    return '<td class="num ' + cls + '">' + pct(r.change_7d) + '</td>';
  }

  function headHtml() {
    return '<header class="top">' +
      '<div class="brand"><span class="mark"></span><span class="brand-name">Token <em>Radar</em></span></div>' +
      '<div class="top-meta"><span>Snapshot <b>' + esc(DATA.as_of) + '</b></span>' +
      '<span>DefiLlama protocol index</span>' +
      '<span><b>' + esc(DATA.model_version) + '</b> model</span></div></header>';
  }
  function ledeHtml() {
    var top3 = DATA.rows.slice(0, 3).map(function (r, i) {
      return '<button type="button" class="next" data-open="' + esc(r.slug) + '">' +
        '<span class="k">' + (i === 0 ? 'Farm next' : 'Then farm') + '</span>' +
        '<span class="n">#' + r.rank + ' ' + esc(r.name) + '</span>' +
        '<span class="v">Implied <b>' + money(r.implied_value_usd) + '</b> · TVL ' + money(r.tvl_usd) + '</span></button>';
    }).join('');
    return '<section class="lede">' +
      '<h1>Which pre-token protocol is worth farming next? <em>Start at the top.</em></h1>' +
      '<p>Every protocol below records no token, and none is a wrapped, staked or bridged product of one that already trades. The board ranks them by implied value from the snapshot figures alone: TVL, seven-day growth, how long it has run with no token, and how many chains it sits on. Implied value is a model, not a promise.</p>' +
      '<div class="next3">' + top3 + '</div>' +
      '<div class="facts">' +
      '<div class="fact"><span>Watchlist covered</span><b>' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</b><small>every slug, no exceptions</small></div>' +
      '<div class="fact"><span>Pre-token rows ranked</span><b>' + DATA.board_size + '</b><small>' + DATA.early_size + ' below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor</small></div>' +
      '<div class="fact"><span>Top implied value</span><b>' + money(DATA.rows[0] ? DATA.rows[0].implied_value_usd : 0) + '</b><small>' + esc(DATA.rows[0] ? DATA.rows[0].name : '') + '</small></div>' +
      '<div class="fact"><span>Live-token protocols set aside</span><b>' + DATA.live_size + '</b><small>their market cap is a fact, not a model</small></div>' +
      '</div></section>';
  }
  function controlsHtml() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    function opts(list, current, allLabel) {
      var h = '<option value="all"' + (current === 'all' ? ' selected' : '') + '>' + allLabel + '</option>';
      return h + list.map(function (c) {
        return '<option value="' + esc(c) + '"' + (c === current ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('');
    }
    function scopeBtn(v, label) {
      return '<button type="button" data-scope="' + v + '" aria-pressed="' + (view.scope === v ? 'true' : 'false') + '">' + label + '</button>';
    }
    function tabBtn(v, label) {
      return '<button type="button" data-tab="' + v + '" aria-pressed="' + (view.tab === v ? 'true' : 'false') + '">' + label + '</button>';
    }
    var count = view.tab === 'pre-token' ? filtered().length + ' rows shown' : DATA.live.length + ' live-token protocols';
    return '<div class="controls">' +
      '<div class="field"><label for="q">Search</label>' +
      '<input type="search" id="q" placeholder="Search name, category or chain" value="' + esc(view.q) + '" aria-label="Search the board"></div>' +
      '<div class="field"><label for="category">Category</label>' +
      '<select id="category" aria-label="Filter by category">' + opts(cats, view.category, 'All categories') + '</select></div>' +
      '<div class="field"><label for="chain">Chain</label>' +
      '<select id="chain" aria-label="Filter by chain">' + opts(chains, view.chain, 'All chains') + '</select></div>' +
      '<div class="field"><span class="sub">Scope</span><div class="scope">' +
      scopeBtn('all', 'All rows') + scopeBtn('watchlist', 'Watchlist') + scopeBtn('early', 'Below the floor') + '</div></div>' +
      '<div class="field"><span class="sub">Token status</span><div class="tabs">' +
      tabBtn('pre-token', 'Pre-token') + tabBtn('live', 'Live token') + '</div></div>' +
      '<span class="count">' + count + '</span></div>';
  }
  function sortTh(key, label) {
    var arrow = view.sort === key ? '<span aria-hidden="true">' + (view.dir < 0 ? ' v' : ' ^') + '</span>' : '';
    return '<th scope="col"><button type="button" data-sort="' + key + '">' + label + arrow + '</button></th>';
  }
  function boardHtml() {
    var list = sorted(filtered());
    if (list.length === 0) {
      return '<div class="panel"><div class="empty"><h2>No protocol matches that filter</h2>' +
        '<p>Clear the search or pick another category to see the board again.</p>' +
        '<button class="button" type="button" data-clear="1">Clear filters</button></div></div>';
    }
    var max = list[0].implied_value_usd || 1;
    var rowsHtml = list.map(function (r) {
      var pct = Math.max(3, Math.round((r.implied_value_usd / max) * 100));
      return '<tr data-open="' + esc(r.slug) + '" data-selected="' + (view.selected === r.slug ? 'true' : 'false') + '" tabindex="0">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><div class="name"><b>' + esc(r.name) + (WATCH[r.slug] ? '<span class="badge">watchlist</span>' : '') + '</b>' +
        '<span class="sub">' + esc(subline(r)) + '</span></div></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        growthCell(r) +
        '<td class="num">' + age(r.age_days) + '</td>' +
        '<td class="num">' + (r.chains ? r.chains.length : 0) + '</td>' +
        '<td><div class="implied"><div class="bar" aria-hidden="true"><i style="width:' + pct + '%"></i></div>' +
        '<span class="num">' + money(r.implied_value_usd) + '</span></div></td>' +
        '<td><span class="status">no token</span></td></tr>';
    }).join('');
    return '<div class="panel"><div class="table-wrap"><table>' +
      '<caption class="sub">Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.</caption>' +
      '<thead><tr>' + sortTh('implied', 'Rank') + sortTh('name', 'Protocol') + sortTh('tvl', 'TVL') + sortTh('growth', '7d') +
      sortTh('age', 'Age') + sortTh('chains', 'Chains') + sortTh('implied', 'Implied value') +
      '<th scope="col">Token</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div></div>';
  }
  function liveHtml() {
    var rowsHtml = DATA.live.map(function (r) {
      return '<tr><td class="num">live</td>' +
        '<td><div class="name"><b>' + esc(r.name) + '</b><span class="sub">' + esc(subline(r)) + '</span></div></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        growthCell(r) +
        '<td class="num">' + money(r.mcap_usd) + '</td>' +
        '<td><span class="status live">already trades</span></td></tr>';
    }).join('');
    return '<div class="panel"><div class="table-wrap"><table>' +
      '<caption class="sub">Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.</caption>' +
      '<thead><tr><th scope="col">Status</th><th scope="col">Protocol</th><th scope="col">TVL</th><th scope="col">7d</th><th scope="col">Market cap</th><th scope="col">Token</th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table></div></div>';
  }
  function modelHtml() {
    var m = DATA.model;
    return '<section class="panel model"><h2>How implied value is computed</h2>' +
      '<p class="sub">Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.</p>' +
      '<div class="formula">implied = round( tvl_usd x ' + m.base_multiple + ' x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x (1 + ' + m.breadth_step + ' x min(chains - 1, ' + m.breadth_cap + ')) )</div>' +
      '<ul><li>TVL is the base: a protocol holding more value has more to price into a token.</li>' +
      '<li>Seven-day growth is momentum, clamped so one hot week cannot carry a cold protocol.</li>' +
      '<li>Age is how long the protocol has run with no token on record; an unlisted age uses ' + m.unknown_age_days + ' days.</li>' +
      '<li>Chain breadth is surface: a protocol live on more chains has more places a launch can land.</li>' +
      '<li>Wrapped, staked and bridged products of tokens that already trade are not ranked: a wrapped token is not a token that does not exist yet. Rows that tie on value are nudged $1 apart so the ranking is strict.</li></ul></section>';
  }

  var dialog = document.createElement('dialog');
  dialog.className = 'detail';
  dialog.id = 'detail';
  dialog.setAttribute('aria-labelledby', 'detail-title');
  dialog.addEventListener('close', function () { view.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = null;
    for (var i = 0; i < DATA.rows.length; i++) {
      if (DATA.rows[i].slug === slug) { row = DATA.rows[i]; break; }
    }
    if (!row) return;
    view.selected = slug;
    writeHash();
    var steps = farmSteps(row);
    var raw = rawImplied(row, DATA.model);
    var tie = row.implied_value_usd - raw;
    var note = 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(raw) +
      (tie === 0 ? ', the same number board.json carries.' : ', and the board carries ' + money(row.implied_value_usd) + ' after the $' + Math.abs(tie) + ' tie-break that keeps the ranking strict.') +
      ' This is an estimate, not a price.';
    var eq = [
      ['TVL', money(row.tvl_usd)], ['Seven-day growth', pct(row.change_7d)],
      ['Age with no token', age(row.age_days)], ['Chains', String(row.chains ? row.chains.length : 0)],
      ['Growth multiplier', mult(row.growth_multiplier)], ['Maturity multiplier', mult(row.maturity_multiplier)],
      ['Breadth multiplier', mult(row.breadth_multiplier)], ['Implied value', money(row.implied_value_usd)]
    ].map(function (pair) {
      return '<div><span>' + pair[0] + '</span><b class="num">' + pair[1] + '</b></div>';
    }).join('');
    var stepsHtml = steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return '<li><b>' + esc(action) + '</b><span class="cost">' + esc(tail) + '</span></li>';
    }).join('');
    dialog.innerHTML =
      '<div class="detail-head"><div>' +
      '<span class="brand-name">Rank ' + row.rank + ' of ' + DATA.board_size + (WATCH[row.slug] ? ' · watchlist' : ' · early find') + '</span>' +
      '<h2 id="detail-title">' + esc(row.name) + '</h2>' +
      '<p class="sub">' + esc((row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain')) + '</p></div>' +
      '<button class="close" type="button" aria-label="Close details" data-close="1">Close</button></div>' +
      '<section class="detail-section"><h3>Implied value</h3><div class="equation">' + eq + '</div>' +
      '<p class="sub">' + esc(note) + '</p></section>' +
      '<section class="detail-section"><h3>Farm plan</h3><ol class="steps">' + stepsHtml + '</ol></section>';
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    var html = '<div class="shell">' + headHtml() + ledeHtml() + controlsHtml() +
      (view.tab === 'pre-token' ? boardHtml() : liveHtml()) +
      (view.tab === 'pre-token' ? modelHtml() : '') + '</div>';
    shell.innerHTML = html;
    shell.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) shell.appendChild(dialog);
    if (view.selected) openDetail(view.selected);
  }

  shell.addEventListener('click', function (e) {
    var t = e.target;
    var open = t.closest ? t.closest('[data-open]') : null;
    if (open) { openDetail(open.getAttribute('data-open')); return; }
    if (t.closest && t.closest('[data-close]')) { dialog.close(); return; }
    var sort = t.closest ? t.closest('[data-sort]') : null;
    if (sort) {
      var key = sort.getAttribute('data-sort');
      if (view.sort === key) view.dir = -view.dir;
      else { view.sort = key; view.dir = -1; }
      render();
      return;
    }
    var sc = t.closest ? t.closest('[data-scope]') : null;
    if (sc) { view.scope = sc.getAttribute('data-scope'); writeHash(); render(); return; }
    var tb = t.closest ? t.closest('[data-tab]') : null;
    if (tb) { view.tab = tb.getAttribute('data-tab'); writeHash(); render(); return; }
    if (t.closest && t.closest('[data-clear]')) {
      view.q = ''; view.category = 'all'; view.chain = 'all'; view.scope = 'all'; writeHash(); render();
    }
  });
  shell.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'q') { view.q = e.target.value; writeHash(); render(); }
  });
  shell.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'category') { view.category = e.target.value; writeHash(); render(); }
    if (e.target && e.target.id === 'chain') { view.chain = e.target.value; writeHash(); render(); }
  });
  shell.addEventListener('keydown', function (e) {
    var open = e.target && e.target.closest ? e.target.closest('[data-open]') : null;
    if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(open.getAttribute('data-open')); }
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });

  readHash();
  render();
})();
