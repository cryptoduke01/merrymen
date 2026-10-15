"use client";

import { useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon";

const SETUP_PROMPT = "Set up my Merryman. Check my setup first, guide me through approvals in Merrymen, then confirm whether it is running. Keep practice and live separate.";

/** The text stays visible and selectable when clipboard access is unavailable. */
function CopyField({ label, value, action }: { label: string; value: string; action: string }) {
  const labelId = useId();
  const valueRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "manual">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      const element = valueRef.current;
      if (element) {
        element.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopied("manual");
    }
  }

  return (
    <div className="grok-copy-field">
      <span id={labelId} className="grok-field-label">{label}</span>
      <div className="grok-copy-row">
        <code ref={valueRef} tabIndex={0} aria-labelledby={labelId}>{value}</code>
        <button className="btn btn-ghost" type="button" aria-label={action} onClick={() => void copy()}>
          {copied === "copied" ? <><Icon name="check" size={15} /> Copied</> : action}
        </button>
      </div>
      <span className="grok-copy-status" role="status" aria-live="polite">
        {copied === "copied" ? `${label} copied.` : copied === "manual" ? "Automatic copy is unavailable. The text is selected; copy it or select it manually." : ""}
      </span>
    </div>
  );
}

export function GrokQuickStart({ server }: { server: string }) {
  return (
    <section className="grok-quick-start" aria-labelledby="grok-quick-title">
      <header className="grok-quick-brand">
        <img src="/favicon.svg?v=2" alt="" width={56} height={56} />
        <div>
          <h2 id="grok-quick-title">Merrymen + Grok</h2>
          <p>One-time connection. No API key.</p>
        </div>
      </header>
      <ol className="grok-quick-steps">
        <li>
          <h3>Copy the connection details</h3>
          <CopyField label="Name" value="Merrymen" action="Copy name" />
          <CopyField label="Server URL" value={server} action="Copy address" />
        </li>
        <li>
          <h3>Add your custom connector</h3>
          <p>In Grok, go to <strong>Plugins → Connectors → New Connector → Custom</strong>.
            Enter the name and address above, then choose <strong>Add Connector</strong>.</p>
          <a className="btn btn-primary has-box" href="https://grok.com/connectors" target="_blank" rel="noopener noreferrer">
            Open Grok connectors <span className="box"><Icon name="arrow" size={16} /></span>
            <span className="grok-sr-only"> (opens in a new tab)</span>
          </a>
          <p className="grok-quick-note">This opens Grok’s settings. You add Merrymen there; asking chat to find it does not install it.</p>
        </li>
        <li>
          <h3>Sign in, then return to Grok</h3>
          <p>Sign in to Merrymen or create your account. To create a Merryman from chat, allow
            <strong> Prepare agent setups and suggest setting changes</strong>. Then paste this in Grok to open the setup card:</p>
          <CopyField label="First message" value={SETUP_PROMPT} action="Copy setup prompt" />
          <p className="grok-quick-note">Review setup and wallet approvals yourself in Merrymen. Grok can check what remains afterwards.</p>
        </li>
      </ol>
    </section>
  );
}
