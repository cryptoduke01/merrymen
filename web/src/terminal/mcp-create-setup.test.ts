import assert from "node:assert/strict";
import { it } from "node:test";
import { RISK_PROFILES } from "@merrymen/core";
import { approvedMcpSetup, mcpSetupRequest } from "./mcp-create-setup";
import { headline, walletSetupUrl, type View } from "../app/connect/approve/[id]/approve-view";

const id=`prp_${"a".repeat(32)}`;
const owner=`0x${"b".repeat(40)}`;
const now=1_800_000_000_000;
function view():View {
  return {id,kind:"agent_draft",status:"applied",binding:{purpose:"create",tenant:owner,settings:{agentName:"Robin",strategy:"steady-basket",basketSymbols:["TSLA"],...RISK_PROFILES.careful.settings},risk_level:"careful",expires_at:now/1000+3600},binding_hash:"hash",summary:{},requested_by:"Claude",created_at:now/1000,expires_at:now/1000+3600,decided_at:now/1000,result:{setup_only:true,setup_url:"https://evil.example/steal"},fresh_quote:null,settings_check:null};
}
function setupView():View {
  const v=view();
  delete (v.binding.settings as Record<string,unknown>).maxImpactBps;
  return v;
}

it("accepts only one opaque setup ID from the URL",()=>{
  assert.deepEqual(mcpSetupRequest("?name=forged&strategy=live"),{id:null,invalid:false});
  assert.deepEqual(mcpSetupRequest(`?proposal=${id}&live=true`),{id,invalid:false});
  for(const search of [`?proposal=${id}&proposal=${id}`,"?proposal=", "?proposal=https://evil.example"]){
    assert.deepEqual(mcpSetupRequest(search),{id:null,invalid:true});
  }
});
it("hydrates only reviewed, owner-bound setup fields and preset risk settings",()=>{
  const setup=approvedMcpSetup(setupView(),id,owner.toUpperCase().replace("0X","0x"),now);
  assert.equal(setup.name,"Robin");assert.equal(setup.strategy,"steady-basket");
  assert.deepEqual(setup.basket,["TSLA"]);assert.equal(setup.riskLevel,"careful");
  assert.equal(setup.riskSettings.slippageBps,RISK_PROFILES.careful.settings.slippageBps);
  assert.equal("maxImpactBps" in setup.riskSettings,false);
});
it("rejects unapproved, foreign, expired and non-creation drafts",()=>{
  for(const mutate of [
    (v:View)=>{v.status="awaiting_approval";},
    (v:View)=>{v.kind="settings";},
    (v:View)=>{delete v.binding.purpose;},
    (v:View)=>{v.binding.tenant=`0x${"c".repeat(40)}`;},
    (v:View)=>{v.result={};},
    (v:View)=>{v.expires_at=now/1000;v.binding.expires_at=v.expires_at;},
    (v:View)=>{v.binding.expires_at=now/1000+7200;},
    (v:View)=>{v.id=`prp_${"d".repeat(32)}`;},
  ]){const v=setupView();mutate(v);assert.throws(()=>approvedMcpSetup(v,id,owner,now),/not approved/);}
});
it("rejects injected settings, altered presets and unknown strategies",()=>{
  for(const patch of [{liveTradingEnabled:true},{maxImpactBps:9999},{slippageBps:9999},{strategy:"made-up"},{agentName:""},{basketSymbols:["bad symbol"]}]){
    const v=setupView();Object.assign(v.binding.settings as object,patch);
    assert.throws(()=>approvedMcpSetup(v,id,owner,now),/not approved/);
  }
});
it("owner continuation is local and says wallet setup still remains",()=>{
  const v=setupView();assert.equal(headline(v),"Ready for wallet setup");
  assert.equal(walletSetupUrl(v,now),`/create?proposal=${id}`);
  assert.equal(walletSetupUrl(v,now+3600_000),null);
  v.binding.purpose="update";assert.equal(walletSetupUrl(v,now),null);
});
