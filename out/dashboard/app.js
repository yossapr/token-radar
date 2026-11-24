/* Token Radar: the page.
 *
 * Reads window.RADAR, which main.ts writes beside this directory, and renders four views from it:
 * the board, one protocol's detail, a filtered slice, and the method. No network, no framework, no
 * state that outlives the tab. Every number on the page comes from that one object, so the screenshots
 * and the code cannot disagree.
 */
(function () {
  'use strict';

  var R = window.RADAR;
  var view = document.getElementById('view');
  var rows = R.rows.slice();
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });
  var state = { filter: 'all', category: '', chain: '', q: '', sort: 'rank' };

  // ------------------------------------------------------------ formatting
  function fmtUsd(n) {
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(v) {
    if (v === null || v === undefined) return 'n/a';
    var s = v > 0 ? '+' : '';
    return s + v.toFixed(1) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'not recorded';
    if (d < 90) return d + ' days';
    if (d < 730) return (d / 365).toFixed(1) + ' yr';
    return Math.round(d / 365) + ' yr';
  }
  function pct(v) { return Math.round(v * 100) + '%'; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function tierOf(row) {
    return 'v-' + String(row.verdict).toLowerCase();
  }
  function money0(n) { return n >= 1000 ? '$' + Math.round(n).toLocaleString('en-US') : '$' + Math.round(n); }
  function bandBar(row) {
    var lo = Math.log10(Math.max(1, row.band_low_usd));
    var hi = Math.log10(Math.max(1, row.band_high_usd));
    var mid = Math.log10(Math.max(1, row.implied_value_usd));
    var span = hi - lo || 1;
    var left = Math.max(0, Math.min(100, ((mid - lo) / span) * 100));
    return '<div class="bar"><span class="fill" style="left:0;width:100%"></span><span class="dot" style="left:' + left.toFixed(1) + '%"></span></div>';
  }

  // ------------------------------------------------------------ chrome
  document.getElementById('stamp-date').textContent = R.meta.as_of;
  document.getElementById('stamp-model').textContent = R.meta.model;
  document.getElementById('stamp-universe').textContent = R.meta.snapshot_protocols + ' protocols / ' + R.counts.ranked + ' ranked';
  document.getElementById('foot-source').textContent = 'Source: ' + R.meta.source + '. No network, no cookies, no tracking.';

  function kpis() {
    var f = R.report.fit;
    var farmable = rows.filter(function (r) { return r.verdict !== 'SKIP'; }).length;
    return '<section class="kpis" aria-label="The model at a glance">' +
      '<div class="kpi"><div class="label">Value model</div><div class="value">' + f.slope.toFixed(2) + ' <small>slope on log\u2081\u2080 TVL</small></div>' +
        '<div class="note">log\u2081\u2080 mcap = <b>' + f.intercept.toFixed(2) + '</b> + ' + f.slope.toFixed(2) + ' \u00d7 log\u2081\u2080 TVL, R\u00b2 <b>' + f.r2.toFixed(2) + '</b></div></div>' +
      '<div class="kpi"><div class="label">Out-of-sample miss</div><div class="value">' + f.loo_median_factor.toFixed(2) + '\u00d7 <small>leave-one-out</small></div>' +
        '<div class="note">walk-forward <b>' + f.walkforward_median_factor.toFixed(2) + '\u00d7</b> median factor miss, ' + f.n + ' refits</div></div>' +
      '<div class="kpi"><div class="label">Is the band honest?</div><div class="value">' + pct(f.band_coverage) + ' <small>inside P25\u2013P75</small></div>' +
        '<div class="note">of leave-one-out misses, against <b>50%</b> if the band were exactly right</div></div>' +
      '<div class="kpi"><div class="label">Peer token rate</div><div class="value">' + pct(R.report.odds.base_rate) + ' <small>base rate</small></div>' +
        '<div class="note">ages ' + R.report.training.n + ' protocols, score AUC <b>' + R.report.odds.auc.toFixed(2) + '</b></div></div>' +
      '<div class="kpi"><div class="label">Worth the fees</div><div class="value">' + farmable + ' <small>of ' + rows.length + '</small></div>' +
        '<div class="note">convex or marginal on the printed plan; <b>' + R.counts.watchlist + '/40</b> watchlist protocols ranked</div></div>' +
      '</section>';
  }

  // ------------------------------------------------------------ board
  function options() {
    var cats = {}, chains = {};
    rows.forEach(function (r) {
      if (r.category) cats[r.category] = (cats[r.category] || 0) + 1;
      r.chains.forEach(function (c) { chains[c] = (chains[c] || 0) + 1; });
    });
    function opts(map) {
      return Object.keys(map).sort(function (a, b) { return map[b] - map[a]; })
        .map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + ' (' + map[k] + ')</option>'; }).join('');
    }
    return { cats: opts(cats), chains: opts(chains) };
  }

  function filteredRows() {
    var q = state.q.toLowerCase();
    return rows.filter(function (r) {
      if (state.filter === 'watch' && !r.watch) return false;
      if (state.filter === 'early' && r.watch) return false;
      if (state.filter === 'farm' && r.verdict === 'SKIP') return false;
      if (state.filter === 'skip' && r.verdict !== 'SKIP') return false;
      if (state.category && r.category !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (q && (r.name + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) {
      if (state.sort === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (state.sort === 'rate') return b.peer_token_rate - a.peer_token_rate;
      if (state.sort === 'age') return (a.age_days || 0) - (b.age_days || 0);
      if (state.sort === 'change') return (b.change_7d || 0) - (a.change_7d || 0);
      if (state.sort === 'value') return b.value_if_launched_usd - a.value_if_launched_usd;
      return a.rank - b.rank;
    });
  }

  function rowHtml(r) {
    var t = tierOf(r);
    var change = r.change_7d === null ? '<span class="muted">n/a</span>' : '<span class="' + (r.change_7d >= 0 ? 'up' : 'down') + '">' + fmtPct(r.change_7d) + '</span>';
    return '<tr data-slug="' + esc(r.slug) + '">' +
      '<td class="rank">' + r.rank + '</td>' +
      '<td class="name"><div class="n">' + esc(r.name) + '<span class="pill ' + (r.watch ? 'wl">watchlist' : 'early">early') + '</span></div>' +
        '<div class="c">' + esc(r.category || 'uncategorised') + ' \u00b7 ' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</div></td>' +
      '<td class="tvl">' + fmtUsd(r.tvl_usd) + '</td>' +
      '<td class="num">' + change + '</td>' +
      '<td class="num">' + fmtAge(r.age_days) + '</td>' +
      '<td class="rate"><div class="v">' + pct(r.peer_token_rate) + '</div><div class="track"><i style="width:' + Math.min(100, r.peer_token_rate * 300).toFixed(0) + '%"></i></div></td>' +
      '<td class="band"><div class="top"><span class="implied">' + fmtUsd(r.implied_value_usd) + '</span><span class="range">' + fmtUsd(r.band_low_usd) + '\u2013' + fmtUsd(r.band_high_usd) + '</span></div>' + bandBar(r) + '</td>' +
      '<td class="verdict"><span class="tag ' + t + '">' + r.verdict + '</span>' + esc(money0(r.net_of_fees_usd_lo) + '\u2013' + money0(r.net_of_fees_usd_hi)) + '<div class="reason">net on a $10,000 plan</div></td>' +
      '<td class="farm">' + fmtUsd(r.farm_cost_usd) + '<br><span class="reason">' + r.hours_per_week + ' h/wk</span></td>' +
      '</tr>';
  }

  function tableHtml(list, sortable) {
    var head = '<thead><tr>' +
      '<th class="num' + (sortable && state.sort === 'rank' ? ' sorted' : '') + '" data-sort="rank">#</th>' +
      '<th>Protocol</th>' +
      '<th class="num' + (sortable && state.sort === 'tvl' ? ' sorted' : '') + '" data-sort="tvl">TVL</th>' +
      '<th class="num' + (sortable && state.sort === 'change' ? ' sorted' : '') + '" data-sort="change">7-day</th>' +
      '<th class="num' + (sortable && state.sort === 'age' ? ' sorted' : '') + '" data-sort="age">Age</th>' +
      '<th class="' + (sortable && state.sort === 'rate' ? 'sorted' : '') + '" data-sort="rate">Peer token rate</th>' +
      '<th class="' + (sortable && state.sort === 'value' ? 'sorted' : '') + '" data-sort="value">Implied value if launched (P25\u2013P75)</th>' +
      '<th>Verdict</th><th class="num">Farm cost</th></tr></thead>';
    return '<div class="table-wrap"><table>' + head + '<tbody>' + list.map(rowHtml).join('') + '</tbody></table></div>';
  }

  function renderBoard() {
    var list = filteredRows();
    var o = options();
    var chips = [['all', 'All', rows.length], ['watch', 'Watchlist', R.counts.watchlist], ['early', 'Early', R.counts.early],
      ['farm', 'Worth the fees', rows.filter(function (r) { return r.verdict !== 'SKIP'; }).length],
      ['skip', 'Skip', rows.filter(function (r) { return r.verdict === 'SKIP'; }).length]];
    var chipsHtml = chips.map(function (c) {
      return '<button class="chip" data-filter="' + c[0] + '" aria-pressed="' + (state.filter === c[0]) + '">' + c[1] + '<b>' + c[2] + '</b></button>';
    }).join('');
    return kpis() +
      '<div class="controls">' + chipsHtml +
      '<input type="search" id="q" placeholder="Name, chain or category" value="' + esc(state.q) + '" aria-label="Search the board">' +
      '<select id="cat" aria-label="Category"><option value="">All categories</option>' + o.cats + '</select>' +
      '<select id="chain" aria-label="Chain"><option value="">All chains</option>' + o.chains + '</select>' +
      '<span class="spacer"></span><span class="count">' + list.length + ' of ' + rows.length + ' rows \u00b7 ' + fmtUsd(list.reduce(function (s, r) { return s + r.implied_value_usd; }, 0)) + ' implied in this view</span></div>' +
      tableHtml(list, true) +
      '<p class="axis-note">Rank is the model\u2019s claim, not the array\u2019s order: click a column to re-sort, a row to open its record. The band is the P25\u2013P75 of the fit\u2019s own residuals; it is wide because the fit is honest about how little a TVL buys.</p>';
  }

  // ------------------------------------------------------------ detail
  function compsTable(r) {
    var body = r.comps.map(function (c) {
      return '<tr><td>' + esc(c.name) + '</td><td class="num">' + fmtUsd(c.tvl_usd) + '</td><td class="num">' + fmtUsd(c.mcap_usd) + '</td><td class="num">' + c.multiple.toFixed(2) + '\u00d7</td></tr>';
    }).join('');
    return '<table class="comps"><thead><tr><th>Nearest tokenised peer</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">mcap / TVL</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function renderDetail(slug) {
    var r = bySlug[slug] || rows[0];
    var lo = Math.log10(Math.max(1, r.band_low_usd));
    var hi = Math.log10(Math.max(1, r.band_high_usd));
    var mid = Math.log10(Math.max(1, r.implied_value_usd));
    var span = hi - lo || 1;
    var left = Math.max(0, Math.min(100, ((mid - lo) / span) * 100));
    var steps = r.farm_steps.map(function (s) {
      var m = s.match(/^(.*?)\s+Cost:\s*(.*?)\s+Time:\s*([^.]*)\.?$/);
      if (m) return '<li>' + esc(m[1]) + '<span class="meta">' + esc(m[2]) + ' \u00b7 ' + esc(m[3].replace(/\.$/, '')) + '</span></li>';
      return '<li>' + esc(s) + '</li>';
    }).join('');
    return '<a class="back" href="#board">\u2190 back to the board</a>' +
      '<div class="detail-head"><div><h2>' + esc(r.name) + '</h2><p class="sub">' + esc(r.category || 'uncategorised') + ' \u00b7 ' + esc(r.chains.join(', ')) + ' \u00b7 recorded for ' + fmtAge(r.age_days) + ' without a token \u00b7 rank ' + r.rank + ' of ' + rows.length + '</p></div>' +
      '<div class="count">' + (r.watch ? 'on the watchlist' : 'early: below the watchlist floor') + '</div></div>' +
      '<div class="grid2"><div class="panel"><h3>What it could be worth<span>the fit, not a promise</span></h3>' +
        '<div class="big"><span class="n">' + fmtUsd(r.implied_value_usd) + '</span><span class="u">implied value, P25\u2013P75 ' + fmtUsd(r.band_low_usd) + ' to ' + fmtUsd(r.band_high_usd) + '</span></div>' +
        '<div class="bandbar"><span class="mid" style="left:0;right:0"></span><span class="mean" style="left:' + left.toFixed(1) + '%"></span><span class="lbl" style="left:0">' + fmtUsd(r.band_low_usd) + '</span><span class="lbl" style="right:0">' + fmtUsd(r.band_high_usd) + '</span></div>' +
        '<div class="axis-note">The band is the P25\u2013P75 of the fit\u2019s own residuals on the log scale: half the protocols like this one land inside it, half do not.</div>' +
        '<div class="split">' +
          '<div><div class="k">If its token launched</div><div class="v">' + fmtUsd(r.value_if_launched_usd) + '</div><div class="s">' + r.multiple.toFixed(2) + '\u00d7 its ' + fmtUsd(r.tvl_usd) + ' TVL</div></div>' +
          '<div><div class="k">Peer token rate</div><div class="v">' + pct(r.peer_token_rate) + '</div><div class="s">of protocols tracked this long record a token</div></div>' +
          '<div><div class="k">Seven-day TVL</div><div class="v">' + (r.change_7d === null ? 'n/a' : fmtPct(r.change_7d)) + '</div><div class="s">shown, not fitted: the term lost its refit</div></div>' +
        '</div>' +
        '<h3 style="margin-top:16px">Why the value sits here<span>its nearest tokenised peers</span></h3>' + compsTable(r) +
      '</div>' +
      '<div class="panel"><h3>The plan<span>six steps, each with a cost and a time</span></h3><ol class="steps">' + steps + '</ol>' +
        '<div class="split" style="grid-template-columns:1fr 1fr"><div><div class="k">Capital asked</div><div class="v">' + fmtUsd(r.farm_cost_usd) + '</div><div class="s">0.2% of TVL, floored at $250 and capped at $5,000</div></div>' +
        '<div><div class="k">Net of fees</div><div class="v">' + money0(r.net_of_fees_usd_lo) + '\u2013' + money0(r.net_of_fees_usd_hi) + '</div><div class="s">on $10,000 at this TVL share, drop at P25, 0.5% fee and $2.50 gas</div></div></div>' +
        '<p class="axis-note">' + esc(r.verdict_line) + '</p></div></div>';
  }

  // ------------------------------------------------------------ filtered
  function renderFiltered() {
    var early = rows.filter(function (r) { return !r.watch; });
    var watch = rows.filter(function (r) { return r.watch; });
    var list = early.slice().sort(function (a, b) { return b.peer_token_rate - a.peer_token_rate || a.rank - b.rank; }).slice(0, 40);
    var medianTvl = list.map(function (r) { return r.tvl_usd; }).sort(function (a, b) { return a - b; })[Math.floor(list.length / 2)];
    var setAside = R.set_aside.slice(0, 10).map(function (s) {
      return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.category || 'uncategorised') + '</td><td class="num">' + fmtUsd(s.tvl_usd) + '</td><td class="reason">' + esc(s.reason) + '</td></tr>';
    }).join('');
    return '<div class="filtered-head"><div><h2>Filtered view: early tier</h2>' +
      '<p>Every ranked protocol below the $50M watchlist floor, sorted by the peer token rate rather than by value: not the biggest implied numbers, the ones where a token is most likely to record at all. The watchlist holds ' + watch.length + ' of the ' + rows.length + ' rows; the other ' + early.length + ' are the early tier this view isolates.</p></div>' +
      '<div class="count">' + early.length + ' early \u00b7 median TVL in view ' + fmtUsd(medianTvl || 0) + '</div></div>' +
      '<div class="controls"><button class="chip" aria-pressed="true">Early tier<b>' + early.length + '</b></button>' +
      '<button class="chip" aria-pressed="false" disabled>Below the $50M floor</button>' +
      '<span class="spacer"></span><span class="count">sorted by peer token rate \u00b7 top ' + list.length + ' of ' + early.length + '</span></div>' +
      tableHtml(list, false) +
      '<section class="setaside panel"><h3>Set aside, not ranked<span>' + R.counts.set_aside + ' derivatives of tokens that already trade</span></h3>' +
      '<p style="margin-top:-2px">A wrapped, staked or bridged child of a protocol whose token trades is not a launch candidate, so the board leaves it out and says why. These are the ten largest by TVL; the rest are in the data the page reads.</p>' +
      '<table class="comps"><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th>Why it is set aside</th></tr></thead><tbody>' + setAside + '</tbody></table></section>';
  }

  // ------------------------------------------------------------ method
  function renderMethod() {
    var f = R.report.fit;
    var termRows = '<tr class="kept-row"><td><b>log\u2081\u2080 TVL</b></td><td class="num">' + f.loo_median_factor.toFixed(2) + '\u00d7</td><td class="num">' + f.walkforward_median_factor.toFixed(2) + '\u00d7</td><td class="kept">kept</td><td class="why">the one term that lowered the leave-one-out miss on its own</td></tr>' +
      R.report.terms.map(function (t) {
        return '<tr><td>' + esc(t.term) + '</td><td class="num">' + t.loo_median_factor.toFixed(2) + '\u00d7</td><td class="num">' + t.walkforward_median_factor.toFixed(2) + '\u00d7</td>' +
          '<td class="' + (t.kept ? 'kept' : 'dropped') + '">' + (t.kept ? 'kept' : 'tested, not kept') + '</td><td class="why">' + esc(t.note) + '</td></tr>';
      }).join('');
    var o = R.report.odds;
    return '<h2 style="margin:0 0 4px;font-size:24px">Method</h2>' +
      '<p style="margin:0 0 14px;color:var(--muted);font-size:12.5px;max-width:900px">Two fits on one frozen snapshot: a value model on the protocols whose token trades, and a peer token rate on every protocol the snapshot dates. Both are refit at run time from the snapshot itself; nothing below is a constant typed into the page.</p>' +
      '<div class="method"><div class="panel"><h3>The value model<span>fitted, then tested term by term</span></h3>' +
        '<div class="formula">log\u2081\u2080 market cap = <b>' + f.intercept.toFixed(3) + '</b> + <b>' + f.slope.toFixed(3) + '</b> \u00d7 log\u2081\u2080 TVL<br>implied value = 10<sup>that</sup> \u00b7 the P25\u2013P75 band is the same line plus the residual quartiles</div>' +
        '<p>Fitted by least squares on ' + f.n + ' protocols that record both a token and a market cap, then refit ' + f.n + ' times leaving one out. The slope below 1 is the finding: TVL buys market cap, but less than proportionally, and the fit explains only R\u00b2 ' + f.r2.toFixed(2) + ' of the spread, which is why every row carries a band.</p>' +
        '<table class="terms"><thead><tr><th>Term</th><th class="num">Leave-one-out</th><th class="num">Walk-forward</th><th>Verdict</th><th>Note</th></tr></thead><tbody>' + termRows + '</tbody></table>' +
        '<p style="margin-top:10px">A term is kept only when it lowers the leave-one-out miss by two per cent or more against the one-term fit. None did: each extra column buys a little in-sample and gives it back out-of-sample, so the board does not use them, and says so rather than hiding the test. Growth and age still appear in every row and in the peer token rate.</p></div>' +
      '<div><div class="panel"><h3>The plan, and what its verdict means<span>the formula every row is scored on</span></h3>' +
        '<div class="formula">expected = (P25 \u00f7 TVL) \u00d7 peer token rate<br>net = expected \u00d7 0.995 \u2212 0.00025 \u00b7 shown per $10,000 of TVL<br>CONVEX \u2265 0.8% \u00b7 MARGINAL \u2265 0.3% \u00b7 SKIP below</div>' +
        '<p>Expected dollars of launch value per dollar of TVL, at the cautious end of the band and discounted by the chance a token ever records. The 0.5% is the fee on the drop and the 0.00025 is $2.50 of gas per $10,000. CONVEX means the cautious, odds-discounted case still returns 0.8% or more; MARGINAL 0.3% or more; SKIP means the fees eat it. The verdict is a plan, not a prediction.</p></div>' +
        '<div class="panel" style="margin-top:12px"><h3>Is the band honest?<span>coverage, not width</span></h3>' +
        '<p>A band is worth what it covers. The P25\u2013P75 offsets are the fitted residuals\u2019 own quartiles (' + f.residual_q25.toFixed(2) + ' and ' + f.residual_q75.toFixed(2) + ' in log\u2081\u2080), so half the misses should fall inside.</p>' +
        '<div class="kv"><dt>Leave-one-out coverage</dt><dd>' + pct(f.band_coverage) + '</dd><dt>Leave-one-out median miss</dt><dd>' + f.loo_median_factor.toFixed(2) + '\u00d7</dd><dt>Walk-forward median miss</dt><dd>' + f.walkforward_median_factor.toFixed(2) + '\u00d7</dd><dt>In-sample median miss</dt><dd>' + f.in_sample_median_factor.toFixed(2) + '\u00d7</dd></div>' +
        '<p style="margin-top:8px">The published band is not narrowed to look confident: a reader who farms on it should know the fit is a median, not a forecast.</p></div>' +
        '<div class="panel" style="margin-top:12px"><h3>The peer token rate<span>how long it has run without one</span></h3>' +
        '<div class="formula">p(token) = 1 / (1 + e^(\u2212(<b>' + o.c0.toFixed(2) + '</b> + <b>' + o.c1.toFixed(2) + '</b> \u00d7 log\u2081\u2080 age + <b>' + o.c2.toFixed(2) + '</b> \u00d7 log\u2081\u2080 TVL)))</div>' +
        '<p>A logistic fit on ' + o.n + ' protocols the snapshot dates, ' + pct(o.base_rate) + ' of which record a token. It scores AUC ' + o.auc.toFixed(2) + ': older protocols record tokens more often, and TVL adds almost nothing. It is a peer rate, not a forecast that a token will be issued, and the rules are explicit that this entry does not make one.</p></div>' +
        '<div class="panel" style="margin-top:12px"><h3>The dataset, and what is set aside<span>one frozen snapshot</span></h3>' +
        '<div class="kv"><dt>Snapshot</dt><dd>' + R.meta.as_of + '</dd><dt>Protocols</dt><dd>' + R.report.training.snapshot + '</dd><dt>Record a token</dt><dd>' + R.report.training.tokenised + '</dd><dt>Record none</dt><dd>' + R.report.training.pre_token + '</dd><dt>Watchlist</dt><dd>' + R.report.training.watchlist + '</dd><dt>Ranked here</dt><dd>' + R.counts.ranked + '</dd><dt>Set aside as derivatives</dt><dd>' + R.counts.set_aside + '</dd></div>' +
        '<ul class="note-list" style="margin-top:10px"><li>No protocol name is special-cased: the same two fits score every row.</li><li>No network at run time: the snapshot is the only input, and the page reads one script.</li><li>A protocol that records no token may still have one; the board says what DefiLlama records, not what is true.</li><li>An implied value is the entry\u2019s own claim. It is not investment advice and not a promise of a launch.</li></ul></div>' +
      '</div></div>';
  }

  // ------------------------------------------------------------ routing
  function setTab(name) {
    var links = document.querySelectorAll('.tabs a');
    for (var i = 0; i < links.length; i++) {
      var tab = links[i].getAttribute('data-tab');
      if (tab === name) links[i].setAttribute('aria-current', 'page');
      else links[i].removeAttribute('aria-current');
    }
  }

  function route() {
    var hash = (location.hash || '#board').replace(/^#/, '');
    var parts = hash.split('/');
    var tab = parts[0] || 'board';
    if (tab !== 'board') tab = parts[0];
    if (tab === 'detail') {
      view.innerHTML = renderDetail(parts[1] || rows[0].slug);
      setTab('detail');
    } else if (tab === 'filtered') {
      view.innerHTML = renderFiltered();
      setTab('filtered');
    } else if (tab === 'method') {
      view.innerHTML = renderMethod();
      setTab('method');
    } else {
      view.innerHTML = renderBoard();
      setTab('board');
      var q = document.getElementById('q');
      if (q) q.value = state.q;
      var cat = document.getElementById('cat');
      if (cat) cat.value = state.category;
      var chain = document.getElementById('chain');
      if (chain) chain.value = state.chain;
    }
    view.setAttribute('aria-busy', 'false');
    window.scrollTo(0, 0);
  }

  view.addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('tr[data-slug]') : null;
    if (row) { location.hash = '#detail/' + row.getAttribute('data-slug'); return; }
    var chip = e.target.closest ? e.target.closest('[data-filter]') : null;
    if (chip) { state.filter = chip.getAttribute('data-filter'); route(); return; }
    var th = e.target.closest ? e.target.closest('th[data-sort]') : null;
    if (th) { state.sort = th.getAttribute('data-sort'); route(); }
  });
  view.addEventListener('input', function (e) {
    if (e.target.id === 'q') { state.q = e.target.value; var list = filteredRows(); var body = document.querySelector('tbody'); if (body) body.innerHTML = list.map(rowHtml).join(''); }
  });
  view.addEventListener('change', function (e) {
    if (e.target.id === 'cat') { state.category = e.target.value; route(); }
    if (e.target.id === 'chain') { state.chain = e.target.value; route(); }
  });
  window.addEventListener('hashchange', route);
  route();
})();
