// Hybrid Training widget for the iOS app Scriptable (https://scriptable.app).
// Shows today's recovery score, the suggested session, HRV / resting HR / sleep and
// this week's balance. Tap the widget to open the full dashboard.
//
// Setup: paste this script into Scriptable, fill in SERVER and SLEUTEL (your
// MCP_SECRET), add a Scriptable widget to the home screen and pick this script.
// Works in small, medium and large widget sizes.

const SERVER = "https://apple-health-mcp-weld-iota.vercel.app";
const SLEUTEL = "PLAK-HIER-JE-MCP_SECRET";
const DASHBOARD = "https://claude.ai/artifact/KEHQuNifF2n9DmKmjoW9yA";

const DOEL_KRACHT = 3, DOEL_RUNS = 3, DOEL_RUSTIG = 80;

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
  return { ...r.extra, herstel: r.qty == null ? null : Math.round(Number(r.qty)), opgeslagen: r.date };
}

const kleur = {
  groen: new Color("#34C759"), oranje: new Color("#FF9F0A"), rood: new Color("#FF453A"), onbekend: new Color("#8E8E93"),
};
const tekst = Color.dynamic(new Color("#1C1C1E"), new Color("#F2F2F7"));
const zacht = Color.dynamic(new Color("#6C6C70"), new Color("#AEAEB2"));
const achtergrond = Color.dynamic(new Color("#FFFFFF"), new Color("#1C1C1E"));
const balkLeeg = Color.dynamic(new Color("#E5E5EA"), new Color("#3A3A3C"));
const statusTekst = { groen: "Goed hersteld", oranje: "Matig hersteld", rood: "Rust nodig", onbekend: "Nog geen meting" };

const nl = (v, d = 0) => (v == null ? "–" : Number(v).toFixed(d).replace(".", ","));

function label(stack, t, size, color, bold) {
  const l = stack.addText(t);
  l.font = bold ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  l.textColor = color;
  l.lineLimit = 1;
  l.minimumScaleFactor = 0.6;
  return l;
}

function balk(stack, pct, color, width) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, 6);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const pad = new Path(); pad.addRoundedRect(new Rect(0, 0, width, 6), 3, 3);
  ctx.addPath(pad); ctx.setFillColor(balkLeeg); ctx.fillPath();
  const w = Math.max(0, Math.min(1, pct)) * width;
  if (w > 0) { const f = new Path(); f.addRoundedRect(new Rect(0, 0, w, 6), 3, 3); ctx.addPath(f); ctx.setFillColor(color); ctx.fillPath(); }
  const img = stack.addImage(ctx.getImage());
  img.imageSize = new Size(width, 6);
}

function vital(stack, naam, waarde, normaal) {
  const s = stack.addStack(); s.layoutVertically();
  label(s, naam, 10, zacht);
  label(s, waarde, 14, tekst, true);
  if (normaal) label(s, normaal, 9, zacht);
}

function weekRegel(stack, naam, waarde, pct, color, width) {
  const s = stack.addStack(); s.layoutVertically(); s.spacing = 2;
  const top = s.addStack();
  label(top, naam, 10, zacht); top.addSpacer(); label(top, waarde, 10, tekst, true);
  balk(s, pct, color, width);
}

function bouwWidget(d, size) {
  const w = new ListWidget();
  w.backgroundColor = achtergrond;
  w.url = DASHBOARD;
  w.setPadding(14, 14, 14, 14);
  w.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000);
  const c = kleur[d.status] || kleur.onbekend;

  const kop = w.addStack(); kop.centerAlignContent();
  const dot = kop.addText("●"); dot.textColor = c; dot.font = Font.systemFont(10);
  kop.addSpacer(4);
  label(kop, statusTekst[d.status] || "Herstel", 11, zacht, true);
  kop.addSpacer();
  if (size !== "small") label(kop, "Hybrid Training", 11, zacht);
  w.addSpacer(4);

  if (size === "small") {
    const sc = w.addStack(); sc.bottomAlignContent();
    label(sc, nl(d.herstel), 40, c, true); sc.addSpacer(2); label(sc, "/100", 12, zacht);
    w.addSpacer(2);
    const a = w.addText(d.advies || "–"); a.font = Font.semiboldSystemFont(13); a.textColor = tekst; a.lineLimit = 2; a.minimumScaleFactor = 0.7;
    w.addSpacer();
    label(w, "Slaap " + nl(d.slaap_u, 1) + " u (" + nl(d.slaapscore) + ") · HRV " + nl(d.hrv), 10, zacht);
    return w;
  }

  const rij = w.addStack(); rij.centerAlignContent();
  const links = rij.addStack(); links.layoutVertically();
  const sc = links.addStack(); sc.bottomAlignContent();
  label(sc, nl(d.herstel), 38, c, true); sc.addSpacer(2); label(sc, "/100", 11, zacht);
  rij.addSpacer(12);
  const rechts = rij.addStack(); rechts.layoutVertically();
  const a = rechts.addText(d.advies || "–"); a.font = Font.semiboldSystemFont(15); a.textColor = tekst; a.lineLimit = 2; a.minimumScaleFactor = 0.7;
  if (size === "large") {
    rechts.addSpacer(2);
    const u = rechts.addText(d.uitleg || ""); u.font = Font.systemFont(11); u.textColor = zacht; u.lineLimit = 4; u.minimumScaleFactor = 0.8;
  }
  w.addSpacer(8);

  const vit = w.addStack(); vit.spacing = 14;
  vital(vit, "HRV", nl(d.hrv) + " ms", size === "large" ? "normaal " + nl(d.hrv_basis) : null);
  vital(vit, "Rust-HR", nl(d.rhr) + " bpm", size === "large" ? "normaal " + nl(d.rhr_basis) : null);
  vital(vit, "Slaap", nl(d.slaap_u, 1) + " u", size === "large" ? "doel 7,5" : null);
  vital(vit, "Slaapscore", nl(d.slaapscore), size === "large" ? "van 100" : null);
  if (size === "large") vital(vit, "VO₂max", nl(d.vo2max, 1), "ml/kg·min");

  w.addSpacer(8);
  const barW = size === "large" ? 300 : 135;
  if (size === "large") {
    label(w, "Deze week", 11, zacht, true); w.addSpacer(4);
    const wk = w.addStack(); wk.layoutVertically(); wk.spacing = 6;
    weekRegel(wk, "Kracht", nl(d.week_kracht) + " / " + DOEL_KRACHT, (d.week_kracht || 0) / DOEL_KRACHT, kleur.groen, barW);
    weekRegel(wk, "Hardlopen", nl(d.week_runs) + " / " + DOEL_RUNS + " · " + nl(d.week_km, 1) + " km", (d.week_runs || 0) / DOEL_RUNS, new Color("#0A84FF"), barW);
    weekRegel(wk, "Rustig gelopen", d.week_rustig_pct == null ? "–" : nl(d.week_rustig_pct) + "% / " + DOEL_RUSTIG + "%", (d.week_rustig_pct || 0) / DOEL_RUSTIG, new Color("#0A84FF"), barW);
  } else {
    const wk = w.addStack(); wk.spacing = 12;
    weekRegel(wk, "Kracht", nl(d.week_kracht) + "/" + DOEL_KRACHT, (d.week_kracht || 0) / DOEL_KRACHT, kleur.groen, barW);
    weekRegel(wk, "Lopen", nl(d.week_km, 1) + " km", (d.week_runs || 0) / DOEL_RUNS, new Color("#0A84FF"), barW);
  }
  w.addSpacer();
  label(w, "Bijgewerkt " + (d.datum || "").split("-").reverse().join("-"), 9, zacht);
  return w;
}

function foutWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = achtergrond;
  w.url = DASHBOARD;
  label(w, "Hybrid Training", 12, zacht, true);
  w.addSpacer(4);
  const t = w.addText(msg); t.font = Font.systemFont(12); t.textColor = tekst;
  return w;
}

let widget;
const size = config.widgetFamily || "medium";
try {
  widget = bouwWidget(await laadSamenvatting(), size);
} catch (e) {
  widget = foutWidget("Kon de gegevens niet laden: " + e.message);
}
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
