import { readFileSync } from 'node:fs';
const m = JSON.parse(readFileSync(process.argv[2],'utf8'));
console.log('keys', Object.keys(m));
for (const k of Object.keys(m)) { const v = m[k]; if (k === 'system_prompt' || (typeof v === 'string' && v.length > 300)) console.log(k, '<string len ' + v.length + '>'); else console.log(k, JSON.stringify(v).slice(0,400)); }