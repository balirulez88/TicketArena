// The dashboard's stylesheet, inlined into the page (the CSP allows inline styles, not scripts).
// Dark first; a light theme follows the OS setting. One tone vocabulary (`t-*`) colours every
// status on the page, and each tone is always paired with a text label.

export const STYLE = `
:root{color-scheme:dark;
--bg:#0a0b0d;--panel:#111316;--panel-2:#15181c;--hover:#1a1e23;--line:#22262c;--line-2:#2d323a;
--fg:#e7e9ec;--muted:#8a919b;--faint:#5c636d;--accent:#8b9cff;
--ok:#3fb950;--info:#58a6ff;--live:#2dd4bf;--warn:#e3b341;--bad:#f2675e;--neutral:#8a919b;
--sev-critical:#d03b3b;--sev-high:#ec835a;--sev-medium:#fab219;--sev-low:#6e7681;
--radius:10px;--shadow:0 1px 0 rgba(255,255,255,.03) inset,0 8px 24px rgba(0,0,0,.25)}
@media (prefers-color-scheme:light){:root{color-scheme:light;
--bg:#f6f7f9;--panel:#fff;--panel-2:#f9fafb;--hover:#f1f3f5;--line:#e4e7eb;--line-2:#d5dae0;
--fg:#16181b;--muted:#5f6670;--faint:#8b929b;--accent:#4f5bd5;
--ok:#1a7f37;--info:#0969da;--live:#0f766e;--warn:#9a6700;--bad:#cf222e;--neutral:#6e7681;
--sev-low:#8c959f;--shadow:0 1px 2px rgba(16,24,40,.05)}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:13.5px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
code,.mono{font-family:ui-monospace,SFMono-Regular,"Cascadia Code",Menlo,Consolas,monospace;font-size:12px}
code{background:var(--panel-2);border:1px solid var(--line);border-radius:4px;padding:0 4px}
h2{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 4px}
h3{font-size:13px;font-weight:600;margin:0}
h4{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 0 6px}
p{margin:0 0 8px}
a{color:inherit;text-decoration:none}
.muted{color:var(--muted)}.small{font-size:12px}.strong{font-weight:600}.spacer{flex:1}
.clamp{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;min-width:0}
.link{color:var(--accent)}.link:hover{text-decoration:underline}
ul.plain,ul.list,ol.feed,ol.timeline,ul.findings,ol.history{list-style:none;margin:0;padding:0}
ul.reasons{margin:4px 0 0;padding-left:18px;color:var(--muted);font-size:12px}

/* tones */
.t-ok{--tone:var(--ok)}.t-info{--tone:var(--info)}.t-live{--tone:var(--live)}
.t-warn{--tone:var(--warn)}.t-bad{--tone:var(--bad)}.t-muted{--tone:var(--neutral)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--tone);flex:none;margin-right:6px;vertical-align:middle}
.badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:500;white-space:nowrap;
color:var(--tone);background:color-mix(in srgb,var(--tone) 13%,transparent);border:1px solid color-mix(in srgb,var(--tone) 28%,transparent)}
.badge.calc{background:transparent;border-style:dashed}
.calc-mark{font:600 9.5px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border:1px dashed var(--line-2);border-radius:3px;padding:1px 3px;margin-right:5px;vertical-align:1px}
.tag{display:inline-block;font:700 10px/1.6 ui-monospace,monospace;letter-spacing:.06em;border-radius:4px;padding:0 5px;vertical-align:2px}
.tag-live{color:var(--live);background:color-mix(in srgb,var(--live) 14%,transparent)}
.tag-historical{color:var(--muted);background:var(--panel-2);border:1px solid var(--line)}
.tag-unavailable{color:var(--bad);background:repeating-linear-gradient(45deg,color-mix(in srgb,var(--bad) 18%,transparent) 0 4px,transparent 4px 8px)}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{display:inline-block;font-size:11px;padding:0 6px;border-radius:5px;border:1px solid var(--line-2);color:var(--muted);background:var(--panel-2)}
a.chip:hover{border-color:var(--accent);color:var(--fg)}
.chip-ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent)}
.chip-warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,transparent)}
.chip-bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,transparent)}

/* shell */
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:18px;padding:18px 12px;border-right:1px solid var(--line);background:var(--panel)}
.brand{display:flex;align-items:center;gap:10px;padding:0 8px}
.logo{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;font-weight:700;color:#fff;background:linear-gradient(135deg,#6e7bff,#2dd4bf)}
.brand-name{font-weight:600}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:7px;color:var(--muted);font-weight:500}
.nav a:hover{background:var(--hover);color:var(--fg)}
.nav a[aria-current=page]{background:var(--hover);color:var(--fg);box-shadow:inset 2px 0 0 var(--accent)}
.nav a span:nth-child(2){flex:1}
.nav .dot{margin:0}
.icon{width:16px;height:16px;flex:none}
.count{font-size:11px;padding:0 7px;border-radius:999px;background:var(--panel-2);border:1px solid var(--line);color:var(--muted)}
.count.t-warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,transparent)}
.sidebar-foot{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding:0 8px}
.content{min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 28px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(8px)}
.topbar-status,.topbar-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#refresh-stamp.bad{color:var(--bad)}
.btn{font:inherit;font-size:12px;color:var(--fg);background:var(--panel);border:1px solid var(--line-2);border-radius:7px;padding:4px 10px;cursor:pointer}
.btn:hover{background:var(--hover)}
.btn[aria-pressed=true]{border-color:var(--warn);color:var(--warn)}
html:not(.js) .btn{display:none}
main{padding:24px 28px 48px;max-width:1440px;width:100%;margin:0 auto}
.view{scroll-margin-top:72px}
.view+.view{margin-top:40px}
.js .view+.view{margin-top:0}
.view-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:18px}
.view-head p{max-width:820px;margin:0}
.section-title{display:flex;align-items:center;gap:8px;margin:22px 0 10px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}

/* cards */
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow);min-width:0}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px;align-items:start}
.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:14px}
.stack{display:flex;flex-direction:column;gap:12px}
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.kpis-4{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:0}
.kpi{display:flex;flex-direction:column;gap:2px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;box-shadow:var(--shadow);transition:border-color .15s}
.kpi:hover{border-color:var(--line-2)}
.kpi-label{color:var(--muted);font-size:12px;font-weight:500}
.kpi-value{font-size:28px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi-sub{color:var(--faint);font-size:11.5px}
.empty{display:flex;gap:6px;align-items:flex-start;padding:6px 0}
.empty .dot{margin-top:6px}
.empty-title{font-weight:600}
.meta-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-bottom:10px}
.note{font-size:12px;padding:8px 10px;border-radius:7px;border:1px solid var(--line)}
.note.warn{border-color:color-mix(in srgb,var(--warn) 35%,transparent);background:color-mix(in srgb,var(--warn) 7%,transparent)}
dl.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 16px;margin:0}
dl.kv dt{color:var(--muted);font-size:12px}
dl.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
dl.kv.compact{gap:5px 14px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
ul.list>li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--line)}
ul.list>li:last-child{border-bottom:0}
ul.list>li.held{display:block}
ul.plain>li{padding:4px 0;overflow-wrap:anywhere}

/* hero */
.hero-main{display:flex;gap:14px;align-items:center}
.hero-title{font-size:16px;font-weight:600}
.hero-run{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px;padding:8px 10px;border-radius:8px;background:var(--panel-2);border:1px solid var(--line)}
.pulse{position:relative;width:12px;height:12px;border-radius:50%;background:var(--tone);flex:none}
.hero-live .pulse::after{content:"";position:absolute;inset:-5px;border-radius:50%;border:2px solid var(--tone);opacity:.6;animation:pulse 1.8s ease-out infinite}
.hero-live{border-color:color-mix(in srgb,var(--live) 35%,var(--line))}
.hero-stale{border-color:color-mix(in srgb,var(--warn) 35%,var(--line))}
.hero-unknown{border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}
@keyframes pulse{from{transform:scale(.6);opacity:.7}to{transform:scale(1.6);opacity:0}}
@media (prefers-reduced-motion:reduce){.hero-live .pulse::after{animation:none}}

/* feed */
ol.feed>li{display:flex;gap:4px;padding:6px 0;border-bottom:1px solid var(--line)}
ol.feed>li:last-child{border-bottom:0}
ol.feed .dot{margin-top:6px}

/* board */
.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.toolbar input,.toolbar select{font:inherit;color:var(--fg);background:var(--panel);border:1px solid var(--line-2);border-radius:7px;padding:6px 10px}
.toolbar input{flex:1;min-width:200px;max-width:360px}
.toolbar input:focus,.toolbar select:focus{outline:2px solid color-mix(in srgb,var(--accent) 50%,transparent);outline-offset:0}
.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(270px,1fr);gap:12px;overflow-x:auto;padding-bottom:8px;align-items:start}
.column{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius);min-width:0}
.column-head{display:flex;align-items:center;gap:2px;padding:10px 12px;font-weight:600;border-bottom:1px solid var(--line)}
.column-head .count{margin-left:auto}
.column-body{display:flex;flex-direction:column;gap:8px;padding:10px;max-height:72vh;overflow-y:auto}
.empty-col{text-align:center;padding:10px 0;margin:0}
.tcard{display:flex;flex-direction:column;gap:8px;padding:10px 12px;background:var(--panel);border:1px solid var(--line);border-radius:8px;transition:border-color .15s,transform .15s}
.tcard:hover,.tcard:focus-visible{border-color:var(--line-2);transform:translateY(-1px)}
.tcard-top{display:flex;align-items:center;gap:6px}
.tcard-title{font-weight:500;line-height:1.35}
.tcard-foot{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.progress{height:3px;border-radius:2px;background:var(--line);overflow:hidden}
.progress span{display:block;height:100%;background:var(--ok)}

/* pipelines */
.pipeline-wrap{margin-top:12px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2)}
.pipeline-head{display:flex;gap:10px;align-items:baseline;margin-bottom:10px}
ol.pipeline{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));list-style:none;margin:0;padding:0}
.stage{position:relative;display:flex;flex-direction:column;gap:2px;padding-right:10px;min-width:0}
.stage::before{content:"";position:absolute;top:7px;left:16px;right:0;height:2px;background:var(--line-2)}
.stage:last-child::before{display:none}
.stage.s-completed::before{background:color-mix(in srgb,var(--ok) 55%,var(--line-2))}
.stage-node{position:relative;width:16px;height:16px;border-radius:50%;border:2px solid var(--tone);background:var(--panel-2)}
.s-completed .stage-node{background:var(--tone)}
.s-failed .stage-node{background:var(--tone)}
.s-active .stage-node{background:var(--tone);box-shadow:0 0 0 4px color-mix(in srgb,var(--tone) 25%,transparent)}
.s-unknown .stage-node{border-style:dashed;opacity:.7}
.s-stale .stage-node{border-style:dotted}
.stage-name{font-weight:600;font-size:12.5px;margin-top:4px}
.stage-state{font-size:11.5px;color:var(--muted)}
.s-active .stage-state{color:var(--live)}.s-failed .stage-state{color:var(--bad)}
.s-completed .stage-state{color:var(--ok)}.s-stale .stage-state{color:var(--warn)}
.stage-note{font-size:11px;color:var(--faint);overflow-wrap:anywhere}
.legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;color:var(--muted);font-size:12px}

/* timelines */
ol.timeline{position:relative;margin-left:4px;border-left:1px solid var(--line-2)}
.tl-item{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:5px 0 5px 12px;position:relative}
.tl-item .dot{position:absolute;left:-5px;margin:0}
details.disclosure>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
details.disclosure>summary::-webkit-details-marker{display:none}
details.disclosure>summary::before{content:"";width:6px;height:6px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(-45deg);transition:transform .15s;flex:none;margin-right:2px}
details.disclosure[open]>summary::before{transform:rotate(45deg)}
.run-card details.disclosure{margin-top:12px}
.run-collapse>summary{padding:2px 0}
ol.history{position:relative;padding-left:22px}
ol.history::before{content:"";position:absolute;left:6px;top:8px;bottom:8px;width:1px;background:var(--line-2)}
.history-item{position:relative;margin-bottom:10px}
.history-dot{position:absolute;left:-21px;top:16px;width:11px;height:11px;border-radius:50%;background:var(--tone);border:2px solid var(--bg)}
.history-summary{padding:2px 0}
.history-body{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}

/* debt */
.sevchart{display:flex;flex-direction:column;gap:10px}
.sevrow{display:grid;grid-template-columns:72px minmax(0,1fr) 92px;gap:10px;align-items:center}
.sevlabel{font-size:11.5px;font-weight:600;color:var(--muted)}
.sevbar{display:flex;gap:2px;height:12px}
.sevbar .seg{display:block;height:100%;min-width:3px}
.sevbar .seg:first-child{border-radius:4px 0 0 4px}.sevbar .seg:last-child{border-radius:0 4px 4px 0}
.sevbar .seg:only-child{border-radius:4px}
.sev-critical{--sev:var(--sev-critical)}.sev-high{--sev:var(--sev-high)}.sev-medium{--sev:var(--sev-medium)}
.sev-low,.sev-other{--sev:var(--sev-low)}
.seg-open{background:var(--sev,var(--fg))}
.seg-planned{background:color-mix(in srgb,var(--sev,var(--fg)) 45%,transparent)}
.seg-resolved{background:repeating-linear-gradient(135deg,var(--line-2) 0 2px,transparent 2px 5px);box-shadow:inset 0 0 0 1px var(--line-2)}
.sevnums{color:var(--muted);text-align:right}
.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px;--sev:var(--muted)}
.sevpill{display:inline-block;font:700 10px/1.7 ui-monospace,monospace;letter-spacing:.04em;padding:0 6px;border-radius:4px;color:var(--sev);border:1px solid color-mix(in srgb,var(--sev) 40%,transparent);background:color-mix(in srgb,var(--sev) 12%,transparent);min-width:66px;text-align:center}
ul.findings>li{border-bottom:1px solid var(--line)}
ul.findings>li:last-child{border-bottom:0}
.finding{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 6px;border-radius:6px}
.finding:hover{background:var(--hover)}
.finding-title{min-width:0;flex:1 1 280px}

/* drawer: client opens it with .open; without script, :target does */
.drawer{position:fixed;inset:0;z-index:20;display:none}
.drawer.open,.drawer:has(.detail:target){display:block}
.scrim{position:absolute;inset:0;background:rgba(0,0,0,.45)}
.panel{position:absolute;top:0;right:0;bottom:0;width:min(520px,100%);overflow-y:auto;padding:22px 22px 40px;background:var(--panel);border-left:1px solid var(--line-2);box-shadow:-12px 0 32px rgba(0,0,0,.3);animation:slide .18s ease-out}
@keyframes slide{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}
.close{position:absolute;top:14px;right:16px;color:var(--muted);font-size:14px;padding:4px 8px;border-radius:6px}
.close:hover{background:var(--hover);color:var(--fg)}
.detail{display:none}
.detail.open,.detail:target{display:block}
.detail h3{font-size:17px;margin:2px 0 16px;padding-right:30px}

/* responsive */
@media (max-width:1200px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.grid-3{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:900px){
.app{grid-template-columns:minmax(0,1fr)}
.sidebar{position:static;height:auto;flex-direction:row;align-items:center;flex-wrap:wrap;padding:10px 16px;border-right:0;border-bottom:1px solid var(--line)}
.nav{flex-direction:row;overflow-x:auto;flex:1 1 100%}
.nav a{white-space:nowrap}
.sidebar-foot{flex:1 1 100%;flex-direction:row;flex-wrap:wrap;align-items:center;gap:2px 10px;margin:0;padding:0;min-width:0}
.sidebar-foot .clamp{flex:1 1 160px}
.topbar,main{padding-left:16px;padding-right:16px}
.grid-2,.grid-3,.kpis-4{grid-template-columns:minmax(0,1fr)}
.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
ol.pipeline{grid-template-columns:minmax(0,1fr);gap:8px}
.stage{flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px}
.stage::before{display:none}
.stage-note{flex-basis:100%;padding-left:24px}
.stage-name{margin:0}
.view-head{flex-direction:column;align-items:flex-start}
}
`;
