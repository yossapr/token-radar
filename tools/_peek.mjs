import { readFileSync } from 'node:fs';
const src = readFileSync('out/data.js','utf8');
const R = JSON.parse(src.replace(/^window\.RADAR=/,'').replace(/;\s*$/,''));
const pick = ['steakhouse-financial','symbiotic'];
for (const slug of pick) { const r = R.rows.find(x=>x.slug===slug); console.log(JSON.stringify({slug, name:r?.name, rank:r?.rank, watch:r?.watch, verdict:r?.verdict, tvl:r?.tvl_usd, implied:r?.implied_value_usd, low:r?.band_low_usd, high:r?.band_high_usd, cats:r?.category, chains:r?.chains.length})); }
console.log('counts', JSON.stringify(R.counts));
const v = {}; for (const r of R.rows) v[r.verdict]=(v[r.verdict]||0)+1; console.log(JSON.stringify(v));
console.log('early sample', JSON.stringify(R.rows.filter(r=>r.tvl_usd<1e7).slice(0,3).map(r=>({n:r.name,t:r.tvl_usd,v:r.verdict}))));
console.log('cats', JSON.stringify([...new Set(R.rows.map(r=>r.category))].length));