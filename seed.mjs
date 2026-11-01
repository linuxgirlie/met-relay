// Simulated observer fleet + end-to-end check. Each station enrols a device, signs observations, syncs.
// Usage: node seed.mjs [baseUrl]
import { webcrypto as C } from 'node:crypto';
import * as core from './public/core.js';
const BASE = process.argv[2] || 'http://localhost:8787';
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(BASE + p).then((r) => r.json());
const sign = async (key, obs) => Buffer.from(await C.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(core.canonical(obs)))).toString('base64');
const observers = ['kofi.mensah', 'ama.owusu', 'yaw.boateng'];
const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; };
const r1 = (x) => Math.round(x * 10) / 10;
// The last few scheduled slots before now, each captured a few minutes after its hour (inside the window)
const lastSlots = (tier, n) => { const out = []; let t = Date.now(); while (out.length < n) { const { open, next } = core.slotAt(tier, t); const sl = open && Date.parse(open.at) <= Date.now() ? open : null; if (sl && !out.some((x) => x.at === sl.at)) out.push(sl); t -= 3600e3; } return out.reverse(); };
function values(st, slot, ctx) {
  const T = r1((ctx.refT ?? 28) + (Math.random() - 0.5) * 1.6), day = [...(ctx.dayT || []).map((x) => x.T), T];
  const V = { T, Tw: r1(T - 1 - Math.random() * 3), Tx: r1(Math.max(...day) + 0.4), Tn: r1(Math.min(...day) - 1.2), Tg: r1(Math.min(...day) - 2.5),
    windDir: ['SW', 'S', 'W', 'CALM'][slot.hour % 4], windKt: 4 + (slot.hour % 5), vis_km: 10, N: 5, cloudBase_m: 450, Nh: 3, CL: 8, CM: 0, CH: 2,
    layers: [{ Ns: 3, C: 6, h_m: 450 }], pStation: r1(1008.2 - st.elev / 8.3), ww: 2, W1W2: 11, rr: 0, soil5: r1(T + 2), soil10: r1(T + 1), soil20: r1(T), soil30: r1(T - 0.5), soil120: r1(T - 2),
    evapPiche: r1(3 + Math.random() * 2), sunHrs: r1(5 + Math.random() * 3) };
  const o = { station: st.id, date: slot.date, hour: slot.hour };
  for (const k of core.fieldsDue(st.tier, slot.hour)) if (core.applies(k, { ...o, ...V })) if (k !== 'mslp') o[k] = V[k];
  if (o.windDir === 'CALM') delete o.windKt;
  return o;
}
const signed = async (kp, deviceId, o, extra = {}) => { const obs = { ...o, id: C.randomUUID(), derived: core.derive(o, core.stationById(o.station)), qcDecisions: [], capturedAt: extra.capturedAt, coreVersion: core.CORE_VERSION, ...extra }; return { obs, deviceId, sig: await sign(kp.privateKey, obs) }; };
let first;
const keys = {};
for (const [i, st] of core.STATIONS.entries()) {
  const kp = await C.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const dev = await post('/api/enrol', { observer: observers[i % 3], password: '1234', station: st.id, jwk: await C.subtle.exportKey('jwk', kp.publicKey) });
  keys[st.id] = { kp, dev };
  const items = [];
  for (const slot of lastSlots(st.tier, 3)) {
    const ctx = await get(`/api/qc-context?station=${st.id}&date=${slot.date}&hour=${slot.hour}`);
    items.push(await signed(kp, dev.deviceId, values(st, slot, ctx), { capturedAt: new Date(Date.parse(slot.at) + 3 * 60e3).toISOString() }));
  }
  const r = await post('/api/sync', { items });
  if (i === 0) first = { items, kp, dev, r };
  console.log(`${st.name.padEnd(12)} ${st.tier.padEnd(9)} ${r.acks.map((a) => a.status).join(',')}`);
}
// --- end-to-end properties ---
check('all first-station observations acknowledged', first.r.acks.every((a) => a.ack));
const dup = await post('/api/sync', { items: first.items });
check('re-sending the same outbox is idempotent (duplicate-ack, no double rows)', dup.acks.every((a) => a.status === 'duplicate-ack'));
const t = structuredClone(first.items[0]); t.obs.id = C.randomUUID(); t.obs.T = t.obs.T + 5; // altered after signing
const tam = await post('/api/sync', { items: [t] });
check('tampered observation rejected at ingest', tam.acks[0].status === 'rejected');
const obs = await get('/api/obs');
check('observations flowed into CLIDATA adapter', obs.some((o) => o.status === 'in-clidata'));
const cl = await get('/api/clidata');
check('CLIDATA rows contain no SYNOP strings', cl.every((f) => !/65467|333/.test(f.text.split('\n').slice(1).join('\n').replace(/23003TDI/g, ''))));
const k = await get('/api/kiamo');
check('synoptic SYNOP queued for KIAMO; nothing released without a named officer', k.some((x) => x.state === 'queued') && k.every((x) => x.state === 'queued' || x.releasedBy));
check('every queued SYNOP is structurally valid', k.every((x) => core.validateSynop(x.synop).ok));
const rel = await post('/api/kiamo/release', { ids: k.filter((x) => x.state === 'queued').map((x) => x.id), officer: 'KIAMO duty officer (seed)' });
check('KIAMO release writes a GTS bulletin', !!rel.file);
const cand = await get('/api/candidates?station=23003TDI');
check('model candidates available (' + cand.source + ')', cand.series.length === 3);
const d = await post('/api/products', { headline: 'Test heavy rain', narrative: 'Seed test', stations: ['23003TDI', 'SYN-ACCRA'], onset: new Date().toISOString(), expires: new Date(Date.now() + 864e5).toISOString(), rrExpected: 40 });
const ps1 = await get('/api/products');
check('draft product is NOT published before approval', ps1.find((p) => p.id === d.id).state === 'draft' && ps1.find((p) => p.id === d.id).issues.length === 0);
const iss = await post('/api/products/approve', { id: d.id, officer: 'Duty forecaster (seed)' });
check('approved product rendered to CAP + SMS + GeoJSON', iss.rendered.cap.includes('<alert') && iss.rendered.sms.tw.length === 2 && iss.rendered.geojson.features.length === 2);
const ps2 = await get('/api/products');
check('issued once → recorded on 12 channels', ps2.find((p) => p.id === d.id).issues.length === 12);

// --- capture rules enforced by the server ---
const tak = core.stationById('23003TDI'), { kp, dev } = keys[tak.id];
const sl = core.slotAt('synoptic', Date.now()).open || lastSlots('synoptic', 1)[0];
const ctxT = await get(`/api/qc-context?station=${tak.id}&date=${sl.date}&hour=${sl.hour}`);
check('QC context carries station climatology and neighbour list', !!ctxT.clim && Array.isArray(ctxT.neighbours));
const inc = values(tak, sl, ctxT); delete inc.T;
const rInc = await post('/api/sync', { items: [await signed(kp, dev.deviceId, inc, { capturedAt: sl.at })] });
check('incomplete observation rejected (dry bulb neither read nor reported missing)', rInc.acks[0].status === 'rejected' && /incomplete/.test(rInc.acks[0].why));
const withMiss = values(tak, sl, ctxT); delete withMiss.Tw; withMiss.missing = { Tw: { reason: 'Instrument broken' } };
const rMiss = await post('/api/sync', { items: [await signed(kp, dev.deviceId, withMiss, { capturedAt: sl.at })] });
const allObs = await get('/api/obs');
check('value reported missing with a reason is accepted and flagged', rMiss.acks[0].ack && allObs.find((o) => o.id === rMiss.acks[0].id).flags.some((f) => f.kind === 'missing' && /Instrument broken/.test(f.msg)));
check('missing wet bulb encoded as 2//// in SYNOP', /\s2\/\/\/\/\s/.test(allObs.find((o) => o.id === rMiss.acks[0].id).synop));
const late = values(tak, sl, ctxT);
const rLate = await post('/api/sync', { items: [await signed(kp, dev.deviceId, late, { capturedAt: new Date(Date.parse(sl.at) + 3 * 3600e3).toISOString() })] });
check('capture time outside the slot window is flagged', (await get('/api/obs')).find((o) => o.id === rLate.acks[0].id).flags.some((f) => f.kind === 'time'));
// confirmed rain extreme at a daily station becomes an alert for forecasters
const nav = core.stationById('SYN-NAVRONGO'), nk = keys[nav.id];
const s9 = lastSlots('synoptic', 30).find((x) => x.hour === 9) || lastSlots('synoptic', 1)[0];
const ctxN = await get(`/api/qc-context?station=${nav.id}&date=${s9.date}&hour=${s9.hour}`);
const wet = { ...values(nav, s9, ctxN), rr: 180, ww: 63, W1W2: 66 };
const soft = core.qc(wet, ctxN).soft.filter((x) => x.field === 'rr');
check('180 mm raises the rain history check (' + (soft[0]?.kind || 'none') + ')', soft.some((x) => x.kind === 'rain-extreme'));
const rWet = await post('/api/sync', { items: [await signed(nk.kp, nk.dev.deviceId, wet, { capturedAt: s9.at, qcDecisions: soft.map((x) => ({ ...x, decision: 'confirmed', value: 180 })) })] });
const al = await get('/api/alerts');
check('observer-confirmed extreme creates a forecaster alert', rWet.acks[0].ack && al.some((a) => a.station === nav.id && a.value === 180));
const att = await get('/api/attention');
check('directed attention covers every station', att.length === core.STATIONS.length && att.every((a) => ['agree', 'judgment'].includes(a.verdict)));
const dN = await post('/api/products', { headline: 'Heavy rain Navrongo', narrative: 'Seed', stations: [nav.id], onset: new Date().toISOString(), expires: new Date(Date.now() + 864e5).toISOString(), rrExpected: 60, alert: al.find((a) => a.station === nav.id)?.id });
check('draft preview routes only to subscribers in the affected district', dN.preview.routing.total > 0 && dN.preview.routing.districts.join() === nav.district);
const iN = await post('/api/products/approve', { id: dN.id, officer: 'Duty forecaster (seed)' });
check('issued product carries routing counts per sector and language', iN.rendered.routing.groups.some((g) => g.sector === 'farmer'));
check('alert marked handled once a product is issued', !(await get('/api/alerts')).some((a) => a.id === dN.alert));
check('Navrongo SMS in Upper East languages (Gurune/Kasem), not Twi or Dagbani', !('tw' in iN.rendered.sms) && !('dag' in iN.rendered.sms) && 'gur' in iN.rendered.sms);
