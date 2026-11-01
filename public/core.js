// MetRelay core, ONE derivation/encoding library, loaded by the tablet (browser) AND the server (AD-03).
// Formulas are lifted verbatim from the GMet Electronic Daily Register (EDR_2026-01-TAKORADI.xlsx).
// Pure functions only: no I/O, no clock, no randomness.

export const CORE_VERSION = '0.2.0';

// ---------- Station registry (WMO ids from the EDR station table; coordinates/elevations approximate) ----------
export const STATIONS = [
  { id: '23003TDI', wmo: '65467', name: 'TAKORADI', tier: 'synoptic', region: 'Western', district: 'Sekondi-Takoradi', lat: 4.896, lon: -1.775, elev: 5 },
  { id: 'SYN-ACCRA', wmo: '65472', name: 'ACCRA', tier: 'synoptic', region: 'Greater Accra', district: 'Accra Metro', lat: 5.605, lon: -0.167, elev: 68 },
  { id: 'SYN-KUMASI', wmo: '65442', name: 'KUMASI', tier: 'synoptic', region: 'Ashanti', district: 'Kumasi Metro', lat: 6.715, lon: -1.591, elev: 286 },
  { id: 'SYN-TAMALE', wmo: '65418', name: 'TAMALE', tier: 'synoptic', region: 'Northern', district: 'Tamale Metro', lat: 9.557, lon: -0.863, elev: 168 },
  { id: 'SYN-NAVRONGO', wmo: '65401', name: 'NAVRONGO', tier: 'synoptic', region: 'Upper East', district: 'Kassena-Nankana', lat: 10.895, lon: -1.093, elev: 201 },
  { id: 'SYN-WA', wmo: '65404', name: 'WA', tier: 'synoptic', region: 'Upper West', district: 'Wa Municipal', lat: 10.050, lon: -2.500, elev: 323 },
  { id: 'SYN-HO', wmo: '65453', name: 'HO', tier: 'synoptic', region: 'Volta', district: 'Ho Municipal', lat: 6.600, lon: 0.467, elev: 158 },
  { id: '0902/003/002', wmo: null, name: 'TUNA', tier: 'agromet', region: 'Savannah', district: 'Sawla-Tuna-Kalba', lat: 9.500, lon: -2.417, elev: 250 },
  { id: 'AGR-VEA', wmo: null, name: 'VEA', tier: 'agromet', region: 'Upper East', district: 'Bongo', lat: 10.860, lon: -0.850, elev: 190 },
  { id: 'CLM-KINTAMPO', wmo: null, name: 'KINTAMPO', tier: 'climo', region: 'Bono East', district: 'Kintampo North', lat: 8.056, lon: -1.731, elev: 360 },
  { id: '23084MPE', wmo: null, name: 'MEMPEASEM', tier: 'rainfall', region: 'Greater Accra', district: 'Ga South', lat: 5.650, lon: -0.450, elev: 60 },
  { id: 'RF-BOLGA', wmo: null, name: 'BOLGATANGA', tier: 'rainfall', region: 'Upper East', district: 'Bolgatanga Municipal', lat: 10.786, lon: -0.851, elev: 180 },
];
export const stationById = (id) => STATIONS.find((s) => s.id === id);

// ---------- Observation schedule: one form engine, four tiers ----------
export const TIER_HOURS = {
  rainfall: [9],
  climo: [6, 9, 12, 15, 18],
  agromet: [6, 9, 12, 15, 18],
  synoptic: Array.from({ length: 24 }, (_, h) => h),
};
/** An observation slot opens 20 min before its scheduled hour and closes 40 min after. */
export const WINDOW = { before: 20, after: 40 };

// Every field: label, unit, form section, and the hours it is due per tier ('all' = every scheduled hour).
// Daily elements (max, min, grass min, 24 h rain, evaporation) are read once, at 09 GMT, after the
// 24 h cycle completes; sunshine is totalled at 18 GMT. Synoptic also reports Tn at 06 and Tx at 18 (SYNOP 333).
const A = 'all';
export const FIELDS = {
  vis_km: { l: 'Visibility', u: 'km', step: 0.1, sec: 'sky', due: { synoptic: A } },
  N: { l: 'Total cloud', u: 'okta', step: 1, sec: 'sky', due: { synoptic: A }, min: 0, max: 9 },
  cloudBase_m: { l: 'Lowest cloud base', u: 'm', step: 30, sec: 'sky', due: { synoptic: A }, ifCloud: true },
  Nh: { l: 'Low cloud amount', u: 'okta', step: 1, sec: 'sky', due: { synoptic: A }, ifCloud: true, min: 0, max: 9 },
  CL: { l: 'Low cloud type', step: 1, sec: 'sky', due: { synoptic: A }, ifCloud: true, min: 0, max: 9 },
  CM: { l: 'Medium cloud type', step: 1, sec: 'sky', due: { synoptic: A }, ifCloud: true, min: 0, max: 9 },
  CH: { l: 'High cloud type', step: 1, sec: 'sky', due: { synoptic: A }, ifCloud: true, min: 0, max: 9 },
  layers: { l: 'Cloud layer', sec: 'sky', due: { synoptic: A }, ifCloud: true, optional: true, layer: true },
  windDir: { l: 'Wind direction', sec: 'wind', due: { agromet: A, synoptic: A }, sel: ['CALM', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] },
  windKt: { l: 'Wind speed', u: 'kt', step: 1, sec: 'wind', due: { agromet: A, synoptic: A }, ifWind: true, min: 0 },
  T: { l: 'Dry bulb', u: '°C', step: 0.1, sec: 'temp', due: { climo: A, agromet: A, synoptic: A } },
  Tw: { l: 'Wet bulb', u: '°C', step: 0.1, sec: 'temp', due: { climo: A, agromet: A, synoptic: A } },
  Tx: { l: 'Maximum', u: '°C', step: 0.1, sec: 'extremes', due: { climo: [9], agromet: [9], synoptic: [9, 18] } },
  Tn: { l: 'Minimum', u: '°C', step: 0.1, sec: 'extremes', due: { climo: [9], agromet: [9], synoptic: [6, 9] } },
  Tg: { l: 'Grass minimum', u: '°C', step: 0.1, sec: 'extremes', due: { climo: [9], agromet: [9], synoptic: [9] } },
  pStation: { l: 'Pressure as read', u: 'hPa', step: 0.1, sec: 'pressure', due: { synoptic: A } },
  mslp: { l: 'MSL pressure', u: 'hPa', step: 0.1, sec: 'pressure', due: { synoptic: A }, optional: true, ph: 'Auto' },
  ww: { l: 'Present weather', step: 1, sec: 'weather', due: { synoptic: A }, min: 0, max: 99, ph: 'ww' },
  W1W2: { l: 'Past weather', step: 1, sec: 'weather', due: { synoptic: A }, min: 0, max: 99, ph: 'W1W2' },
  rr: { l: 'Rainfall', u: 'mm', step: 0.1, sec: 'rain', due: { rainfall: [9], climo: [9], agromet: [9], synoptic: [0, 6, 9, 12, 18] }, min: 0 },
  soil5: { l: 'Soil 5 cm', u: '°C', step: 0.1, sec: 'soil', due: { agromet: [9, 15], synoptic: [9, 15] } },
  soil10: { l: 'Soil 10 cm', u: '°C', step: 0.1, sec: 'soil', due: { agromet: [9, 15], synoptic: [9, 15] } },
  soil20: { l: 'Soil 20 cm', u: '°C', step: 0.1, sec: 'soil', due: { agromet: [9, 15], synoptic: [9, 15] } },
  soil30: { l: 'Soil 30 cm', u: '°C', step: 0.1, sec: 'soil', due: { agromet: [9, 15], synoptic: [9, 15] } },
  soil120: { l: 'Soil 120 cm', u: '°C', step: 0.1, sec: 'soil', due: { agromet: [9], synoptic: [9] } },
  evapPiche: { l: 'Evaporation, Piche', u: 'mm', step: 0.1, sec: 'sun', due: { agromet: [9], synoptic: [9] }, min: 0 },
  sunHrs: { l: 'Sunshine, today', u: 'h', step: 0.1, sec: 'sun', due: { agromet: [18], synoptic: [18] }, min: 0, max: 13 },
};
export const SECTIONS = [
  { id: 'sky', l: 'Sky' }, { id: 'wind', l: 'Wind' }, { id: 'temp', l: 'Temperature' }, { id: 'extremes', l: 'Max and min' },
  { id: 'pressure', l: 'Pressure' }, { id: 'weather', l: 'Weather' }, { id: 'rain', l: 'Rainfall' }, { id: 'soil', l: 'Soil' }, { id: 'sun', l: 'Sun and evaporation' },
];
/** Reasons offered when an observer reports a value as missing ("/"). */
export const MISSING_REASONS = ['Instrument broken', 'Instrument missing', 'Under maintenance', 'Unsafe to read', 'Observer absent', 'Other'];
export const isMissing = (obs, k) => !!obs.missing?.[k];

/** Fields due for a tier at a given hour, in form order. */
export function fieldsDue(tier, hour) {
  return Object.keys(FIELDS).filter((k) => { const d = FIELDS[k].due[tier]; return d === A ? TIER_HOURS[tier].includes(hour) : Array.isArray(d) && d.includes(hour); });
}
/** Whether a due field applies given what has been entered (no cloud type without cloud, no speed when calm). */
export function applies(k, obs) {
  const f = FIELDS[k];
  if (f.ifCloud && obs.N === 0) return false;
  if (f.ifWind && obs.windDir === 'CALM') return false;
  return true;
}
/** Mandatory fields still empty: each must hold a value or be marked missing with a reason. */
export function incomplete(obs, station) {
  return fieldsDue(station.tier, obs.hour).filter((k) => applies(k, obs) && !FIELDS[k].optional && !isMissing(obs, k) && (obs[k] === undefined || obs[k] === null || obs[k] === ''));
}
/** The slot open at a given instant, and the next one. Pure: the caller supplies the clock. */
export function slotAt(tier, when) {
  const t = new Date(when).getTime();
  const days = [-1, 0, 1].map((o) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + o); return d.getTime(); });
  const slots = days.flatMap((d0) => TIER_HOURS[tier].map((h) => d0 + h * 3600e3)).sort((a, b) => a - b);
  const mk = (s) => ({ date: new Date(s).toISOString().slice(0, 10), hour: new Date(s).getUTCHours(), at: new Date(s).toISOString(), opens: new Date(s - WINDOW.before * 60e3).toISOString(), closes: new Date(s + WINDOW.after * 60e3).toISOString() });
  const open = slots.find((s) => t >= s - WINDOW.before * 60e3 && t < s + WINDOW.after * 60e3);
  const next = slots.find((s) => s - WINDOW.before * 60e3 > t);
  return { open: open ? mk(open) : null, next: next ? mk(next) : null };
}
/** Whether a capture time falls inside the window of its slot (server check, with clock tolerance in minutes). */
export function inWindow(date, hour, capturedAt, toleranceMin = 5) {
  const s = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`), c = Date.parse(capturedAt);
  return c >= s - (WINDOW.before + toleranceMin) * 60e3 && c < s + (WINDOW.after + toleranceMin) * 60e3;
}

// ---------- Derivation (EDR formulas, verbatim) ----------
const round = (x, d = 0) => { const f = 10 ** d; return Math.round(x * f + (x >= 0 ? 1e-9 : -1e-9)) / f; };
const esat = (t) => 6.112 * Math.exp((17.502 * t) / (240.97 + t));

/** Relative humidity from dry & wet bulb, EDR day-sheet cell N8. */
export function relHumidity(T, Tw) {
  const e = esat(Tw) - 0.6687451584 * (1 + 0.00115 * Tw) * (T - Tw);
  return round((e / esat(T)) * 100, 0);
}
/** Dew point from dry bulb and (rounded) RH, EDR cell Q7. */
export function dewPoint(T, RH) {
  const a = Math.log(RH / 100) + (17.27 * T) / (237.3 + T);
  return round((237.3 * (a / 17.27)) / (1 - a / 17.27), 1);
}
/** Vapour pressure from dew point, EDR cell N9. */
export function vapourPressure(Td) {
  return round(6.11 * 10 ** ((7.5 * Td) / (237.3 + Td)), 1);
}
/** Mean-sea-level pressure by hypsometric reduction (the EDR keys MSLP from tables; we compute it). */
export function reduceToMSL(pStation, elev_m, T) {
  const Tv = T + 273.15 + 0.0065 * elev_m / 2;
  return round(pStation * Math.exp((9.80665 * elev_m) / (287.05 * Tv)), 1);
}
export function derive(obs, station) {
  const d = {};
  if (num(obs.T) && num(obs.Tw)) {
    d.RH = relHumidity(obs.T, obs.Tw);
    d.Td = dewPoint(obs.T, d.RH);
    d.VP = vapourPressure(d.Td);
  }
  if (num(obs.pStation) && station && num(obs.T) && !num(obs.mslp)) d.mslp = reduceToMSL(obs.pStation, station.elev, obs.T);
  if (num(obs.windKt)) d.beaufort = beaufort(obs.windKt);
  return d;
}

// ---------- WMO code conversions (as implemented in the EDR) ----------
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const pad = (n, w) => String(Math.abs(Math.trunc(n))).padStart(w, '0');
const COMPASS = { CALM: 0, N: 36, NE: 5, E: 9, SE: 14, S: 18, SW: 23, W: 27, NW: 32 };
export const COMPASS_POINTS = Object.keys(COMPASS);
export function ddCode(dir) {
  if (typeof dir === 'string') return COMPASS[dir.toUpperCase()] ?? 99;
  if (num(dir)) return dir === 0 ? 0 : Math.round(dir / 10) || 36;
  return 99;
}
export function beaufort(kt) {
  const lim = [0, 3, 6, 10, 16, 21, 27, 33, 40, 47, 55, 63];
  for (let b = 0; b < lim.length; b++) if (kt <= lim[b]) return b;
  return 12;
}
/** VV, EDR cell G8 (input km). */
export function vvCode(km) {
  if (!num(km)) return '//';
  if (km < 0.05) return '90';
  if (km < 1 || km <= 5) return pad(round(km * 10), 2);
  if (km < 6) return '//';
  return pad(Math.min(km + 50, 89), 2);
}
/** h, height of lowest cloud base, EDR cell E8 (input metres). */
export function hCode(base_m, N) {
  if (N === 0) return '9';
  if (!num(base_m)) return '/';
  const lim = [50, 100, 200, 300, 600, 1000, 1500, 2000, 2500];
  for (let i = 0; i < lim.length; i++) if (base_m < lim[i]) return String(i);
  return '9';
}
/** hshs, layer height code, EDR cell AW7. */
export function hshsCode(m) {
  if (m < 30) return '00';
  if (m <= 1500) return pad(Math.floor(m / 30), 2);
  if (m >= 1800 && m <= 10500) return pad(Math.floor(m / 300 + 50), 2);
  return pad(Math.min(Math.floor(m / 1500 + 74), 89), 2);
}
/** RRR, precipitation amount, EDR cell Y8. */
export function rrrCode(rr) {
  if (rr === 'TR') return '990';
  if (rr > 0 && rr < 1) return '99' + Math.round(rr * 10);
  return pad(round(rr), 3);
}
const temp = (ind, t) => `${ind}${t < 0 ? 1 : 0}${pad(round(Math.abs(t) * 10), 3)}`;

// ---------- SYNOP (FM-12 TAC, GMet EDR convention) ----------
export const MAIN_HOURS = [0, 6, 12, 18];
export function encodeSynop(obs, station) {
  const d = { ...derive(obs, station), ...(obs.derived || {}) };
  const h = obs.hour, miss = (k) => isMissing(obs, k);
  const hasRain = MAIN_HOURS.includes(h) && (num(obs.rr) || obs.rr === 'TR');
  const iR = miss('rr') && MAIN_HOURS.includes(h) ? 4 : hasRain ? (obs.rr === 0 ? 3 : 1) : MAIN_HOURS.includes(h) ? 3 : 4;
  const ww = num(obs.ww) ? obs.ww : 0, w12 = num(obs.W1W2) ? obs.W1W2 : 0;
  const iX = ww <= 3 && w12 <= 22 ? 2 : 1;
  const N = num(obs.N) ? obs.N : '/';
  const calm = obs.windDir === 'CALM';
  const g = [station.wmo];
  g.push(`${iR}${iX}${hCode(obs.cloudBase_m, obs.N)}${vvCode(obs.vis_km)}`);
  g.push(`${N}${miss('windDir') ? '//' : pad(ddCode(obs.windDir), 2)}${calm ? '00' : miss('windKt') || !num(obs.windKt) ? '//' : pad(obs.windKt, 2)}`);
  if (num(obs.T)) g.push(temp(1, obs.T)); else if (miss('T')) g.push('1////');
  if (num(d.Td)) g.push(temp(2, d.Td)); else if (miss('T') || miss('Tw')) g.push('2////');
  const mslp = num(obs.mslp) ? obs.mslp : d.mslp;
  if (num(mslp)) g.push(`4${pad(round(mslp * 10) % 10000, 4)}`); else if (miss('pStation')) g.push('4////');
  if (iR === 1) g.push(`6${rrrCode(obs.rr)}${h === 6 ? 4 : 1}`);
  if (iX === 1) g.push(`7${pad(ww, 2)}${pad(w12, 2)}`);
  const c0 = obs.N === 0 ? 0 : '/';
  if (num(obs.Nh) || obs.N === 0) g.push(`8${obs.Nh ?? c0}${obs.CL ?? c0}${obs.CM ?? c0}${obs.CH ?? c0}`);
  const s3 = [];
  if (h === 18 && num(obs.Tx)) s3.push(temp(1, obs.Tx));
  if (h === 6 && num(obs.Tn)) s3.push(temp(2, obs.Tn));
  if (num(obs.mslp24) && num(mslp)) {
    const dp = round((mslp - obs.mslp24) * 10);
    s3.push(`5${dp >= 0 ? 8 : 9}${pad(Math.abs(dp), 3)}`);
  }
  for (const L of obs.layers || []) if (num(L.Ns) && num(L.C) && num(L.h_m)) s3.push(`8${L.Ns}${L.C}${hshsCode(L.h_m)}`);
  if (s3.length) g.push('333', ...s3);
  let msg = g.join('  ');
  if (num(d.RH)) msg += `  RH ${d.RH}%`;
  if (h === 9 && num(obs.Tx) && num(obs.Tn)) msg += `  MAX ${obs.Tx.toFixed(1)}  MIN ${obs.Tn.toFixed(1)}`;
  if (h === 9 && num(obs.rr)) msg += `  RR ${obs.rr.toFixed(1)} mm`;
  return msg + ' =';
}
/** Structural check of a SYNOP string, catches malformed groups such as '8592X' found in the real EDR. */
export function validateSynop(msg) {
  const body = msg.replace(/\s+RH .*$/, '').replace(/\s*=$/, '');
  const bad = body.split(/\s+/).filter((x) => x !== '333' && !/^[0-9/]{5}$/.test(x));
  return { ok: bad.length === 0, bad };
}

// ---------- Point-of-capture QC ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
/**
 * Hard constraints block the step; soft ones raise the check prompt, and the observer decides.
 * ctx (all optional): refT model background; neighbours [{name, T, dist}] already lapse-adjusted;
 * clim {wetFreq, p99, max} for this station and month; dayT [{hour, T}] dry bulbs from the past 24 h.
 * Temperature is spatially smooth, so it is checked against neighbours and the model.
 * Rainfall is not (convective rain is patchy), so it is checked against the station's own seasonal history.
 */
export function qc(obs, ctx = {}) {
  const hard = [], soft = [];
  for (const [k, f] of Object.entries(FIELDS)) if (num(obs[k]) && ((num(f.min) && obs[k] < f.min) || (num(f.max) && obs[k] > f.max)))
    hard.push({ field: k, msg: `${f.l} must be between ${f.min ?? 0} and ${f.max ?? '∞'}.` });
  if (num(obs.T) && num(obs.Tw) && obs.Tw > obs.T) hard.push({ field: 'Tw', msg: 'Wet bulb cannot exceed dry bulb.' });
  if (num(obs.Tx) && num(obs.Tn) && obs.Tn > obs.Tx) hard.push({ field: 'Tn', msg: 'Minimum cannot exceed maximum.' });
  if (num(obs.Nh) && num(obs.N) && obs.N < 9 && obs.Nh > obs.N) hard.push({ field: 'Nh', msg: 'Low cloud cannot exceed total cloud.' });

  const range = { T: [5, 45], Tw: [0, 40], Tx: [15, 46], Tn: [5, 35], Tg: [0, 35], pStation: [900, 1030], windKt: [0, 80] };
  for (const [k, [lo, hi]] of Object.entries(range)) if (num(obs[k]) && (obs[k] < lo || obs[k] > hi))
    soft.push({ field: k, kind: 'range', msg: `${FIELDS[k].l} ${obs[k]} is outside the usual range for Ghana (${lo} to ${hi}).` });

  // Temperature: neighbours and model background
  if (num(obs.T)) {
    const nb = (ctx.neighbours || []).filter((n) => num(n.T));
    const nbMean = nb.length >= 2 ? nb.reduce((a, n) => a + n.T, 0) / nb.length : null;
    const offModel = num(ctx.refT) && Math.abs(obs.T - ctx.refT) > 5;
    const offNb = nbMean != null && Math.abs(obs.T - nbMean) > 4;
    if (offModel || offNb) {
      const parts = [];
      if (nbMean != null) parts.push(`nearby stations (${nb.slice(0, 3).map((n) => `${n.name} ${f1(n.T)}`).join(', ')})`);
      if (num(ctx.refT)) parts.push(`the model (${f1(ctx.refT)})`);
      soft.push({ field: 'T', kind: 'temp-context', msg: `Dry bulb ${obs.T} °C is far from ${parts.join(' and ')}. Please re-read the thermometer.` });
    }
  }
  // Max and min against the dry bulbs this tablet recorded over the cycle
  const dayT = (ctx.dayT || []).filter((x) => num(x.T));
  if (dayT.length) {
    const hi = dayT.reduce((a, b) => (b.T > a.T ? b : a)), lo = dayT.reduce((a, b) => (b.T < a.T ? b : a));
    if (num(obs.Tx) && obs.Tx < hi.T - 0.5) soft.push({ field: 'Tx', kind: 'extremes', msg: `Maximum ${obs.Tx} °C is lower than the ${hi.T} °C dry bulb recorded at ${String(hi.hour).padStart(2, '0')}:00. Please re-read the maximum thermometer.` });
    if (num(obs.Tn) && obs.Tn > lo.T + 0.5) soft.push({ field: 'Tn', kind: 'extremes', msg: `Minimum ${obs.Tn} °C is higher than the ${lo.T} °C dry bulb recorded at ${String(lo.hour).padStart(2, '0')}:00. Please re-read the minimum thermometer.` });
  }
  // Rainfall: seasonal history, dry season, and consistency with the weather codes
  if (num(obs.rr) && obs.rr > 0) {
    const n = Math.max(1, obs.rrDays || 1), month = MONTHS[Number(String(obs.date).slice(5, 7)) - 1], c = ctx.clim;
    if (c && c.p99 > 0) {
      const limit = Math.max(c.p99 * 1.5, c.max) * n;
      if (obs.rr > limit) soft.push({ field: 'rr', kind: 'rain-extreme', msg: `${obs.rr} mm${n > 1 ? ` over ${n} days` : ''} is unusually high for this station in ${month} (a heavy day is about ${f1(c.p99)} mm). If the gauge reading is right, confirm it and forecasters will be alerted.` });
    }
    if (c && c.wetFreq < 0.05 && obs.rr >= 5) soft.push({ field: 'rr', kind: 'rain-dry-season', msg: `Rain is rare at this station in ${month} (${c.wetFreq < 0.01 ? 'under 1%' : 'about ' + Math.round(c.wetFreq * 100) + '%'} of days). Please confirm the gauge reading.` });
    if (MAIN_HOURS.includes(obs.hour) && num(obs.ww) && num(obs.W1W2)) {
      const w1 = Math.floor(obs.W1W2 / 10), w2 = obs.W1W2 % 10;
      if (!(obs.ww >= 50 || w1 >= 5 || w2 >= 5)) soft.push({ field: 'rr', kind: 'rain-weather', msg: `${obs.rr} mm recorded, but present and past weather show no precipitation. Please check both.` });
    }
  }
  return { hard, soft, ok: hard.length === 0 };
}

// ---------- CLIDATA ingest contract (EDR 'CLIDATA' sheet column order), observations only, never SYNOP ----------
export const CLIDATA_COLUMNS = ['STN ID', 'STATION NAME', 'YEAR', 'MONTH', 'DAY', 'HR', 'H', 'VV', 'N', 'DD', 'FF', 'TT', 'TW', 'RH', 'VP', 'TD', 'SLP', 'MSLP', 'WW', 'W1W2', 'Nh', 'CL', 'CM', 'CH',
  'NS1', 'C1', 'HS1', 'NS2', 'C2', 'HS2', 'NS3', 'C3', 'HS3', 'NS4', 'C4', 'HS4', '9SP1', '9SP2', 'RR', 'TSRA'];
export function clidataRow(obs, station) {
  const d = { ...derive(obs, station), ...(obs.derived || {}) };
  const [Y, M, D] = obs.date.split('-').map(Number);
  const mslp = num(obs.mslp) ? obs.mslp : d.mslp;
  const L = obs.layers || [];
  const layer = (i, k) => (L[i] ? (k === 'h' ? Number(hshsCode(L[i].h_m)) : L[i][k]) : '');
  const v = (x) => (x === undefined || x === null ? '' : x);
  return [station.id, station.name, Y, M, D, obs.hour,
    num(obs.cloudBase_m) || obs.N === 0 ? hCode(obs.cloudBase_m, obs.N) : '', num(obs.vis_km) ? Number(vvCode(obs.vis_km)) : '', v(obs.N),
    obs.windDir !== undefined ? ddCode(obs.windDir) : '', v(obs.windKt), v(obs.T), v(obs.Tw), v(d.RH), v(d.VP), v(d.Td),
    v(obs.pStation), num(mslp) ? round(mslp - 1000, 1) : '', v(obs.ww), v(obs.W1W2), v(obs.Nh), v(obs.CL), v(obs.CM), v(obs.CH),
    layer(0, 'Ns'), layer(0, 'C'), layer(0, 'h'), layer(1, 'Ns'), layer(1, 'C'), layer(1, 'h'), layer(2, 'Ns'), layer(2, 'C'), layer(2, 'h'), layer(3, 'Ns'), layer(3, 'C'), layer(3, 'h'),
    '', '', v(obs.rr), ''];
}

// ---------- Canonical form for signing (device signs, server verifies) ----------
export function canonical(o) {
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
