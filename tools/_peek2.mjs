import { readFileSync } from 'node:fs';
const R = JSON.parse(readFileSync('out/data.js','utf8').replace(/^window\.RADAR=/,'').replace(/;\s*$/,''));
const w = R.rows.filter(r=>r.watch);
console.log('watch verdicts', JSON.stringify(w.reduce((a,r)=>(a[r.verdict]=(a[r.verdict]||0)+1,a),{})));
console.log('watch convex', JSON.stringify(w.filter(r=>r.verdict==='CONVEX').slice(0,6).map(r=>({n:r.name,t:r.tvl_usd,i:r.implied_value_usd,lo:r.band_low_usd,hi:r.band_high_usd,c:r.category}))));
console.log('risk curators', JSON.stringify(R.rows.filter(r=>r.category==='Risk Curators').slice(0,8).map(r=>({n:r.name,t:r.tvl_usd,i:r.implied_value_usd,v:r.verdict,w:r.watch}))));