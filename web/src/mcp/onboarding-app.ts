/** Interactive home. Uses only the shared MCP Apps bridge; no direct network or wallet authority. */
export const HOME_CSS = String.raw`
.mm-home{max-width:900px;padding:20px}.home-brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}.home-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:#b9f36e;color:#143319;font-size:21px;font-weight:800}.home-wordmark{font-weight:750;letter-spacing:-.03em;font-size:19px}.home-brand .chip{margin-left:auto}.home-hero h1{font-size:30px;line-height:1.12;letter-spacing:-.04em;margin:8px 0}.home-hero p{max-width:650px;color:var(--mm-fg2)}.home-kicker{text-transform:uppercase;letter-spacing:.13em;font-size:10px;font-weight:700;color:var(--mm-ok)}.home-tabs{display:flex;gap:4px;overflow:auto;border-bottom:1px solid var(--mm-border);margin:22px 0 18px;padding-bottom:5px}.mm-home button{font:inherit;cursor:pointer;border:1px solid var(--mm-border);border-radius:9px;background:var(--mm-bg2);color:var(--mm-fg);padding:9px 13px;font-weight:600}.mm-home button:hover{border-color:var(--mm-fg2)}.mm-home button:focus-visible,.mm-home input:focus-visible,.mm-home select:focus-visible{outline:2px solid var(--mm-ok);outline-offset:3px}.mm-home button:disabled{opacity:.5;cursor:default}.home-tabs button{border:0;background:transparent;white-space:nowrap;font-size:12px}.home-tabs button[aria-selected=true]{color:var(--mm-ok);background:var(--mm-ok-bg)}.mm-home .primary{background:#b9f36e;color:#143319;border-color:#b9f36e}.home-split{display:grid;grid-template-columns:1.4fr 1fr;gap:12px}.home-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:16px 0}.home-metric{padding:13px;border:1px solid var(--mm-border);border-radius:12px;background:var(--mm-bg2)}.home-metric strong{display:block;margin:5px 0;font-size:16px;overflow-wrap:anywhere}.home-field{display:flex;flex-direction:column;gap:6px;margin:0 0 14px;font-size:12px;font-weight:600}.mm-home input,.mm-home select{font:inherit;font-size:14px;color:var(--mm-fg);background:var(--mm-bg);border:1px solid var(--mm-border);padding:11px 12px;border-radius:9px;min-width:0;width:100%}.home-form .card{border-radius:14px}.home-step{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--mm-border)}.home-number{flex:none;border:1px solid var(--mm-border);border-radius:50%;width:24px;height:24px;display:grid;place-items:center;font-size:11px;color:var(--mm-fg2)}.home-step p{font-size:12px;color:var(--mm-fg2)}.home-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.home-footer{font-size:11px;color:var(--mm-fg2);margin:18px 0 0;padding-top:12px;border-top:1px solid var(--mm-border)}.home-result{margin-top:14px}.home-result:empty{display:none}.home-activity{border-left:2px solid var(--mm-border);padding:0 0 16px 14px;margin-left:4px}.home-activity strong{font-size:13px}.home-activity p{font-size:12px;color:var(--mm-fg2)}.home-empty{padding:22px 10px;text-align:center;color:var(--mm-fg2)}.home-status{font-size:12px;min-height:18px}.home-status:empty{display:none}.home-strategy-note{min-height:36px;color:var(--mm-fg2);font-size:12px}.mm-home a.cta{font-size:12px;background:var(--mm-ok-bg);color:var(--mm-ok)}@media(max-width:560px){.mm-home{padding:14px}.home-hero h1{font-size:26px}.home-split{grid-template-columns:1fr}.home-metrics{grid-template-columns:1fr 1fr}.home-metric:last-child{grid-column:1/-1}.home-tabs{gap:0}.home-tabs button{padding:8px 10px}}
`;

export const HOME_JS = String.raw`
var setup = null;
var homeTab = "Overview";
var homeBusy = false;
var homeGeneration = 0;
var homeDraft = null;
var homeMessage = "";
var homePanel = null;
var HOME_CALLS = {get_merryman_setup:1,list_agents:1,get_portfolio:1,get_trades:1,list_decisions:1,get_agent_controls:1,create_merryman:1,create_agent_draft:1,list_notification_channels:1,list_subscriptions:1,subscribe:1,unsubscribe:1};
var STRATEGIES = [
 ["trencher","Trencher","Find verified memecoin pools, with Brain reviews and automatic exits."],
 ["steady-basket","Steady Basket","Buy a little of your selected stocks on a schedule."],
 ["weekend-gap","Weekend Gap","Buy selected tokenised stocks while the underlying market is closed, then sell when it reopens."],
 ["llm-strategist","AI Strategist","An AI-guided strategy that evaluates market conditions."],
 ["even-keel","Even Keel · holders","Keep the stocks in your basket evenly weighted. Runs only while you hold $MERRYMEN; opens nothing new until then."],
 ["dip-hunter","Dip Hunter · holders","Look for pullbacks in the stocks you follow. Runs only while you hold $MERRYMEN; opens nothing new until then."]
];
function canHome(name) {
 var c = setup && obj(setup.connection);
 return !!(has(HOME_CALLS,name) && c && arr(c.available_tools,30).indexOf(name)>=0);
}
function homeArgs() { return setup && obj(setup.agent) ? {agent:setup.agent.id} : {}; }
function homeButton(parent,label,fn,primary) {
 var b = put(parent,"button",primary ? "primary" : null,label); b.type="button"; b.disabled=homeBusy;
 b.addEventListener("click",fn); return b;
}
function homeToolButton(parent,label,name,args,done,primary) {
 var b=homeButton(parent,label,function(){ homeCall(name,typeof args==="function"?args():args,done); },primary);
 b.disabled=homeBusy || !initialized || !obj(hostCaps.serverTools) || !canHome(name); return b;
}
function homeCall(name,args,done) {
 if(homeBusy || !initialized || !obj(hostCaps.serverTools) || !canHome(name)) return;
 homeBusy=true; homeMessage="Working…"; var generation=homeGeneration;
 var buttons=Array.from(root.querySelectorAll("button")).map(function(b){var was=b.disabled;b.disabled=true;return {button:b,disabled:was};});
 var status=root.querySelector(".home-status"); if(status) status.textContent=homeMessage;
 var timer; var id=request("tools/call",{name:name,arguments:args},function(err,r){
  clearTimeout(timer); if(generation!==homeGeneration)return; homeBusy=false;
  var d=r && (obj(r.structuredContent)||parseText(r.content));
  if(err || !r || r.isError || !d){
   homeMessage=clean(err && err.message,300) || clean(r && textOf(r.content),400) || "This action could not be completed. Try again or ask in chat.";
   homeDraw(); return;
  }
  homeMessage="";if(status)status.textContent="";buttons.forEach(function(b){b.button.disabled=b.disabled;});done(d);queueSize();
 });
 timer=setTimeout(function(){
  delete pending[String(id)]; if(generation!==homeGeneration)return; homeBusy=false;
  homeMessage="The host has not returned a result. Retry with the same details to safely reuse this request, or check in chat.";
  homeDraw(); queueSize();
 },30000);
}
function ownerLink(parent,label,raw) {
 if(!ISSUER || typeof raw!=="string")return;
 var u;try{u=new URL(raw);}catch(e){return;}
 if(u.origin!==ISSUER || u.username || u.password || u.hash || u.search || ["/create","/grant","/settings","/deposit","/agent","/connect/apps"].indexOf(u.pathname)<0)return;
 var a=put(parent,"a","cta",label);a.href=u.href;a.target="_blank";a.rel="noopener noreferrer";
 a.addEventListener("click",function(e){if(openViaHost(u.href,a))e.preventDefault();});
}
function inHomePanel(fn){ var old=root;root=homePanel;try{fn();}finally{root=old;} }
function homeRefresh(){homeCall("get_merryman_setup",homeArgs(),function(d){setup=d;homeTab="Overview";homeDraw();});}
function onHostReady(){if(setup)homeDraw();}
function render(d){
 if(!obj(d.connection) || !Array.isArray(d.next_steps) || !obj(d.runtime))return false;
 setup=d;homeGeneration++;homeBusy=false;homeMessage="";homeDraw();return true;
}
function homeDraw(){
 clear(root);root.className="mm-home";
 var brand=put(root,"div","home-brand");put(brand,"span","home-mark","m");put(brand,"span","home-wordmark","merrymen");brand.appendChild(chip("HOSTED", "ok"));
 var hero=put(root,"header","home-hero");put(hero,"div","home-kicker",setup.agent?"YOUR MERRYMAN":"MAKE IT YOURS");
 put(hero,"h1",null,setup.agent ? clean(setup.agent.name,40)||"Your Merryman" : "Meet your next Merryman.");
 hero.appendChild(chip(human(setup.phase),setup.phase==="live"?"live":setup.phase==="paper"?"paper":"info"));
 put(hero,"p",null,clean(setup.summary,600));
 if(!obj(hostCaps.serverTools))put(hero,"p","small","Your host can display this home. Ask in chat to use its tools, or continue through the owner links.");
 var nav=put(root,"nav","home-tabs");nav.setAttribute("aria-label","Merryman sections");nav.setAttribute("role","tablist");
 var tabs=["Overview"];
 if(canHome("get_portfolio"))tabs.push("Portfolio");
 if(canHome("get_trades")||canHome("list_decisions"))tabs.push("Activity");
 if(setup.agent)tabs.push("Settings");
 if(canHome("list_subscriptions"))tabs.push("Alerts");
 if(tabs.indexOf(homeTab)<0)homeTab="Overview";
 tabs.forEach(function(label){var b=homeButton(nav,label,function(){homeTab=label;homeMessage="";homeDraw();homeLoadTab();});b.setAttribute("role","tab");b.setAttribute("aria-selected",String(label===homeTab));});
 var status=put(root,"p","home-status",homeMessage);status.setAttribute("role","status");
 homePanel=put(root,"div","home-panel");homePanel.setAttribute("role","tabpanel");homePanel.setAttribute("aria-label",homeTab);
 if(homeTab==="Overview")homeOverview();
 else if(homeTab==="Settings")homeSettings();
 else if(homeTab==="Alerts")homeAlerts();
 else put(homePanel,"p","home-empty","Use Refresh to load the latest "+homeTab.toLowerCase()+".");
 var actions=put(root,"div","home-actions");
 homeButton(actions,"Refresh",function(){if(homeTab==="Overview" || homeTab==="Settings")homeRefresh();else homeLoadTab();}).disabled=homeBusy||!initialized||!obj(hostCaps.serverTools);
 var links=obj(setup.links)||{};ownerLink(actions,"Wallet & permissions ↗",links.wallet);ownerLink(actions,"Connected apps ↗",links.connected_apps);
 put(root,"footer","home-footer",clean(setup.runtime.explanation,650));queueSize();
}
function homeOverview(){
 var a=obj(setup.agent);var links=obj(setup.links)||{};
 if(a){
  var metrics=put(homePanel,"div","home-metrics");
  [["LAST REPORTED MODE",a.mode==="live"?"Live · real funds":a.mode==="paper"?"Paper · simulated":human(a.mode)||"Not reporting"],["WORKER",a.worker_fresh===true?"Fresh report":a.worker_fresh===false?"Awaiting fresh report":"Not known"],["STRATEGY",human(a.strategy)||"Not selected"]].forEach(function(v){var m=put(metrics,"div","home-metric");put(m,"span","home-kicker",v[0]);put(m,"strong",null,v[1]);});
  var wallet=section(homePanel,"Wallet & permission");var g=grid(wallet);row(g,"Smart account",shortAddr(a.account));row(g,"Permission expires",when(a.permission_expires_at));row(g,"Worker reported",when(a.heartbeat_at));
 }
 if(canHome("create_merryman"))homeConfig(homePanel,true);
 var steps=arr(setup.next_steps,12).filter(function(s){return obj(s) && s.action!=="propose_settings";});
 if(steps.length){var s=section(homePanel,a?"Next steps":"Your setup, step by step");steps.forEach(function(x,i){var r=put(s,"div","home-step");put(r,"span","home-number",String(i+1));var text=put(r,"div");put(text,"strong",null,clean(x.label,100));put(text,"p",null,clean(x.detail,500));if(x.url)ownerLink(text,x.owner_action_required?"Continue in Merrymen ↗":"Open Merrymen ↗",x.url);});}
 if(setup.phase==="select_agent" && canHome("list_agents"))homeToolButton(homePanel,"Choose a shared Merryman","list_agents",{},homeAgentList);
 if(!a && !canHome("create_merryman"))ownerLink(homePanel,"Connect or share a Merryman ↗",links.connected_apps);
 var more=section(homePanel,"Keep exploring in chat");put(more,"p","small muted","Ask about token research, trade proposals, reports or community. Your assistant only offers features this connection allows; each trade proposal still needs your approval.");
}
function homeAgentList(d){
 clear(homePanel);put(homePanel,"h2",null,"Choose your Merryman");
 arr(d.agents,30).forEach(function(a){if(!obj(a))return;homeToolButton(homePanel,clean(a.name,40)||clean(a.agent,40)||"Merryman","get_merryman_setup",{agent:a.agent},function(s){setup=s;homeDraw();});});
}
function homeConfig(parent,creating){
 var draftContext=(creating?"create_merryman":"create_agent_draft")+":"+(setup.agent?setup.agent.id:"new");
 if(homeDraft && homeDraft.context!==draftContext)homeDraft=null;
 var form=put(parent,"form","home-form");var split=put(form,"div","home-split");var fields=section(split,creating?"Give it a name and a direction":"Prepare a settings change");
 var nameLabel=put(fields,"label","home-field","Name");var name=put(nameLabel,"input");name.name="name";name.setAttribute("aria-label","Name");name.maxLength=24;name.required=true;name.value=homeDraft?homeDraft.name:(creating?"My Merryman":clean(setup.agent.name,24)||"My Merryman");name.autocomplete="off";
 var strategyLabel=put(fields,"label","home-field","Strategy");var strategy=put(strategyLabel,"select");strategy.name="strategy";strategy.setAttribute("aria-label","Strategy");
 STRATEGIES.forEach(function(v){var o=put(strategy,"option",null,v[1]);o.value=v[0];});strategy.value=homeDraft?homeDraft.strategy:(creating?"trencher":setup.agent.strategy||"trencher");
 var note=put(fields,"p","home-strategy-note");function strategyNote(){var s=STRATEGIES.find(function(v){return v[0]===strategy.value;});note.textContent=s?s[2]:"";}strategyNote();strategy.addEventListener("change",strategyNote);
 var riskLabel=put(fields,"label","home-field","Risk settings");var risk=put(riskLabel,"select");risk.name="risk_level";risk.setAttribute("aria-label","Risk settings");
 (creating?[["careful","Careful"],["balanced","Balanced"],["bold","Bold"]]:[["","Keep current risk settings"],["careful","Careful"],["balanced","Balanced"],["bold","Bold"]]).forEach(function(v){var o=put(risk,"option",null,v[1]);o.value=v[0];});risk.value=homeDraft?homeDraft.risk_level||"":creating?"careful":"";
 var why=section(split,"You stay in control");put(why,"p",null,creating?"Start with the name, strategy and risk settings you want. Review the exact setup before your wallet is created and trading permission is signed.":"Review the exact before-and-after settings in Merrymen. Approval can change your running agent immediately.");
 put(why,"p","small muted","Practice uses simulated funds. Live mode, funding and signed trading limits stay under your control.");
 var submit=put(why,"button","primary",creating?"Review my Merryman →":"Review settings change →");submit.type="submit";submit.disabled=homeBusy||!initialized||!obj(hostCaps.serverTools);
 put(why,"p","small muted","Runs on Merrymen's hosted worker. You can close the chat after activation.");
 form.addEventListener("submit",function(e){e.preventDefault();if(!form.reportValidity())return;
  var payload={name:name.value.trim(),strategy:strategy.value};if(risk.value)payload.risk_level=risk.value;
  var fingerprint=draftContext+":"+JSON.stringify(payload);if(!homeDraft||homeDraft.fingerprint!==fingerprint){homeDraft=Object.assign({},payload,{context:draftContext,fingerprint:fingerprint,idempotency_key:"home_"+crypto.randomUUID()});}
  homeCall(creating?"create_merryman":"create_agent_draft",Object.assign({},payload,{idempotency_key:homeDraft.idempotency_key}),function(d){homeDraw();clear(homePanel);inHomePanel(function(){renderProposalResult(d);});homeToolButton(homePanel,"Check activation","get_merryman_setup",homeArgs(),function(s){setup=s;homeDraft=null;homeDraw();});});
 });
}
function homeSettings(){
 if(canHome("create_agent_draft"))homeConfig(homePanel,false);
 var s=section(homePanel,"Running controls");
 arr(setup.controls,12).forEach(function(c){if(!obj(c))return;var r=put(s,"div","home-step");var t=put(r,"div");put(t,"strong",null,human(c.control));put(t,"p",null,clean(c.effect,500));put(t,"p","small muted",clean(c.where,200));});
 var links=obj(setup.links)||{};ownerLink(s,"Open settings ↗",links.settings);ownerLink(s,"Review funding ↗",links.funding);
 if(canHome("get_agent_controls"))homeToolButton(s,"View signed limits & risk","get_agent_controls",homeArgs(),function(d){
  var box=section(homePanel,"Current limits");var g=grid(box);var limits=obj(d.signed_limits)||{};row(g,"Per trade",money(limits.per_trade_usdg));row(g,"Per day",money(limits.per_day_usdg));row(g,"Drawdown",limits.max_drawdown_pct===null?null:fmt(limits.max_drawdown_pct,2)+"%");row(g,"Expiry",when(limits.expires_at));
 });
}
function homeLoadTab(){
 if(homeTab==="Portfolio")homeCall("get_portfolio",homeArgs(),function(d){homeDraw();clear(homePanel);inHomePanel(function(){renderPortfolioResult(d);});});
 else if(homeTab==="Activity"){
  var tool=canHome("get_trades")?"get_trades":"list_decisions";
  homeCall(tool,Object.assign({},homeArgs(),{limit:20}),function(d){homeDraw();clear(homePanel);homeActivity(d,tool);});
 }else if(homeTab==="Alerts")homeCall("list_subscriptions",{},function(d){homeDraw();homeSubscriptions(d);});
}
function homeActivity(d,tool){
 var actions=put(homePanel,"div","home-actions");
 [["Trades","get_trades"],["Decisions","list_decisions"]].forEach(function(v){if(canHome(v[1]))homeToolButton(actions,v[0],v[1],Object.assign({},homeArgs(),{limit:20}),function(r){homeDraw();clear(homePanel);homeActivity(r,v[1]);});});
 var items=arr(tool==="get_trades"?d.trades:d.decisions,20);
 if(!items.length)put(homePanel,"p","home-empty","No recent "+(tool==="get_trades"?"trades":"decisions")+" in this result.");
 items.forEach(function(t){if(!obj(t))return;var r=put(homePanel,"article","home-activity");put(r,"strong",null,[human(t.side||t.action),human(t.status||(obj(t.outcome)&&t.outcome.category)),].filter(Boolean).join(" · ")||"Recorded activity");if(t.symbol||t.token)r.appendChild(utInline(t.symbol||t.token,false));if(t.book)r.appendChild(chip(t.book==="paper"?"Paper · simulated":t.book==="live"?"Live · real funds":human(t.book),t.book));put(r,"p",null,when(t.time||t.at||t.created_at));if(t.stored_explanation)untrustedBox(r,"Stored explanation",t.stored_explanation);});
 put(homePanel,"p","small muted",clean(d.note||d.figures_note,700));if(d.next_cursor)put(homePanel,"p","small muted","Showing the most recent 20. Ask in chat for more history or a filtered view.");
}
function homeAlerts(){
 var s=section(homePanel,"Telegram alerts");put(s,"p","small muted","Alerts go to your linked Telegram bot. Delivery follows your notification settings.");
 homeToolButton(s,"Check alert channel","list_notification_channels",{},function(d){var c=arr(d.channels,3)[0];if(!obj(c))return;var r=section(homePanel,"Channel status");r.appendChild(chip(c.ready===true?"Ready":"Needs attention",c.ready===true?"ok":"warn"));put(r,"p",null,clean(c.how_to_fix,500)||(c.ready===true?"Telegram is linked and alerts are enabled.":"Alert readiness is unknown. Check your Telegram settings before relying on delivery."));warnings(r,d.warnings);});
 if(canHome("subscribe")){
  var label=put(s,"label","home-field","Add an alert");var select=put(label,"select");select.setAttribute("aria-label","Add an alert");
  [["trade_confirmed","Live trades confirmed"],["risk_halt","Risk halt"],["provider_failure","Provider failure"],["stale_data","Worker stops reporting"]].forEach(function(v){var o=put(select,"option",null,v[1]);o.value=v[0];});
  homeToolButton(s,"Add Telegram alert","subscribe",function(){return Object.assign({},homeArgs(),{kind:select.value,params:{}});},function(d){homeMessage=d.created?"Alert added.":"This alert is already active.";homeDraw();warnings(homePanel,d.warnings);});
 }
 ownerLink(s,"Telegram settings ↗",(obj(setup.links)||{}).settings);
}
function homeSubscriptions(d){
 var s=section(homePanel,"Active alerts");var items=arr(d.subscriptions,60);
 if(!items.length)put(s,"p","muted","No active alerts are shared with this connection.");
 items.forEach(function(v){if(!obj(v))return;var r=put(s,"div","home-step");var t=put(r,"div");put(t,"strong",null,clean(v.description,300));put(t,"p",null,v.last_delivery?"Latest delivery: "+human(v.last_delivery.status):"No delivery yet");
  if(canHome("unsubscribe"))homeToolButton(t,"Remove alert","unsubscribe",{subscription_id:v.subscription_id},function(){homeMessage="Alert removed.";homeDraw();});
 });
 if(d.not_shown)put(s,"p","small muted","Some alerts belong to agents not shared with this connection.");
}
`;
