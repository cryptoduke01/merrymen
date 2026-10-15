"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { CreateAgent } from "@/terminal/screens/CreateAgent";
import { fetchAccountForSession } from "@/terminal/account-session";
import type { AccountState } from "@/terminal/HostedControls";
import { BrandLockup } from "../../BrandLockup";

const STATUS_PROMPT = "Check my Merryman's setup and current worker status, then show me what I can manage here.";

/** The small owner-only signing handoff. All authority stays in CreateAgent. */
export function SetupClient({ id }: { id: string }) {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState(false);
  const [finishedFor, setFinishedFor] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const readVersion = useRef(0);
  const owner = account?.session.address?.toLowerCase() ?? null;

  const refresh = useCallback(async () => {
    const version = ++readVersion.current;
    setReading(true);
    const result = await fetchAccountForSession(null);
    if (version !== readVersion.current) return;
    if (result.kind === "ready") {
      setAccount(result.account);
      setFailed(false);
    } else {
      // Do not keep an old tenant's setup visible after an unverified read.
      setAccount(null);
      setFinishedFor(null);
      setFailed(true);
    }
    setReading(false);
  }, []);

  useEffect(() => { void refresh(); return () => { readVersion.current++; }; }, [refresh]);
  const signedIn = () => {
    setAccount(null);
    setFinishedFor(null);
    void refresh();
  };

  return <div className="terminal-host partner-connect mcp-wallet-setup">
    <header className="connect-header">
      <BrandLockup />
      <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> Secure wallet setup</span>
    </header>
    <main className="mcp-setup-main">
      <section className="connect-panel connect-panel-setup" aria-label="Finish your assistant setup" aria-busy={reading}>
        {finishedFor && finishedFor === owner ? <>
          <div className="connect-success-icon"><Check size={25} aria-hidden /></div>
          <h1>Back to your chat.</h1>
          <p>Return to the same conversation with your assistant and refresh Merryman. Your assistant can check activation, show your portfolio and help manage your agent.</p>
          <p>A saved permission does not confirm a running worker. Ask for its latest status before relying on trading.</p>
          <button className="flow-primary" onClick={() => {
            void navigator.clipboard?.writeText(STATUS_PROMPT).then(() => setCopied(true)).catch(() => setCopied(false));
          }}>{copied ? "Copied" : "Copy a status-check message"}</button>
          <p className="mcp-setup-prompt">{STATUS_PROMPT}</p>
          <p>If your assistant cannot see your agent, reconnect it and choose the agent and access to share. Setup does not widen an existing connection.</p>
          <a href="/connect/apps">Connected apps</a>
          <p>You can close this tab. Merrymen runs the hosted worker; your chat does not need to stay open.</p>
        </> : <CreateAgent
          key={`${id}:${account?.session.hosted}:${owner ?? "signed-out"}`}
          assistantProposalId={id}
          account={account}
          accountFailed={failed}
          retrying={reading}
          onRefresh={() => void refresh()}
          onSignedIn={signedIn}
          onBack={() => window.location.assign(`/connect/approve/${id}`)}
          onDone={() => setFinishedFor(owner)}
          onFund={() => window.location.assign("/deposit")}
        />}
      </section>
      <p className="mcp-setup-note">Your name and strategy come from the setup you approved. Sign-in and wallet confirmation happen here; everyday management stays in your chat.</p>
    </main>
    <footer className="connect-footer">Only your wallet can authorize trading. Manage assistant access at <a href="/connect/apps">Connected apps</a>.</footer>
  </div>;
}
