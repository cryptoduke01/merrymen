import type { Metadata } from "next";
import { Icon } from "@/components/Icon";

const title = "Set up Merrymen in Grok and Grok Bot";
const description =
  "Connect Grok or Grok Bot to Merrymen, create your Merryman, approve its wallet permissions yourself and check whether it is running. No model API key needed.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/grok" },
  openGraph: { title, description, url: "https://merrymen.dev/grok", siteName: "merrymen", type: "website" },
  twitter: { card: "summary", title, description, site: "@MerrymenAI", creator: "@MerrymenAI" },
};

const SERVER = "https://mcp.merrymen.dev/mcp";
const CONNECT_HUB = "https://app.merrymen.dev/connect/mcp";
const CONNECTED_APPS = "https://app.merrymen.dev/connect/apps";

export default function GrokSetup() {
  return (
    <div className="wrap" style={{ maxWidth: 760, padding: "40px 24px 80px" }}>
      <article className="doc-body">
        <h1>Your Merryman in Grok</h1>
        <p className="doc-lead">
          Ask Grok or Grok Bot to help set up your Merryman, check its trades and explain what it
          is doing. Connect your Merrymen account once, then work from the conversation.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
          <a href="https://grok.com/connectors" className="btn btn-primary btn-lg has-box" target="_blank" rel="noopener noreferrer">
            Open Grok connectors <span className="box"><Icon name="arrow" size={16} /></span>
          </a>
          <a href={`${CONNECT_HUB}#grok-bot`} className="btn btn-lg">Get the Grok Bot setup prompt</a>
        </div>
        <p>
          Merrymen connects through MCP, the same tool interface used by Claude and ChatGPT.
          You don&apos;t need an xAI API key or an extra model service to make the connection.
          You choose the agent and permissions Grok receives on Merrymen&apos;s consent page.
        </p>

        <h2 id="grok">Connect Grok</h2>
        <ol>
          <li>
            Open <a className="link" href="https://grok.com/connectors" target="_blank" rel="noopener noreferrer">Grok connectors</a>,
            choose <strong>New Connector</strong>, then <strong>Custom</strong>.
          </li>
          <li>Use this MCP server address:</li>
        </ol>
        <pre className="code" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{SERVER}</pre>
        <ol start={3}>
          <li>
            Complete authentication. Sign in to Merrymen, or create your account if you are new.
            Choose the Merryman to share and the permissions to allow. If you want Grok to draft
            a new Merryman, enable <strong>Prepare agent setups and suggest setting changes</strong>.
          </li>
          <li>Return to Grok and ask: “Help me set up my Merryman and check whether it is running.”</li>
        </ol>
        <p>
          These connector steps follow the <a className="link" href="https://docs.x.ai/grok/connectors" target="_blank" rel="noopener noreferrer">official Grok guide</a>.
          Business and Enterprise accounts may need an administrator to provision the connector.
          The <a className="link" href={`${CONNECT_HUB}#grok`}>Merrymen connection page</a> has a
          copy button for the address.
        </p>

        <h2 id="grok-bot">Connect Grok Bot</h2>
        <p>
          Start with the <a className="link" href={`${CONNECT_HUB}#grok-bot`}>copyable Grok Bot setup prompt</a>.
          It gives your Bot the server address, setup instructions and the checks to perform after
          you finish. You can also ask:
        </p>
        <pre className="code" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{
          "Help me connect Merrymen using https://merrymen.dev/llms.txt. Guide me through creating my Merryman and checking whether it is running. Send sign-in, setup and wallet approval links for me to open in my own device’s browser. Never sign in or approve wallet permissions on the Bot’s shared computer."
        }</pre>
        <p>
          The <a className="link" href="https://x.ai/bot/guides/grok-bot-101" target="_blank" rel="noopener noreferrer">Grok Bot guide</a> says
          it supports Cursor-compatible MCP servers, plugins and skills. The connection page supplies
          manual JSON configuration for hosts that accept a custom MCP server. If your Bot does not
          offer custom configuration, have it check its supported installation options and explain
          any missing step. Set up and verify the Bot connection separately from grok.com.
        </p>
        <p>
          Grok Bot&apos;s documented plugin route is <strong>Connect apps</strong> → choose a
          plugin → <strong>Authorize</strong> or <strong>Authenticate</strong>. A Merrymen catalog
          listing has not been confirmed. Installed plugins can be available to your other bots
          on the same account, so grant only the permissions you want that account to use.
          See <a className="link" href="https://cursor.com/help/grok-bot/connect-plugins" target="_blank" rel="noopener noreferrer">Grok Bot&apos;s plugin instructions</a>.
        </p>
        <p>
          <strong>Use your own device for sign-in and wallet approval.</strong> Grok Bot&apos;s cloud
          computer is shared with its bots. Open Merrymen links in your own browser and keep your
          wallet there. If the Bot cannot hand authentication to your own device, pause that setup
          and use Grok&apos;s connector flow. Never give a bot your recovery phrase, private key,
          sign-in code or wallet session.
        </p>

        <h2 id="setup">From an account to a running Merryman</h2>
        <ol>
          <li><strong>Connect your account.</strong> Sign in and choose what the assistant may access.</li>
          <li>
            <strong>Choose your Merryman.</strong> Share an existing one, or ask for a new setup
            draft with your name, strategy, basket and risk choice. A draft needs your review.
          </li>
          <li>
            <strong>Finish the secure handoff.</strong> Open the returned Merrymen link on your
            own device. Review the setup, create or connect the wallet, and approve the exact
            permissions and limits yourself. Complete any remaining activation steps shown there.
          </li>
          <li>
            <strong>Return to the same chat.</strong> Ask Grok to read setup and status again.
            It should name any remaining step and confirm the agent&apos;s actual running state,
            with paper and live kept separate.
          </li>
        </ol>
        <p>
          A connected assistant, a prepared draft and an approved draft are different steps.
          None alone proves that your Merryman is running. An agent may also be running and waiting
          because its strategy or limits do not permit a trade yet.
        </p>

        <h2 id="try">Try it</h2>
        <ul>
          <li>“What remains before my Merryman is running?”</li>
          <li>“Why hasn&apos;t my agent traded?”</li>
          <li>“Show my recent trades with their receipts. Keep paper and live separate.”</li>
          <li>“Explain my portfolio and the limits my agent must follow.”</li>
        </ul>

        <h2 id="permissions">You control the permissions</h2>
        <p>
          Grok receives only the agents and permissions you share. Trade and setting proposals
          need the corresponding permission and your approval in Merrymen. The connector cannot
          sign wallet transactions, reveal keys, turn on live trading or loosen signed limits.
          Disconnect it any time on <a className="link" href={CONNECTED_APPS}>Connected apps</a>.
        </p>
        <p>
          You can use the tools through ordinary text responses and approval links. Interactive
          Merrymen cards inside Grok are not required; their support has not been verified.
          This guide follows documented Grok connector and Bot capabilities. A live authenticated
          Grok or Grok Bot session has not yet been validated by Merrymen.
        </p>

        <h2 id="help">If setup stops</h2>
        <ul>
          <li>
            <strong>No agent is shared:</strong> connect using the same Merrymen account that
            owns it, and select that agent on the consent page.
          </li>
          <li>
            <strong>The setup tool is missing:</strong> reconnect and allow agent drafts and
            setting changes, or finish setup directly in Merrymen.
          </li>
          <li>
            <strong>The connector is present but cannot read status:</strong> finish authentication,
            then try the status check again. Adding the address alone does not grant access.
          </li>
          <li>
            <strong>The draft is approved but the agent is not running:</strong> open the latest
            setup link and finish the remaining owner steps. Ask Grok to recheck afterwards.
          </li>
        </ul>
        <p>
          See the <a className="link" href="/privacy">privacy policy</a> for data handling.
          For help, email <a className="link" href="mailto:support@merrymen.dev">support@merrymen.dev</a>
          {" "}with the step that failed, without keys, tokens or sign-in codes.
        </p>
        <div className="callout" style={{ marginTop: 40 }}>
          <strong>For AI assistants:</strong> read <a className="link" href="/llms.txt">merrymen.dev/llms.txt</a>
          {" "}for tool setup, owner handoffs and the checks that establish whether a Merryman is running.
        </div>
      </article>
    </div>
  );
}
