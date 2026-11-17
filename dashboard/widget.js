// Hybrid Training widget for the iOS app Scriptable (https://scriptable.app).
// One glance: today's status and recovery score, the session to do (with its steps),
// last night's vitals, this week's balance and the countdown to the next race.
// Tap the widget to open the full dashboard.
//
// Setup: paste this script into Scriptable, fill in SLEUTEL (your MCP_SECRET),
// add a Scriptable widget to the home screen and pick this script.
// Large shows everything; medium and small show the essentials.

const SERVER = "https://apple-health-mcp-weld-iota.vercel.app";
const SLEUTEL = "PLAK-HIER-JE-MCP_SECRET";
const DASHBOARD = "https://claude.ai/artifact/KEHQuNifF2n9DmKmjoW9yA";
// Name of this script in Scriptable; the refresh button runs it.
const SCRIPT_NAAM = Script.name() || "Hybrid Training";
const VERVERS_URL = "scriptable:///run/" + encodeURIComponent(SCRIPT_NAAM);

const DOEL_KRACHT = 3, DOEL_RUNS = 3, DOEL_RUSTIG = 80;
// Your Apple Watch ring goals (Activity app on your iPhone): change these to yours.
const RING_BEWEEG = 700;   // kcal actief
const RING_TRAINING = 30;  // minuten
const RING_STAAN = 12;     // uren

async function healthSql(query) {
  const req = new Request(SERVER + "/api/mcp");
  req.method = "POST";
  req.headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": "Bearer " + SLEUTEL };
  req.body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "health_sql", arguments: { query } } });
  const text = await req.loadString();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const payload = JSON.parse(line ? line.slice(6) : text);
  return JSON.parse(payload.result.content[0].text);
}

// Live: today's activity so far (one value per hour, so double-delivered hours count once).
async function laadRingen() {
  const rows = await healthSql(
    "with x as (select metric_name m, date_trunc('hour', date) h, max(qty) q, max(date) laatst from metric_samples " +
    "where metric_name in ('active_energy','apple_exercise_time','apple_stand_hour','step_count') " +
    "and date >= (date_trunc('day', now() at time zone 'Europe/Amsterdam') at time zone 'Europe/Amsterdam') group by 1, 2) " +
    "select m, sum(q) s, max(laatst) laatst from x group by m");
  const r = { beweeg: 0, training: 0, staan: 0, stappen: 0, laatst: null };
  rows.forEach((x) => {
    const v = Number(x.s) || 0;
    if (x.m === "active_energy") r.beweeg = v / 4.184;
    if (x.m === "apple_exercise_time") r.training = v;
    if (x.m === "apple_stand_hour") r.staan = Math.min(v, 24);
    if (x.m === "step_count") r.stappen = v;
    if (x.laatst && (!r.laatst || x.laatst > r.laatst)) r.laatst = x.laatst;
  });
  return r;
}

async function laadSamenvatting() {
  const req = new Request(SERVER + "/api/mcp");
  req.method = "POST";
  req.headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": "Bearer " + SLEUTEL,
  };
  req.body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "health_sql", arguments: { query:
      "select date, qty, extra from metric_samples where metric_name = 'dashboard_samenvatting' order by date desc limit 1" } },
  });
  const text = await req.loadString();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const payload = JSON.parse(line ? line.slice(6) : text);
  const rows = JSON.parse(payload.result.content[0].text);
  if (!rows.length) throw new Error("Nog geen samenvatting");
  const r = rows[0];
  const d = { ...r.extra, herstel: r.qty == null ? null : Math.round(Number(r.qty)) };
  if (typeof d.onderdelen === "string") { try { d.onderdelen = JSON.parse(d.onderdelen); } catch (e) { d.onderdelen = [d.onderdelen]; } }
  if (!Array.isArray(d.onderdelen)) d.onderdelen = [];
  if (typeof d.week_dagen === "string") { try { d.week_dagen = JSON.parse(d.week_dagen); } catch (e) { d.week_dagen = []; } }
  if (!Array.isArray(d.week_dagen)) d.week_dagen = [];
  return d;
}

// ---------- look
const kleur = {
  groen: new Color("#30D158"), oranje: new Color("#FF9F0A"), rood: new Color("#FF453A"), onbekend: new Color("#8E8E93"),
};
const tekst = Color.dynamic(new Color("#1C1C1E"), new Color("#F2F2F7"));
const zacht = Color.dynamic(new Color("#6C6C70"), new Color("#AEAEB2"));
const achtergrond = Color.dynamic(new Color("#FFFFFF"), new Color("#1C1C1E"));
const vlak = Color.dynamic(new Color("#F2F2F7"), new Color("#2C2C2E"));
const balkLeeg = Color.dynamic(new Color("#E5E5EA"), new Color("#3A3A3C"));
const blauw = new Color("#0A84FF"), paars = new Color("#BF5AF2");
const statusTekst = { groen: "Groen · goed hersteld", oranje: "Oranje · rustig aan", rood: "Rood · rustdag", onbekend: "Nog geen meting" };

const nl = (v, d = 0) => (v == null ? "–" : Number(v).toFixed(d).replace(".", ","));
const plus = (v, d = 1) => (v == null ? "–" : (v > 0 ? "+" : "") + nl(v, d));

function label(stack, t, size, color, weight) {
  const l = stack.addText(t);
  l.font = weight === "bold" ? Font.boldSystemFont(size) : weight ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  l.textColor = color;
  l.lineLimit = 1;
  l.minimumScaleFactor = 0.6;
  return l;
}

function balk(stack, pct, color, width) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, 5);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const bg = new Path(); bg.addRoundedRect(new Rect(0, 0, width, 5), 2.5, 2.5);
  ctx.addPath(bg); ctx.setFillColor(balkLeeg); ctx.fillPath();
  const w = Math.max(0, Math.min(1, pct)) * width;
  if (w > 0) { const f = new Path(); f.addRoundedRect(new Rect(0, 0, w, 5), 2.5, 2.5); ctx.addPath(f); ctx.setFillColor(color); ctx.fillPath(); }
  const img = stack.addImage(ctx.getImage());
  img.imageSize = new Size(width, 5);
}

function vital(stack, naam, waarde, kleurWaarde) {
  const s = stack.addStack(); s.layoutVertically();
  label(s, naam, 9, zacht);
  label(s, waarde, 13, kleurWaarde || tekst, "semi");
}

function weekRegel(stack, naam, waarde, pct, color, width) {
  const s = stack.addStack(); s.layoutVertically(); s.spacing = 2;
  const top = s.addStack();
  label(top, naam, 9, zacht); top.addSpacer(); label(top, waarde, 9, tekst, "semi");
  balk(s, pct, color, width);
}

function slaapHrKleur(v) {
  if (v == null) return tekst;
  return v >= 50 ? kleur.rood : v > 45 ? kleur.oranje : kleur.groen;
}

// ---------- blocks
function kop(w, d, c, metWedstrijd) {
  const k = w.addStack(); k.centerAlignContent();
  const dot = k.addText("●"); dot.textColor = c; dot.font = Font.systemFont(10);
  k.addSpacer(4);
  label(k, statusTekst[d.status] || "Herstel", 11, c, "semi");
  k.addSpacer();
  if (metWedstrijd && d.wedstrijd && d.wedstrijd_dagen != null) {
    label(k, d.wedstrijd.replace(" Rotterdam", "") + " · nog " + d.wedstrijd_dagen + " d", 10, zacht, "semi");
  }
}

function scoreEnTraining(w, d, c, titelGrootte, titelRegels) {
  const rij = w.addStack(); rij.centerAlignContent();
  const sc = rij.addStack(); sc.layoutVertically();
  label(sc, nl(d.herstel), 34, c, "bold");
  label(sc, "herstel", 9, zacht);
  rij.addSpacer(10);
  const r = rij.addStack(); r.layoutVertically();
  label(r, "Vandaag", 9, zacht, "semi");
  const t = r.addText(d.advies || "–"); t.font = Font.semiboldSystemFont(titelGrootte); t.textColor = tekst; t.lineLimit = titelRegels; t.minimumScaleFactor = 0.75;
}

function onderdelenBlok(w, d, max) {
  const items = (d.onderdelen || []).slice(0, max);
  if (!items.length) return;
  const box = w.addStack(); box.layoutVertically(); box.spacing = 2;
  box.backgroundColor = vlak; box.cornerRadius = 8; box.setPadding(6, 8, 6, 8);
  items.forEach((o) => {
    const regel = box.addStack();
    const b = regel.addText("• "); b.font = Font.systemFont(10); b.textColor = zacht;
    const t = regel.addText(o); t.font = Font.systemFont(10); t.textColor = tekst; t.lineLimit = 2; t.minimumScaleFactor = 0.85;
    regel.addSpacer();
  });
  const rest = (d.onderdelen || []).length - items.length;
  if (rest > 0) label(box, "+ " + rest + " meer in het dashboard", 9, zacht);
}

function vitalsRij(w, d, groot) {
  const v = w.addStack(); v.spacing = groot ? 12 : 10;
  vital(v, "Slaap", nl(d.slaap_u, 1) + " u");
  vital(v, "Score", nl(d.slaapscore));
  vital(v, "Slaap-HR", nl(d.slaap_hr), slaapHrKleur(d.slaap_hr));
  vital(v, "HRV", nl(d.hrv) + (groot ? " / " + nl(d.hrv_basis) : ""));
  if (groot) vital(v, "VO₂max", nl(d.vo2max, 1));
}

function weekBlok(w, d, breedte) {
  const wk = w.addStack(); wk.spacing = 10;
  weekRegel(wk, "Kracht", nl(d.week_kracht) + "/" + DOEL_KRACHT, (d.week_kracht || 0) / DOEL_KRACHT, kleur.groen, breedte);
  weekRegel(wk, "Runs", nl(d.week_runs) + "/" + DOEL_RUNS + " · " + nl(d.week_km, 1) + " km", (d.week_runs || 0) / DOEL_RUNS, blauw, breedte);
  weekRegel(wk, "Rustig", d.week_rustig_pct == null ? "–" : nl(d.week_rustig_pct) + "%", (d.week_rustig_pct || 0) / DOEL_RUSTIG, paars, breedte);
}

const ringKleur = { beweeg: new Color("#FA114F"), training: new Color("#A6FF00"), staan: new Color("#00F0FF") };

function ringenAfbeelding(r, maat) {
  const ctx = new DrawContext();
  ctx.size = new Size(maat, maat);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const dik = maat * 0.12, gap = maat * 0.02;
  const ringen = [
    [r.beweeg / RING_BEWEEG, ringKleur.beweeg],
    [r.training / RING_TRAINING, ringKleur.training],
    [r.staan / RING_STAAN, ringKleur.staan],
  ];
  ringen.forEach(([pct, kl], i) => {
    const straal = maat / 2 - dik / 2 - i * (dik + gap);
    const c = maat / 2;
    const boog = (van, tot, kleur) => {
      const p = new Path();
      const stappen = Math.max(2, Math.ceil((tot - van) * 120));
      for (let k = 0; k <= stappen; k++) {
        const a = -Math.PI / 2 + 2 * Math.PI * (van + (tot - van) * (k / stappen));
        const pt = new Point(c + straal * Math.cos(a), c + straal * Math.sin(a));
        if (k === 0) p.move(pt); else p.addLine(pt);
      }
      ctx.addPath(p); ctx.setStrokeColor(kleur); ctx.setLineWidth(dik); ctx.strokePath();
    };
    boog(0, 1, new Color(kl.hex, 0.22));
    const vol = Math.max(0, Math.min(pct, 1));
    if (vol > 0) boog(0, vol, kl);
    if (pct > 1) boog(0, Math.min(pct - 1, 1), new Color(kl.hex, 0.75));
  });
  return ctx.getImage();
}

function ringenBlok(w, r, groot) {
  const rij = w.addStack(); rij.centerAlignContent();
  const maat = groot ? 58 : 46;
  const img = rij.addImage(ringenAfbeelding(r, maat));
  img.imageSize = new Size(maat, maat);
  rij.addSpacer(10);
  const kol = rij.addStack(); kol.layoutVertically(); kol.spacing = 1;
  const regel = (kleurR, naam, v, doel, eenheid) => {
    const st = kol.addStack(); st.centerAlignContent();
    label(st, naam + " ", 10, zacht);
    label(st, Math.round(v) + "/" + doel + " " + eenheid, 11, kleurR, "semi");
  };
  regel(ringKleur.beweeg, "Beweeg", r.beweeg, RING_BEWEEG, "kcal");
  regel(ringKleur.training, "Training", r.training, RING_TRAINING, "min");
  regel(ringKleur.staan, "Staan", r.staan, RING_STAAN, "u");
  rij.addSpacer();
  const rechts = rij.addStack(); rechts.layoutVertically();
  label(rechts, "Stappen", 9, zacht);
  label(rechts, Math.round(r.stappen).toLocaleString("nl-NL"), 13, tekst, "semi");
}

function weekStrip(w, d) {
  if (!d.week_dagen.length) return;
  const rij = w.addStack(); rij.spacing = 4;
  d.week_dagen.forEach((dag) => {
    const k = rij.addStack(); k.layoutVertically(); k.spacing = 1;
    k.size = new Size(40, 44);
    k.cornerRadius = 6; k.setPadding(3, 4, 3, 4);
    k.backgroundColor = dag.vandaag ? vlak : achtergrond;
    if (dag.vandaag) { k.borderColor = tekst; k.borderWidth = 1; }
    const top = k.addStack(); top.centerAlignContent();
    label(top, dag.dag, 9, dag.vandaag ? tekst : zacht, dag.vandaag ? "bold" : "semi");
    top.addSpacer();
    const teken = dag.gedaan ? "✓" : dag.verleden ? "–" : dag.vandaag ? "●" : "";
    if (teken) label(top, teken, 9, dag.gedaan ? kleur.groen : dag.vandaag ? (kleur[d.status] || zacht) : zacht, "bold");
    const t = k.addText(dag.tekst || (dag.verleden ? "rust" : ""));
    t.font = Font.systemFont(8); t.textColor = dag.gedaan || dag.vandaag ? tekst : zacht; t.lineLimit = 2; t.minimumScaleFactor = 0.7;
    k.addSpacer();
  });
}

function dagInfo(w, d) {
  const rij = w.addStack(); rij.centerAlignContent();
  if (d.voeding) label(rij, "🍽 " + d.voeding, 10, tekst, "semi");
  rij.addSpacer();
  if (d.bedtijd) label(rij, "🛏 Vanavond slapen om " + d.bedtijd, 10, tekst, "semi");
}

function voet(w, d) {
  const f = w.addStack(); f.centerAlignContent();
  const df = new DateFormatter(); df.dateFormat = "HH:mm";
  if (d.vers === false) {
    label(f, "⚠︎ Slaap van vannacht nog niet binnen", 8, kleur.oranje);
  } else {
    const sync = d.ringen && d.ringen.laatst ? df.string(new Date(String(d.ringen.laatst).replace(" ", "T").replace(/\+00$/, "+00:00"))) : "–";
    label(f, "iPhone-sync " + sync + " · widget " + df.string(new Date()), 8, zacht);
  }
  f.addSpacer();
  const knop = f.addStack(); knop.url = VERVERS_URL;
  knop.backgroundColor = vlak; knop.cornerRadius = 6; knop.setPadding(2, 7, 2, 7);
  label(knop, "↻ Ververs", 9, tekst, "semi");
  f.addSpacer(6);
  const naarDashboard = f.addStack(); naarDashboard.url = DASHBOARD;
  naarDashboard.backgroundColor = vlak; naarDashboard.cornerRadius = 6; naarDashboard.setPadding(2, 7, 2, 7);
  label(naarDashboard, "Dashboard ›", 9, tekst, "semi");
}

// ---------- widget sizes
function bouwWidget(d, size) {
  const w = new ListWidget();
  w.backgroundColor = achtergrond;
  w.url = DASHBOARD;
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  const c = kleur[d.status] || kleur.onbekend;

  if (size === "small") {
    w.setPadding(12, 12, 12, 12);
    kop(w, d, c, false);
    w.addSpacer(2);
    label(w, nl(d.herstel), 32, c, "bold");
    const a = w.addText(d.advies || "–"); a.font = Font.semiboldSystemFont(12); a.textColor = tekst; a.lineLimit = 3; a.minimumScaleFactor = 0.7;
    w.addSpacer();
    label(w, "Slaap " + nl(d.slaap_u, 1) + " u · HR " + nl(d.slaap_hr), 9, zacht);
    return w;
  }

  if (size === "medium") {
    w.setPadding(12, 14, 10, 14);
    kop(w, d, c, true);
    w.addSpacer(4);
    scoreEnTraining(w, d, c, 14, 2);
    w.addSpacer(6);
    vitalsRij(w, d, false);
    w.addSpacer(6);
    if (d.ringen) ringenBlok(w, d.ringen, false); else weekBlok(w, d, 88);
    w.addSpacer();
    voet(w, d);
    return w;
  }

  // large (and extra large): everything
  w.setPadding(14, 14, 10, 14);
  kop(w, d, c, true);
  w.addSpacer(6);
  scoreEnTraining(w, d, c, 16, 2);
  w.addSpacer(6);
  onderdelenBlok(w, d, 4);
  w.addSpacer(6);
  vitalsRij(w, d, true);
  w.addSpacer(6);
  if (d.ringen) ringenBlok(w, d.ringen, true); else weekBlok(w, d, 92);
  w.addSpacer(6);
  weekStrip(w, d);
  w.addSpacer(8);
  dagInfo(w, d);
  w.addSpacer();
  voet(w, d);
  return w;
}

function foutWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = achtergrond;
  w.url = DASHBOARD;
  label(w, "Hybrid Training", 12, zacht, "semi");
  w.addSpacer(4);
  const t = w.addText(msg); t.font = Font.systemFont(12); t.textColor = tekst;
  return w;
}

let widget;
const size = config.widgetFamily || "large";
try {
  const d = await laadSamenvatting();
  try { d.ringen = await laadRingen(); } catch (e) { d.ringen = null; }
  widget = bouwWidget(d, size);
} catch (e) {
  widget = foutWidget("Kon de gegevens niet laden: " + e.message);
}
if (config.runsInWidget) {
  Script.setWidget(widget);
} else if (size === "small") {
  await widget.presentSmall();
} else if (size === "medium") {
  await widget.presentMedium();
} else {
  await widget.presentLarge();
}
Script.complete();
