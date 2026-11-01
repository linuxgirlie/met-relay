// Golden test: the shared core must reproduce the GMet EDR (Takoradi, Jan 2026).
import { readFileSync } from 'node:fs';
import { relHumidity, dewPoint, vapourPressure, encodeSynop, stationById, validateSynop } from '../public/core.js';
const rows = JSON.parse(readFileSync(new URL('./takoradi_golden.json', import.meta.url)));
const stn = stationById('23003TDI');
const byKey = new Map(rows.map((r) => [`${r.DAY}-${r.HR}`, r]));
let n = 0, rh = 0, td = 0, vp = 0, s1 = 0, s1n = 0, malformed = [];
const miss = [];
for (const r of rows) {
  if (typeof r.TT !== 'number' || typeof r.TW !== 'number') continue;
  n++;
  const RH = relHumidity(r.TT, r.TW), Td = dewPoint(r.TT, RH), VP = vapourPressure(Td);
  if (RH === r.RH) rh++; if (Td === r.TD) td++; if (VP === r.VP) vp++;
  if (r.SYNOP.startsWith('WRITE')) continue;
  if (!validateSynop(r.SYNOP).ok) malformed.push(`${r.DAY}/${r.HR}: ${validateSynop(r.SYNOP).bad}`);
  const prev = byKey.get(`${r.DAY - 1}-${r.HR}`);
  const obs = { hour: r.HR, T: r.TT, Tw: r.TW, vis_km: r.VV > 50 ? r.VV - 50 : r.VV / 10, cloudBase_m: [25, 75, 150, 250, 450, 800, 1250, 1750, 2250, 3000][r.H],
    N: r.N, windDir: r.DD * 10, windKt: r.FF, mslp: 1000 + r.MSLP, ww: r.WW, W1W2: r.W1W2, Nh: r.Nh, CL: r.CL, CM: r.CM, CH: r.CH,
    rr: [0, 6, 12, 18].includes(r.HR) ? r.RR : undefined };
  if (obs.windDir === 0) obs.windDir = 'CALM';
  const mine = encodeSynop(obs, stn).split('333')[0].replace(/\s+RH .*$/, '').trim();
  const gmet = r.SYNOP.split('333')[0].trim();
  s1n++; if (mine === gmet) s1++; else if (miss.length < 6) miss.push(`${r.DAY}/${r.HR}\n  EDR : ${gmet}\n  core: ${mine}`);
}
const pct = (a, b) => `${a}/${b} (${((100 * a) / b).toFixed(1)}%)`;
console.log('RH  match', pct(rh, n)); console.log('Td  match', pct(td, n)); console.log('VP  match', pct(vp, n));
console.log('SYNOP section 0–1 exact match', pct(s1, s1n));
console.log('Malformed groups in the real EDR output:', malformed.length, malformed.slice(0, 5));
if (miss.length) console.log('First mismatches:\n' + miss.join('\n'));
