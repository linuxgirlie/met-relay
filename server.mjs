// NGDA 2026 · GMet whole-chain MVP, one process, zero npm dependencies (Node >= 22).
// Services inside: backbone (WIS2-style notifications + SSE), ingest, CLIDATA adapter, KIAMO/GTS,
// forecast candidates + verification, product service (author once → CAP/SMS/social/web/GeoJSON), ClimWeb sim.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as core from './public/core.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || join(ROOT, 'data');
for (const d of ['clidata', 'gts', 'cache', 'products']) mkdirSync(join(DATA, d), { recursive: true });
const PORT = Number(process.env.PORT || 8787);
const db = new DatabaseSync(join(DATA, 'chain.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, observer TEXT, station TEXT, jwk TEXT, enrolled TEXT);
CREATE TABLE IF NOT EXISTS obs(id TEXT PRIMARY KEY, station TEXT, date TEXT, hour INT, observer TEXT, device TEXT,
  payload TEXT, derived TEXT, flags TEXT, synop TEXT, status TEXT, captured TEXT, received TEXT, supersedes TEXT);
CREATE TABLE IF NOT EXISTS custody(obs TEXT, at TEXT, stage TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, topic TEXT, at TEXT, body TEXT);
CREATE TABLE IF NOT EXISTS gts(id TEXT PRIMARY KEY, obs TEXT, station TEXT, synop TEXT, state TEXT, queued TEXT, released TEXT, releasedBy TEXT, bulletin TEXT);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, kind TEXT, state TEXT, body TEXT, created TEXT, approvedBy TEXT, issued TEXT);
CREATE TABLE IF NOT EXISTS issues(product TEXT, channel TEXT, at TEXT, ref TEXT, content TEXT);
CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY, obs TEXT, station TEXT, kind TEXT, value REAL, msg TEXT, at TEXT, state TEXT);
CREATE TABLE IF NOT EXISTS subscribers(id TEXT PRIMARY KEY, region TEXT, district TEXT, sector TEXT, channel TEXT, language TEXT);
`);
const now = () => new Date().toISOString();
const q = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

// ============ Backbone: WIS 2.0-shaped notifications (production: Mosquitto MQTT) ============
const sse = new Set();
function publish(topic, properties, links = []) {
  const n = { id: randomUUID(), conformsTo: ['http://wis.wmo.int/spec/wnm/1/conf/core'], type: 'Feature', geometry: properties.geometry ?? null,
    properties: { pubtime: now(), ...properties, geometry: undefined }, links, topic };
  run('INSERT INTO notifications VALUES(?,?,?,?)', n.id, topic, n.properties.pubtime, JSON.stringify(n));
  const line = `data: ${JSON.stringify(n)}\n\n`;
  for (const res of sse) res.write(line);
  for (const [prefix, fn] of subscribers) if (topic.startsWith(prefix)) queueMicrotask(() => fn(n));
  return n;
}
const subscribers = [];
const subscribe = (prefix, fn) => subscribers.push([prefix, fn]);
const custody = (obs, stage, detail = '') => { run('INSERT INTO custody VALUES(?,?,?,?)', obs, now(), stage, detail); publish('internal/custody', { obs, stage, detail }); };
const TOPIC = 'origin/a/wis2/gh-gmet/data/core/weather/surface-based-observations';

// ============ Ingest: verify signature → recompute → QC → publish once ============
async function verify(deviceId, body, sigB64) {
  const dev = q('SELECT * FROM devices WHERE id=?', deviceId)[0];
  if (!dev) return { ok: false, why: 'unknown device' };
  const key = await webcrypto.subtle.importKey('jwk', JSON.parse(dev.jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sigB64, 'base64'), new TextEncoder().encode(core.canonical(body)));
  return { ok, dev, why: ok ? '' : 'signature invalid, payload altered or wrong key' };
}
async function ingest(item) {
  const { obs, deviceId, sig } = item;
  const exists = q('SELECT id,status FROM obs WHERE id=?', obs.id)[0];
  if (exists) return { id: obs.id, status: 'duplicate-ack', ack: true }; // idempotent: resend is safe
  const v = await verify(deviceId, obs, sig);
  if (!v.ok) { custody(obs.id, 'rejected', v.why); return { id: obs.id, status: 'rejected', ack: false, why: v.why }; }
  const station = core.stationById(obs.station);
  // The server re-applies the same rules as the tablet: scheduled slot, every due field present or reported missing.
  if (!station || !core.TIER_HOURS[station.tier].includes(obs.hour)) { custody(obs.id, 'rejected', 'not a scheduled observation hour'); return { id: obs.id, status: 'rejected', ack: false, why: 'not a scheduled hour' }; }
  const gaps = core.incomplete(obs, station);
  if (gaps.length) { custody(obs.id, 'rejected', 'incomplete: ' + gaps.join(', ')); return { id: obs.id, status: 'rejected', ack: false, why: 'incomplete: ' + gaps.map((k) => core.FIELDS[k].l).join(', ') }; }
  const derived = core.derive(obs, station);
  // AD-03: recompute and compare with what the tablet showed the observer
  const diverge = Object.keys(derived).filter((k) => obs.derived && obs.derived[k] !== undefined && obs.derived[k] !== derived[k]);
  const lbl = (k) => core.FIELDS[k]?.l || k;
  const flags = (obs.qcDecisions || []).map((d) => d.decision === 'corrected'
    ? { ...d, msg: `${lbl(d.field)} corrected from ${d.from} to ${d.to} after the check prompt` }
    : { ...d, msg: `${lbl(d.field)} confirmed by observer. ${d.msg}` });
  if (diverge.length) flags.push({ field: diverge.join(','), msg: 'Device and server derivations differ, defect raised, device value retained', kind: 'divergence' });
  for (const [k, m] of Object.entries(obs.missing || {})) flags.push({ field: k, kind: 'missing', msg: `${core.FIELDS[k]?.l || k} not read: ${m.reason}${m.note ? ' (' + m.note + ')' : ''}` });
  if (obs.demoClock) flags.push({ kind: 'demo-clock', msg: 'Captured with the demo clock' });
  else if (!core.inWindow(obs.date, obs.hour, obs.capturedAt)) flags.push({ kind: 'time', msg: `Captured at ${obs.capturedAt.slice(11, 16)} GMT, outside the ${String(obs.hour).padStart(2, '0')}:00 window` });
  if (q('SELECT 1 FROM obs WHERE station=? AND date=? AND hour=?', obs.station, obs.date, obs.hour).length) flags.push({ kind: 'resubmission', msg: 'Second report for this slot' });
  const synop = station.tier === 'synoptic' ? core.encodeSynop({ ...obs, derived: undefined }, station) : null;
  run('INSERT INTO obs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', obs.id, obs.station, obs.date, obs.hour, v.dev.observer, deviceId, JSON.stringify(obs),
    JSON.stringify(derived), JSON.stringify(flags), synop, 'received', obs.capturedAt, now(), obs.supersedes || null);
  custody(obs.id, 'captured', `${station.name} ${obs.date} ${String(obs.hour).padStart(2, '0')}:00 by ${v.dev.observer} (device ${deviceId.slice(0, 8)})`);
  custody(obs.id, 'received', `signature verified · core ${core.CORE_VERSION} recomputed${diverge.length ? ' · DIVERGENCE' : ' · agrees with device'}`);
  if (flags.length) custody(obs.id, 'flagged', flags.map((f) => f.msg).join(' | '));
  // A rain extreme the observer confirmed at the gauge is an early-warning signal, not only a QC flag.
  for (const f of flags.filter((x) => x.kind === 'rain-extreme' && x.decision === 'confirmed')) {
    const id = randomUUID(), msg = `${station.name}: ${obs.rr} mm${obs.rrDays > 1 ? ` over ${obs.rrDays} days` : ''}, confirmed by ${v.dev.observer}`;
    run('INSERT INTO alerts VALUES(?,?,?,?,?,?,?,?)', id, obs.id, obs.station, 'heavy-rain', obs.rr, msg, now(), 'open');
    custody(obs.id, 'alert', 'confirmed heavy rain sent to forecasters');
    publish('internal/alerts', { alert: id, station: obs.station, kind: 'heavy-rain', value: obs.rr });
  }
  publish(TOPIC, { data_id: `gh-gmet/${obs.station}/${obs.date}T${String(obs.hour).padStart(2, '0')}`, datetime: `${obs.date}T${String(obs.hour).padStart(2, '0')}:00:00Z`,
    geometry: { type: 'Point', coordinates: [station.lon, station.lat] }, obs: obs.id, station: obs.station, tier: station.tier },
    [{ rel: 'canonical', type: 'application/json', href: `/api/obs/${obs.id}` }]);
  return { id: obs.id, status: 'received', ack: true, derived, synop };
}

// ============ Adapter: CLIDATA, observation rows in the 40-column schema (never SYNOP) ============
subscribe(TOPIC, (n) => {
  const r = q('SELECT * FROM obs WHERE id=?', n.properties.obs)[0];
  const obs = JSON.parse(r.payload), station = core.stationById(r.station);
  const file = join(DATA, 'clidata', `${station.id.replace(/\W/g, '_')}_${obs.date.slice(0, 7)}.csv`);
  if (!existsSync(file)) writeFileSync(file, core.CLIDATA_COLUMNS.join(',') + '\n');
  appendFileSync(file, core.clidataRow(obs, station).join(',') + '\n');
  run("UPDATE obs SET status='in-clidata' WHERE id=?", r.id);
  custody(r.id, 'clidata', `row appended to ${file.split('/data/')[1]}`);
});
// ============ Adapter: KIAMO release queue → GTS (synoptic only; human releases) ============
subscribe(TOPIC, (n) => {
  const r = q('SELECT * FROM obs WHERE id=?', n.properties.obs)[0];
  if (!r.synop) return;
  run('INSERT INTO gts VALUES(?,?,?,?,?,?,?,?,?)', randomUUID(), r.id, r.station, r.synop, 'queued', now(), null, null, null);
  custody(r.id, 'kiamo-queue', 'SYNOP awaiting KIAMO duty officer release');
});
function releaseGts(ids, officer) {
  const rows = ids.map((id) => q("SELECT * FROM gts WHERE id=? AND state='queued'", id)[0]).filter(Boolean);
  if (!rows.length) return null;
  const d = new Date(), YYGGgg = `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}00`;
  const bulletin = `SMGH01 DGAA ${YYGGgg}\nAAXX ${YYGGgg.slice(0, 4)}1\n` + rows.map((r) => r.synop.replace(/\s+RH .*$/, '').replace(/\s*=$/, '') + '=').join('\n') + '\n';
  const file = `SMGH01_DGAA_${d.toISOString().replace(/[:.]/g, '')}.txt`;
  writeFileSync(join(DATA, 'gts', file), bulletin);
  for (const r of rows) {
    run("UPDATE gts SET state='released', released=?, releasedBy=?, bulletin=? WHERE id=?", now(), officer, file, r.id);
    custody(r.obs, 'gts', `released by ${officer} in ${file}`);
  }
  publish('origin/a/wis2/gh-gmet/data/core/weather/gts-bulletins', { file, count: rows.length, officer });
  return { file, bulletin };
}

// ============ Forecast: model candidates (Open-Meteo: GFS, ECMWF IFS, ECMWF AIFS = AI) + verification gate ============
const MODELS = [{ id: 'gfs_seamless', label: 'GFS (NOAA)', ai: false }, { id: 'ecmwf_ifs025', label: 'ECMWF IFS', ai: false }, { id: 'ecmwf_aifs025_single', label: 'ECMWF AIFS (AI, inference-only)', ai: true }];
async function modelData(force = false) {
  const cache = join(DATA, 'cache', 'models.json');
  if (!force && existsSync(cache)) { const c = JSON.parse(readFileSync(cache)); if (Date.now() - Date.parse(c.fetched) < 3 * 3600e3) return c; }
  const lat = core.STATIONS.map((s) => s.lat).join(','), lon = core.STATIONS.map((s) => s.lon).join(',');
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation&models=${MODELS.map((m) => m.id).join(',')}&past_days=3&forecast_days=3&timezone=GMT`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(r.status);
    const arr = await r.json();
    const c = { fetched: now(), source: 'open-meteo.com (live)', stations: Object.fromEntries(core.STATIONS.map((s, i) => [s.id, arr[i].hourly])) };
    writeFileSync(cache, JSON.stringify(c));
    return c;
  } catch (e) {
    if (existsSync(cache)) return { ...JSON.parse(readFileSync(cache)), source: 'cached snapshot (offline)' };
    return { fetched: null, source: 'unavailable', stations: {} };
  }
}
// Value at an hour; linearly interpolates coarse (e.g. 6-hourly AIFS) output within ±6 h.
const at = (series, key, iso) => {
  const i = series?.time?.indexOf(iso.slice(0, 13) + ':00'), a = series?.[key];
  if (!(i >= 0) || !a) return null;
  if (a[i] != null) return a[i];
  let lo = i, hi = i;
  while (lo > i - 6 && lo > 0 && a[lo] == null) lo--;
  while (hi < i + 6 && hi < a.length - 1 && a[hi] == null) hi++;
  if (a[lo] == null || a[hi] == null || lo === hi) return null;
  return key.startsWith('precipitation') ? a[hi] / (hi - lo) : a[lo] + ((a[hi] - a[lo]) * (i - lo)) / (hi - lo);
};
const CLIM = JSON.parse(readFileSync(join(ROOT, 'reference', 'climatology.json'), 'utf8'));
const km = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * r), y = b.lat - a.lat; return Math.hypot(x, y) * 111.2; };
async function refFor(stationId, date, hour) {
  const me = core.stationById(stationId); if (!me) return {};
  const m = await modelData(); const s = m.stations[stationId];
  const iso = `${date}T${String(hour).padStart(2, '0')}`;
  const vals = s ? MODELS.map((x) => at(s, `temperature_2m_${x.id}`, iso)).filter((v) => v != null) : [];
  // Neighbours: same slot, within 250 km, temperature adjusted to this station's height (6.5 °C per km)
  const neighbours = q('SELECT station, payload FROM obs WHERE date=? AND hour=? AND station<>?', date, hour, stationId)
    .map((r) => ({ st: core.stationById(r.station), p: JSON.parse(r.payload) })).filter((x) => x.st && typeof x.p.T === 'number')
    .map((x) => ({ name: x.st.name, dist: Math.round(km(me, x.st)), T: Math.round((x.p.T + 0.0065 * (x.st.elev - me.elev)) * 10) / 10 }))
    .filter((x) => x.dist <= 250).sort((a, b) => a.dist - b.dist);
  // Dry bulbs this station reported over the previous 24 h (for the max and min check)
  const t0 = Date.parse(`${iso}:00:00Z`);
  const dayT = q('SELECT date, hour, payload FROM obs WHERE station=?', stationId).map((r) => ({ t: Date.parse(`${r.date}T${String(r.hour).padStart(2, '0')}:00:00Z`), hour: r.hour, T: JSON.parse(r.payload).T }))
    .filter((x) => typeof x.T === 'number' && x.t < t0 && x.t >= t0 - 24 * 3600e3).map(({ hour, T }) => ({ hour, T }));
  const climYear = CLIM.stations[stationId];
  return { refT: vals.length ? vals.reduce((a, b) => a + b) / vals.length : undefined, neighbours, dayT, clim: climYear?.[Number(date.slice(5, 7))], climYear, climSource: CLIM.source };
}
async function verification() {
  const m = await modelData();
  const obs = q('SELECT station,date,hour,payload FROM obs').map((r) => ({ ...r, p: JSON.parse(r.payload) })).filter((r) => typeof r.p.T === 'number');
  return MODELS.map((mod) => {
    const errs = [];
    for (const o of obs) { const f = at(m.stations[o.station], `temperature_2m_${mod.id}`, `${o.date}T${String(o.hour).padStart(2, '0')}`); if (f != null) errs.push(f - o.p.T); }
    const mae = errs.length ? errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length : null;
    const bias = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
    return { ...mod, n: errs.length, mae, bias, candidate: errs.length >= 3 && mae < 3, reason: errs.length < 3 ? 'insufficient verified pairs, not offered' : mae < 3 ? 'skill demonstrated' : 'MAE ≥ 3 °C, withheld' };
  });
}
async function candidates(stationId) {
  const m = await modelData(), ver = await verification(), s = m.stations[stationId];
  if (!s) return { source: m.source, series: [] };
  const t0 = new Date(); t0.setUTCMinutes(0, 0, 0);
  const hours = Array.from({ length: 48 }, (_, i) => new Date(t0.getTime() + i * 3600e3).toISOString().slice(0, 13));
  const series = MODELS.map((mod) => {
    const v = ver.find((x) => x.id === mod.id);
    return { ...mod, verification: v, t: hours.map((h) => at(s, `temperature_2m_${mod.id}`, h)), rr: hours.map((h) => at(s, `precipitation_${mod.id}`, h)) };
  });
  // Blend = bias-corrected mean of verified candidates (inspectable transform)
  const ok = series.filter((x) => x.verification.candidate);
  const use = ok.length ? ok : series;
  const blend = hours.map((_, i) => { const v = use.map((x) => (x.t[i] == null ? null : x.t[i] - (x.verification.candidate ? x.verification.bias || 0 : 0))).filter((y) => y != null); return v.length ? v.reduce((a, b) => a + b) / v.length : null; });
  const spread = hours.map((_, i) => { const v = series.map((x) => x.t[i]).filter((y) => y != null); return v.length ? Math.max(...v) - Math.min(...v) : null; });
  const rr24 = series.map((x) => ({ id: x.id, total: x.rr.slice(0, 24).reduce((a, b) => a + (b || 0), 0) }));
  return { source: m.source, fetched: m.fetched, hours, series, blend, spread, rr24, blendBasis: ok.length ? 'verified candidates, bias-corrected' : 'no verified candidates yet, unweighted mean (flagged)' };
}

// ============ Directed attention: agreement between candidate models, per station, next 24 h ============
async function attention() {
  const m = await modelData();
  const t0 = new Date(); t0.setUTCMinutes(0, 0, 0);
  const hours = Array.from({ length: 24 }, (_, i) => new Date(t0.getTime() + i * 3600e3).toISOString().slice(0, 13));
  return core.STATIONS.map((st) => {
    const s = m.stations[st.id];
    const per = MODELS.map((mod) => {
      const rr = hours.map((h) => at(s, `precipitation_${mod.id}`, h)), t = hours.map((h) => at(s, `temperature_2m_${mod.id}`, h)).filter((v) => v != null);
      return { id: mod.id, rain: rr.reduce((a, b) => a + (b || 0), 0), tmax: t.length ? Math.max(...t) : null };
    });
    const rains = per.map((p) => p.rain), tmaxs = per.map((p) => p.tmax).filter((v) => v != null);
    const rSpread = Math.max(...rains) - Math.min(...rains), rMean = rains.reduce((a, b) => a + b, 0) / rains.length;
    const tSpread = tmaxs.length ? Math.max(...tmaxs) - Math.min(...tmaxs) : 0;
    const rainAgree = rSpread <= Math.max(5, 0.5 * rMean), tempAgree = tSpread <= 2;
    return { station: st.id, name: st.name, region: st.region, district: st.district, models: per, rainSpread: rSpread, rainMean: rMean, tSpread,
      verdict: rainAgree && tempAgree ? 'agree' : 'judgment', reasons: [!rainAgree && 'rain', !tempAgree && 'temperature'].filter(Boolean) };
  }).sort((a, b) => (a.verdict === b.verdict ? b.rainSpread - a.rainSpread : a.verdict === 'judgment' ? -1 : 1));
}

// ============ Subscribers and crop calendar (synthetic registry; calendar illustrative) ============
const NORTH = ['Upper East', 'Upper West', 'Northern', 'Savannah', 'North East'];
// Illustrative planting windows, to be replaced by the CSIR-SARI / FAO calendars: [month, day] start and end.
const CROP_CALENDAR = [
  { zone: 'north', crop: 'maize', from: [5, 15], to: [7, 15] },
  { zone: 'south', crop: 'maize (major season)', from: [3, 15], to: [4, 30] },
  { zone: 'south', crop: 'maize (minor season)', from: [9, 1], to: [10, 15] },
];
const zoneOf = (region) => (NORTH.includes(region) ? 'north' : 'south');
function plantingWindow(region, when = new Date()) {
  const md = (when.getUTCMonth() + 1) * 100 + when.getUTCDate();
  return CROP_CALENDAR.find((c) => c.zone === zoneOf(region) && md >= c.from[0] * 100 + c.from[1] && md <= c.to[0] * 100 + c.to[1]) || null;
}
if (!q('SELECT COUNT(*) c FROM subscribers')[0].c) {
  // Deterministic synthetic registry: farmers, extension officers, NADMO coordinators per district. No real people.
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Main local language per region (farmers); English for everyone else. Upper East: Gurune and Kasem.
  const REGION_LANG = { 'Upper East': ['gur', 'gur', 'kas', 'en'], 'Upper West': ['dga', 'dga', 'en'], Northern: ['dag', 'dag', 'en'], Savannah: ['gon', 'dag', 'en'], 'North East': ['mam', 'dag', 'en'], Volta: ['ee', 'ee', 'en'] };
  const langFor = (region) => REGION_LANG[region] || ['tw', 'tw', 'en'];
  for (const st of core.STATIONS) {
    const add = (sector, channel, n) => { for (let i = 0; i < n; i++) run('INSERT INTO subscribers VALUES(?,?,?,?,?,?)', randomUUID(), st.region, st.district, sector, channel, sector === 'farmer' ? langFor(st.region)[Math.floor(rnd() * 3)] : 'en'); };
    add('farmer', 'sms', 40 + Math.floor(rnd() * 160)); add('extension officer', 'sms', 2 + Math.floor(rnd() * 6));
    add('disaster manager', 'email', 1 + Math.floor(rnd() * 3)); add('public', 'whatsapp', 20 + Math.floor(rnd() * 80));
  }
}
function route(p) {
  const districts = [...new Set(p.stations.map((id) => core.stationById(id)?.district).filter(Boolean))];
  const subs = districts.length ? q(`SELECT * FROM subscribers WHERE district IN (${districts.map(() => '?').join(',')})`, ...districts) : [];
  const groups = {};
  for (const s of subs) { const k = `${s.sector}|${s.channel}|${s.language}`; groups[k] = (groups[k] || 0) + 1; }
  const advisories = districts.map((d) => { const st = core.STATIONS.find((x) => x.district === d); const w = plantingWindow(st.region); return w && { district: d, crop: w.crop, text: `Planting window for ${w.crop}: good soil moisture expected. Avoid planting on waterlogged or flood-prone fields for the next 2 days.` }; }).filter(Boolean);
  return { districts, total: subs.length, groups: Object.entries(groups).map(([k, n]) => { const [sector, channel, language] = k.split('|'); return { sector, channel, language, n }; }).sort((a, b) => b.n - a.n), advisories };
}

// ============ Product service: author once → render many → publish with one record ============
// Languages without a reviewed translation are sent in English and marked pending until GMet supplies the text.
const LANG_NAMES = { en: 'English', tw: 'Twi', dag: 'Dagbani', gur: 'Gurune', kas: 'Kasem', dga: 'Dagaare', ee: 'Ewe', gon: 'Gonja', mam: 'Mampruli' };
const LANG = {
  en: { rain: 'Heavy rain expected', adv: 'Clear drains, avoid flooded roads, secure farm produce.', fc: 'Forecast' },
  tw: { rain: 'Osu kɛseɛ bɛtɔ', adv: 'Mo ntew nsuo kwan, mommfa kwan a nsuo ayiri so, mommɔ mo nnɔbaeɛ ho ban.', fc: 'Wiemhyɛ' },
  dag: { rain: 'Saa kpeŋ ni ni', adv: 'Pirim kulibɔŋa, di chaŋ soya din kuli n-yi, gbibi a pukparigu bindirigu.', fc: 'Saa tuma' },
};
function renderAll(p) {
  const st = p.stations.map(core.stationById);
  const onset = p.onset, expires = p.expires;
  const cap = `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>urn:oid:2.49.0.1.288.0.${p.id}</identifier><sender>forecast@meteo.gov.gh</sender><sent>${p.issued}</sent>
  <status>Actual</status><msgType>Alert</msgType><scope>Public</scope>
  <info><language>en</language><category>Met</category><event>${esc(p.event)}</event><urgency>Expected</urgency>
    <severity>${p.severity}</severity><certainty>${p.certainty}</certainty><onset>${onset}</onset><expires>${expires}</expires>
    <senderName>Ghana Meteorological Agency</senderName><headline>${esc(p.headline)}</headline><description>${esc(p.narrative)}</description>
    <instruction>${esc(LANG.en.adv)}</instruction>
${st.map((s) => `    <area><areaDesc>${s.district}, ${s.region}</areaDesc><circle>${s.lat},${s.lon} 25</circle></area>`).join('\n')}
  </info>
</alert>`;
  const sms = Object.fromEntries(Object.keys(LANG_NAMES).map((l) => [l, LANG[l] || { ...LANG.en, pending: true }]).map(([l, t]) => [l, st.map((s) => `GMet ${p.severity.toUpperCase()}: ${t.rain} - ${s.district} ${fmt(onset)}-${fmt(expires)}. ${t.adv}`.slice(0, 160))]));
  const social = `⚠️ ${p.headline}\n\n${p.narrative}\n\nAreas: ${st.map((s) => s.district).join(', ')}\nValid ${fmt(onset)} – ${fmt(expires)} GMT\nConfidence: ${p.certainty}\n#GhanaMet #WeatherAlert`;
  const geojson = { type: 'FeatureCollection', features: st.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    properties: { product: p.id, event: p.event, severity: p.severity, certainty: p.certainty, district: s.district, region: s.region, onset, expires, rr_expected_mm: p.rrExpected } })) };
  return { cap, sms, social, geojson, smsPending: Object.keys(LANG_NAMES).filter((l) => !LANG[l]), langNames: LANG_NAMES };
}
const CHANNELS = ['climweb', 'cap-feed', 'sms', 'facebook', 'x', 'whatsapp', 'instagram', 'youtube', 'linkedin', 'threads', 'email', 'partner-api'];
function issue(id, officer) {
  const r = q("SELECT * FROM products WHERE id=? AND state='draft'", id)[0];
  if (!r) return null;
  const p = { ...JSON.parse(r.body), issued: now(), approvedBy: officer };
  const out = renderAll(p);
  out.routing = route(p);
  // Only render SMS in languages someone in the affected districts actually reads (English always kept)
  out.sms = Object.fromEntries(Object.entries(out.sms).filter(([l]) => l === 'en' || out.routing.groups.some((g) => g.channel === 'sms' && g.language === l)));
  const dir = join(DATA, 'products', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'alert.cap.xml'), out.cap); writeFileSync(join(dir, 'product.geojson'), JSON.stringify(out.geojson, null, 1));
  writeFileSync(join(dir, 'sms.json'), JSON.stringify(out.sms, null, 1)); writeFileSync(join(dir, 'social.txt'), out.social);
  run("UPDATE products SET state='issued', body=?, approvedBy=?, issued=? WHERE id=?", JSON.stringify({ ...p, rendered: out }), officer, p.issued, id);
  for (const ch of CHANNELS) {
    const r = out.routing, count = (f) => r.groups.filter(f).reduce((a, g) => a + g.n, 0);
    const content = ch === 'sms' ? `${count((g) => g.channel === 'sms')} recipients in ${r.districts.length} district(s)` : ch === 'email' ? `${count((g) => g.channel === 'email')} disaster managers` : ch === 'whatsapp' ? `${count((g) => g.channel === 'whatsapp')} subscribers` : ch === 'cap-feed' || ch === 'climweb' ? 'alert.cap.xml' : ch === 'partner-api' ? 'product.geojson' : 'social card';
    run('INSERT INTO issues VALUES(?,?,?,?,?)', id, ch, now(), createHash('sha256').update(ch + id).digest('hex').slice(0, 10), content);
  }
  if (p.alert) run("UPDATE alerts SET state='handled' WHERE id=?", p.alert);
  publish('origin/a/wis2/gh-gmet/data/core/weather/advisories-warnings', { product: id, event: p.event, severity: p.severity, officer });
  return { ...p, rendered: out };
}

// ============ HTTP ============
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const fmt = (iso) => iso.slice(5, 16).replace('T', ' ');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.csv': 'text/csv', '.txt': 'text/plain; charset=utf-8' };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); });

const routes = {
  'GET /api/stations': () => core.STATIONS,
  'POST /api/enrol': async (b) => {
    // Enrolment while connected: observer authenticated against the directory (mock AD), device key bound to them.
    const AD = { 'kofi.mensah': '1234', 'ama.owusu': '1234', 'yaw.boateng': '1234', 'demo': '1234' };
    if (AD[b.observer] !== b.password) return [401, { error: 'Directory (AD) authentication failed' }];
    const id = randomUUID();
    run('INSERT INTO devices VALUES(?,?,?,?,?)', id, b.observer, b.station, JSON.stringify(b.jwk), now());
    return { deviceId: id, observer: b.observer, station: core.stationById(b.station) };
  },
  'POST /api/sync': async (b) => { const acks = []; for (const it of b.items || []) acks.push(await ingest(it)); return { acks }; },
  'GET /api/qc-context': async (_, u) => refFor(u.searchParams.get('station'), u.searchParams.get('date'), Number(u.searchParams.get('hour'))),
  'GET /api/obs': () => q('SELECT id,station,date,hour,observer,status,flags,synop,received,derived,payload FROM obs ORDER BY received DESC LIMIT 300')
    .map((r) => ({ ...r, flags: JSON.parse(r.flags), derived: JSON.parse(r.derived), payload: JSON.parse(r.payload) })),
  'GET /api/custody': (_, u) => q('SELECT * FROM custody WHERE obs=? ORDER BY at', u.searchParams.get('obs')),
  'GET /api/network': () => {
    const today = new Date().toISOString().slice(0, 10);
    return core.STATIONS.map((s) => {
      const last = q('SELECT date,hour,received,status FROM obs WHERE station=? ORDER BY received DESC LIMIT 1', s.id)[0];
      const n = q('SELECT COUNT(*) c FROM obs WHERE station=? AND date=?', s.id, today)[0].c;
      const expected = s.tier === 'synoptic' ? new Date().getUTCHours() + 1 : core.TIER_HOURS[s.tier].filter((h) => h <= new Date().getUTCHours()).length;
      return { ...s, last, today: n, expected, availability: expected ? Math.min(100, Math.round((100 * n) / expected)) : null };
    });
  },
  'GET /api/kiamo': () => q('SELECT * FROM gts ORDER BY queued DESC LIMIT 200'),
  'POST /api/kiamo/release': (b) => releaseGts(b.ids || [], b.officer || 'KIAMO duty officer') || [400, { error: 'nothing queued' }],
  'GET /api/gts/bulletins': () => readdirSync(join(DATA, 'gts')).sort().reverse().slice(0, 20).map((f) => ({ file: f, text: readFileSync(join(DATA, 'gts', f), 'utf8') })),
  'GET /api/clidata': () => readdirSync(join(DATA, 'clidata')).map((f) => ({ file: f, text: readFileSync(join(DATA, 'clidata', f), 'utf8') })),
  'GET /api/verification': () => verification(),
  'GET /api/attention': () => attention(),
  'GET /api/alerts': () => q("SELECT * FROM alerts WHERE state='open' ORDER BY at DESC"),
  'GET /api/subscribers/summary': () => q('SELECT region, district, sector, channel, language, COUNT(*) n FROM subscribers GROUP BY 1,2,3,4,5'),
  'GET /api/candidates': (_, u) => candidates(u.searchParams.get('station') || '23003TDI'),
  'POST /api/models/refresh': async () => { const m = await modelData(true); return { source: m.source, fetched: m.fetched }; },
  'POST /api/products': (b) => {
    const id = `GMET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(q('SELECT COUNT(*) c FROM products')[0].c + 1).padStart(3, '0')}`;
    const p = { id, kind: 'warning', event: b.event || 'Heavy Rainfall', severity: b.severity || 'Moderate', certainty: b.certainty || 'Likely', headline: b.headline, narrative: b.narrative,
      stations: b.stations || [], onset: b.onset, expires: b.expires, rrExpected: b.rrExpected, evidence: b.evidence, author: b.author, alert: b.alert || null };
    run('INSERT INTO products VALUES(?,?,?,?,?,?,?)', id, 'warning', 'draft', JSON.stringify(p), now(), null, null);
    return { ...p, preview: { ...renderAll({ ...p, issued: now() }), routing: route(p) } };
  },
  'POST /api/products/approve': (b) => issue(b.id, b.officer || 'Duty forecaster') || [400, { error: 'not a draft' }],
  'GET /api/products': () => q('SELECT * FROM products ORDER BY created DESC').map((r) => ({ ...r, body: JSON.parse(r.body), issues: q('SELECT * FROM issues WHERE product=?', r.id) })),
  'GET /api/notifications': () => q('SELECT body FROM notifications ORDER BY at DESC LIMIT 50').map((r) => JSON.parse(r.body)),
  'GET /cap/feed.xml': () => {
    const items = q("SELECT * FROM products WHERE state='issued' ORDER BY issued DESC").map((r) => JSON.parse(r.body));
    return [200, `<?xml version="1.0"?>\n<rss version="2.0"><channel><title>GMet CAP alerts</title>${items.map((p) => `<item><title>${esc(p.headline)}</title><link>/data/products/${p.id}/alert.cap.xml</link><pubDate>${p.issued}</pubDate></item>`).join('')}</channel></rss>`, 'application/rss+xml'];
  },
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(':ok\n\n'); sse.add(res); req.on('close', () => sse.delete(res)); return;
    }
    const h = routes[`${req.method} ${u.pathname}`];
    if (h) {
      const out = await h(req.method === 'POST' ? await body(req) : {}, u);
      if (Array.isArray(out) && typeof out[0] === 'number') return send(res, out[0], out[1], out[2]);
      return send(res, 200, out);
    }
    const m = u.pathname.match(/^\/api\/obs\/(.+)$/);
    if (m) { const r = q('SELECT * FROM obs WHERE id=?', m[1])[0]; return r ? send(res, 200, r) : send(res, 404, { error: 'not found' }); }
    // static: /public/* and /data/products|gts|clidata/*
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    if (p.endsWith('/')) p += 'index.html';
    const isData = p.startsWith('/data/') && !p.includes('..') && !p.endsWith('.db');
    const base = isData ? DATA : join(ROOT, 'public');
    const f = join(base, isData ? p.slice(6) : p);
    if (!f.startsWith(base) || !existsSync(f)) return send(res, 404, 'Not found', 'text/plain');
    // A folder without a trailing slash (e.g. /capture): redirect so relative links resolve.
    if (statSync(f).isDirectory()) { res.writeHead(301, { location: u.pathname + '/' + u.search }); return res.end(); }
    const data = readFileSync(f);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) }); else res.end();
  }
}).listen(PORT, () => {
  console.log(`GMet chain MVP on http://localhost:${PORT}\n  capture  → /capture/\n  console  → /console/\n  climweb  → /climweb/`);
  modelData().then((m) => console.log('model data:', m.source));
});
