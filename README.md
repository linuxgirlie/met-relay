# MetRelay: observation to action, whole-chain MVP for GMet

NGDA 2026 · Challenge 4 · GMet with DMI. A working, end-to-end slice of the architecture in `../SYSTEM_ARCHITECTURE.html`:
**gather → process → disseminate**, in one process with **zero npm dependencies** (Node ≥ 22).

```bash
npm start          # http://localhost:8787   (PORT=… to change)
npm run seed       # simulated observer fleet + 24 end-to-end checks (run while the server is up)
npm test           # golden test of the shared core against the real Takoradi EDR
npm run reset      # wipe data/ (stop the server first)
DATA_DIR=/tmp/x PORT=8788 npm start   # separate data folder, e.g. for tests
```

| URL | What it is |
|---|---|
| `/capture/` | **MetRelay Capture**: offline-first tablet PWA (installable). Enrol, PIN, tier-aware form, live derived values, Smart Validation Prompt, SYNOP preview, signed outbox |
| `/console/` | **MetRelay Desk**: HQ / KIAMO / forecaster console: network & custody, KIAMO → GTS release, CLIDATA file drop, forecaster workbench (verification gate + draft warning), dissemination log, backbone feed |
| `/climweb/` | ClimWeb simulator: where approved warnings are published, plus `/cap/feed.xml` |

## Capture rules
| Rule | How it works |
|---|---|
| Time is automatic | Each slot opens 20 min before its hour and closes 40 min after (`core.WINDOW`). The tablet offers only the open slot; the server flags a capture time outside it. |
| Fields follow the schedule | `core.FIELDS` lists the hours each element is due per tier. Max, min, grass min, 24 h rain and evaporation are read at 09 GMT after the cycle completes; sunshine at 18 GMT; synoptic Tn at 06 and Tx at 18. |
| Stepped form | One section per screen with a progress bar, then a review step with SYNOP preview. Cloud type is skipped when total cloud is 0; wind speed when calm. |
| Nothing incomplete is sent | Every due field needs a value or `/`. A `/` asks for a reason (broken, missing, maintenance, unsafe, absent, other). The server rejects incomplete records; missing values become `////` groups in SYNOP and blanks in CLIDATA. |
| QC by parameter | Temperature: model background and neighbours within 250 km, lapse-rate adjusted. Max and min: against the dry bulbs of the past 24 h. Rainfall: station history for the month (1991–2020), dry-season check, multi-day accumulation, weather-code consistency. No neighbour check for rain. |
| Confirmed extremes alert | A rain extreme the observer confirms at the gauge appears in the workbench as a heavy-rain alert with a pre-filled draft. |
| Demo clock | `/capture/?at=09:05` shifts the tablet clock for rehearsals (09:00 has every daily element). Those records are flagged `demoClock`. |

Rain history comes from `reference/climatology.json`, built by `node scripts/build-climatology.mjs` from the Open-Meteo archive (ERA5). It is a proxy that understates point extremes; production should compute the same table from CLIDATA.

## What is real vs simulated

| Component | Status in MVP |
|---|---|
| Shared derivation core (`public/core.js`): RH, dew point, VP, MSLP reduction, WMO code tables, SYNOP encoder, QC, CLIDATA row | **Real.** Same file runs in the tablet and on the server (AD-03). EDR formulas verbatim |
| Offline capture, IndexedDB outbox, service-worker app shell, idempotent sync, delete-only-on-ack | **Real** |
| Device enrolment + ECDSA P-256 signature per observation, verified at ingest (tampering rejected) | **Real** (AD-05). Active Directory is a mock with 3 demo users, password `1234` |
| Backbone: WIS 2.0-shaped notification messages, subscribers, live SSE to consoles | **Real pattern, in-process.** Production: Mosquitto / Wis2Box MQTT broker |
| CLIDATA adapter: observation rows in the EDR 40-column schema, one CSV per station-month in `data/clidata/` | **Real file drop.** CLIDATA receives observations only, never SYNOP |
| SYNOP → KIAMO release queue → GTS bulletin (`SMGH01 DGAA`) in `data/gts/` | **Real encoding and human release.** The GTS switch is simulated |
| Model candidates: GFS, ECMWF IFS, **ECMWF AIFS (AI)** from Open-Meteo, cached for offline demo | **Real live data** (`data/cache/models.json` is the offline fallback) |
| Verification gate: each source scored (MAE and bias) against MetRelay Capture observations; blend = bias-corrected mean of verified candidates | **Real, simple** |
| Directed attention: per-station model agreement for the next 24 h, disagreements first | **Real** |
| Product service: author once → CAP 1.2, SMS (en/tw/dag), social post, GeoJSON; routed to subscribers in the affected districts only; crop advisory in open planting windows; issue log across 12 channels | **Real renderers.** Channels are simulated. Twi/Dagbani strings are placeholders for native-speaker review |
| Subscribers and crop calendar | **Synthetic.** Registry is generated per district; planting windows are illustrative until the CSIR-SARI / FAO calendars are loaded |
| Station registry | 12 stations. Takoradi, Tuna, Mempeasem IDs from the source documents. Other IDs and coordinates approximate |

## Verified results
- `npm test`: RH, Td and VP reproduce the EDR in **399/399** Takoradi hours. SYNOP sections 0–1 match the EDR exactly in **337/378** hours. The remaining differences: 10 hours where the **real EDR emits malformed groups** (`8592X`, `8703x`), which the core encodes as `/` and `validateSynop()` flags; 06h 24-hour rain; and 18h hours where the EDR's own CLIDATA sheet and its SYNOP disagree on MSLP.
- `npm run seed`: 24/24 end-to-end checks pass, including incomplete-record rejection, missing values with reasons, time-window flags, confirmed extremes becoming alerts, and district routing.
- Earlier checks: These cover idempotent resend, tamper rejection, CLIDATA with no SYNOP, SYNOP held for KIAMO, a valid GTS bulletin, drafts not published before approval, and one issue reaching 12 channels.

## 5-minute demo script
1. `/capture/?at=09:05`: enrol as `kofi.mensah` at TAKORADI, PIN 1234. The home screen shows the **09:00 GMT** slot, taken from the clock. Tap **Start**.
2. Step through: Sky, Wind, Temperature (RH 92 % for 27.1 / 26.0), Max and min (only at 09). Tap **/** on grass minimum and pick *Instrument broken*. Enter dry bulb 40 to see the check against neighbours and the model.
3. Review shows every value, the missing reason and the SYNOP. Submit. **Go offline** and back to show the outbox.
4. `/console/`, **Network**: the observation with its flags and chain of custody. **KIAMO**: release to GTS. **CLIDATA**: the row.
5. **Workbench**: *Where your judgment is needed* lists stations where models disagree. A confirmed heavy-rain report appears on top with **Draft warning**.
6. **Approve**: **Products** shows who it reached (sector, channel, language) and the crop advisory. `/climweb/` shows the public banner.
