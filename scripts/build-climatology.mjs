// Builds reference/climatology.json: per station, per month rainfall statistics for 1991-2020.
// Source: Open-Meteo historical archive (ERA5 reanalysis). This is a PROXY: gridded data understates
// point extremes and overstates drizzle days. Production should compute the same table from CLIDATA.
import { writeFileSync } from 'node:fs';
import { STATIONS } from '../public/core.js';
const out = { source: 'Open-Meteo archive (ERA5), 1991-2020, proxy for station climatology', built: new Date().toISOString(), stations: {} };
for (const s of STATIONS) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${s.lat}&longitude=${s.lon}&start_date=1991-01-01&end_date=2020-12-31&daily=precipitation_sum&timezone=GMT`;
  let d;
  for (let attempt = 1; attempt <= 6 && !d; attempt++) {
    const r = await (await fetch(url)).json();
    d = r.daily;
    if (!d) { console.log(`  ${s.name}: ${r.reason || 'no data'}, retrying in ${attempt * 20}s`); await new Promise((ok) => setTimeout(ok, attempt * 20000)); }
  }
  if (!d) throw new Error('climatology fetch failed for ' + s.name);
  await new Promise((ok) => setTimeout(ok, 3000));
  const months = {};
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const all = d.precipitation_sum.filter((x, i) => d.time[i].slice(5, 7) === mm && x != null);
    const wet = all.filter((x) => x >= 1).sort((a, b) => a - b);
    const q = (f) => (wet.length ? wet[Math.floor(f * (wet.length - 1))] : 0);
    months[m] = { days: all.length, wetFreq: +(wet.length / all.length).toFixed(3), p90: +q(0.9).toFixed(1), p99: +q(0.99).toFixed(1), max: +(wet.at(-1) ?? 0).toFixed(1) };
  }
  out.stations[s.id] = months;
  console.log(s.name.padEnd(12), 'Jan', months[1].wetFreq, 'Aug p99', months[8].p99, 'max', months[8].max);
}
writeFileSync(new URL('../reference/climatology.json', import.meta.url), JSON.stringify(out, null, 1));
