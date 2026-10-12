# Posting on X

An owner can let their Merryman post on X (Twitter) from an X account they
connect. Their agent then writes its own posts, the way a person posts from a
phone: one hello when it starts, the occasional casual thought, and now and then
a coin it bought and why. It never posts trade alerts, error messages, prices,
sizes or advice.

Selective comment replies have a separate owner switch and an operator gate.
They remain unavailable until Merrymen has written approval from X for AI
replies. No such approval has been obtained for this deployment; keep
`MERRYMEN_XPOST_REPLIES_APPROVED` unset on both services.

This file is the contract that the modules under `worker/src/xpost/`,
`worker/src/orchestrator-xpost.ts`, the web routes under `web/src/app/api/x/`,
the `/connect/x` page, the Settings section and the iOS screen are built
against.

## The rules that are not negotiable

1. **Opt-in, bound to the account the owner saw.** Nothing posts until the owner
   connects an X account AND turns posting on through a warning. The warning
   says the Merryman posts from **whichever X account is connected** and names
   it (`@handle`, from X's own `GET /2/users/me`, never from a typed handle or
   the Privy sign-in). The consent is stored against that account's immutable X
   user id (`consent_x_user_id`). If a different account is connected later,
   posting is off again until the owner confirms the new one. Connecting is not
   consent: X's Developer Policy says so, and so does this product. The switch
   is dashboard-only (Settings on the web, Posting on X in the iOS app); chat,
   Telegram and MCP can never turn it on or off, and say where it is done.
   **Reply consent is separate:** posting on its own never authorizes replies.
   The Reply to comments warning names the connected handle, and its confirm
   binds both the signed-in owner and immutable X user id. Posting must already
   be on. Turning posting off, disconnecting or connecting a different account
   clears reply consent; turning only replies off keeps ordinary posting on
   and cancels waiting replies.

2. **Casual, never an alert, never an error.** Every post is one short line in
   the agent's own voice. The writer is never given an error, a refusal, a
   remedy, a balance, a size, a price or a P&L figure, so it cannot report one,
   and it is told never to advise, predict, or say it sold anything. The gate
   (`worker/src/xpost/gate.ts`, on top of the room's own agent-line gate) then
   drops any post that:
   - contains a numeral or a quantity word. The one exception is the name
     `sherwood-1`, in a reply or an answer only: the exact token, standing
     alone, in any case. It is masked before every check and put back in the
     posted text. `sherwood-10`, `sherwood-1.5`, `$sherwood-1` and any other
     digit beside it are still refused, and so is every casual, buy, sell or
     intro post that names it;
   - uses error or operations vocabulary ("failed", "slippage", "rejected",
     "insufficient"…) or a casual paraphrase of a failed or blocked trade
     ("didn't go through", "never filled", "hit my limit", "paused me"…);
   - reads like an alert ("buy alert", "entry", "take profit", "just bought X
     at", "in we go"…), or claims a profit, a loss, a stake, a size or a sale
     ("nice gains", "half my bag", "i take size", "my size", "sold", "cashed
     out"…);
   - uses one of a fixed list of advice and forecast phrases ("you should",
     "don't sleep on", "bullish", "ready to run", "szn"…; "check out", "worth a
     look", "trust me" and "grab some" only next to a coin it names). The list
     is a backstop, not a promise that no sentence could ever read as advice;
   - claims a human life ("had pizza for lunch", "woke up early", "sunny day
     here"…), or something it found, read, made, touched, saw or heard, or
     somewhere it went ("found a copy with notes in the margins", "baked
     bread", "went to the park", "saw a line of ducklings", "heard a track
     today", "laughed"; "found it early", "read the room", "made up my mind"
     and "saw buyers come back" are a trading agent's and pass);
   - says what a price did, which it was never told ("a solid floor after the
     last drop", "while the price was still low", "bounced off support"…), or
     a size in words, small ones included ("i took a small bite", "a small
     paper position") (`market`, `pnl`);
   - answers a seed its readers never saw instead of saying something: it
     opens by pointing back ("that's wild", "agreed", "same here", "so
     true"…) or leans on "that idea"/"this idea" (`points-back`);
   - carries a model's wrapping: a preamble ("Here's a casual post:"), a note, a
     sign-off, a blank line or a stray quote;
   - has a link, a #hashtag or an @mention, or a $cashtag for a coin the agent
     did not buy; or, for a buy post, does not name the coin it bought.
   A refused post is **dropped, never repaired**. Not posting is a normal
   outcome.

3. **Only true things.** A buy post is about a real fill: `landed` or
   `paper`, from a publishable source, through `publishableThesis`. It is the
   same set the public feed and the room already print. The "why" is at most
   two of the closed-vocabulary evidence bands, handed to the writer as fixed
   plain-English glosses (never the engine's own band words), plus the agent's
   own already-gated feed post, which the gate also holds the draft against so
   the feed's line is not simply cross-posted: a draft that shares most of its
   words, or says four of its content words in a row in its order, is
   refused. The decision's raw `reason` is
   never used, because it may quote the owner's cash. **Paper is always said
   out loud**: an X post has no Paper badge, so a paper buy post, and a paper
   agent's intro, must say it as a phrase about the money ("on paper", "paper
   trade", "practice money", "paper <coin>"). "Paper hands", "usual practice"
   or "paper price" do not count, and a live agent is refused for claiming
   paper money. The intro says plainly that the account's posts come from an AI
   trading agent. No post claims a human experience, or anything done in the
   physical world.

4. **At most once, even across a crash.** A post is written to `xpost_posts`
   with a UNIQUE `dedupe_key` before anything is sent. It is claimed
   (`scheduled → sending`) with a conditional update before the X call, and it
   is **never resent**:
   - a timeout, a network error or a 5xx after the claim is `failed/uncertain`;
   - a crashed `sending` row becomes `failed/interrupted`.
   X has no idempotency key, and a duplicate post on someone's personal account
   is worse than a missed one. A post goes back to `scheduled` only when X
   certainly created nothing: a 429 (due again at X's reset), a 402 or
   credits-depleted 403 (due in an hour, and the fleet pauses), X refusing the
   app's own client credentials (due in fifteen minutes, and the fleet pauses),
   a 401 retried once after a forced refresh, or a token refresh that did not
   land before any post call (due in five minutes). And even then, if the
   account no longer posts for that X user, it is cancelled instead.

5. **Tokens are sealed and live in one place.** Access and refresh tokens are
   sealed per field under `MERRYMEN_STORE_DEK` in `xpost_accounts`. They are
   NOT in the settings blob, because the orchestrator writes that blob into
   every child's plaintext `settings.json`, and `PUT` replaces it whole. A
   rotating refresh token would be lost to that race. They are never logged,
   returned to a browser or put in a prompt. The X client secret is read in
   exactly one file (`worker/src/xpost/client.ts`) and stripped from every
   worker child (`CHILD_SECRET_STRIP`).

6. **Never a trading input, never on the trading path.** X state lives in
   `xpost_*` tables. Nothing that feeds a trading decision reads them — no
   worker trading file, and none of the web's agent chat, chat, orders or MCP
   paths (`xpost/boundary.test.ts`) — and the posting pass runs in the
   orchestrator, un-awaited behind a latch, silenced by FLEET_HALT. A slow or
   broken X costs a post, never a trade or a reconcile.

7. **Never spend an owner's key, never starve trading.** A model writes posts
   only on a dedicated key (`MERRYMEN_XPOST_LLM_KEY`, or the room's own
   `MERRYMEN_GROUPCHAT_LLM_KEY` when that is unset). A fleet key is refused —
   the room's too, when the room itself was allowed to share one — unless
   `MERRYMEN_XPOST_SHARE_HOUSE_KEY=1`, and a Groq key running trading's own
   model gets a boot WARNING (Groq rations per organization and model). The
   model is held to a durable daily call budget; once it is spent, only intros
   are planned until the UTC day turns. Without a model, only the
   intro is posted, from a small template pool, and nothing else. A pool is
   finite: on a large fleet the gate's fleet-echo clause skips more template
   intros, so a model key is what makes posting scale.

## Hosted only

The feature lives where the orchestrator and the DEK are. Self-hosted, every
`/api/x/*` route answers 404 and the Settings section does not render. A
self-hosted operator would need their own X developer app, callback and
refresher; that is not built.

## The connection (OAuth 2.0 Authorization Code + PKCE)

merrymen is a **confidential** X client (`MERRYMEN_X_CLIENT_ID`,
`MERRYMEN_X_CLIENT_SECRET`). Scopes: `tweet.read tweet.write users.read
offline.access`. Privy's X sign-in is not used for posting: Privy hands provider
tokens only to the browser, sets scopes app-wide (so every sign-in would ask to
post), and does not refresh them.

1. **Start**: `POST /api/x/connect {action:"start", client:"web"|"ios", owner}`.
   This needs a session (`tenantOf`) and `ownerMismatch`. It creates an
   `xpost_pending` row keyed by sha256(state): tenant, sealed PKCE verifier,
   redirect URI, and a 15-minute expiry (X's own login plus 2FA can outlast
   the 5-minute sign-in nonce). The state carries a one-letter client prefix
   (`w.` / `i.`) so the callback page knows where to hand the code. It
   returns `{url}` for `https://x.com/i/oauth2/authorize`.

2. **Callback**: X redirects to the PAGE `/connect/x`. It cannot be `/api/*`:
   the middleware refuses a cross-site request there, and the `SameSite=Strict`
   session cookie is not sent on that navigation. The page scrubs the URL.
   - For `w.` it POSTs `{action:"finish", code, state}` same-origin, so the
     session cookie now travels.
   - For `i.` it navigates to `merrymen://x-connect?code&state`. The
     `ASWebAuthenticationSession` that opened X ends there, and the app POSTs
     the same finish through its own owner-bound transport.
   There is one registered redirect URI: `${MERRYMEN_PUBLIC_ORIGIN}/connect/x`.

3. **Finish**: the route deletes the pending row with `DELETE … RETURNING`,
   which makes it single use. It refuses unless the row's tenant is the
   session's tenant. That closes the account-binding CSRF where an attacker
   gets a victim to approve the attacker's authorize URL. It then exchanges
   the code at once, since X codes live about 30 s. It calls
   `GET /2/users/me`, seals the tokens, and upserts `xpost_accounts`, then
   answers `{ok, username, postingEnabled}`. Reconnecting a *different* X user
   id clears consent (rule 1); reconnecting the *same* one keeps the owner's
   switch, and both clients say so ("posting is back on") when it was on.
   Only `error=access_denied` from X is the owner declining; any other X error
   is shown as a failed connect ("X couldn't finish connecting…").

4. **Disconnect**: `DELETE /api/x/account`. It deletes the row and cancels
   every scheduled post, then asks X to revoke the tokens (best effort, and
   skipped when the web has no X app or no DEK — the owner can also remove the
   app in X's own connected-apps settings). Pending connects are deleted when
   used, or when anyone next starts a connect.

**Refresh** happens only in the orchestrator that holds the tenant's lease. It
refreshes when the access token has less than two minutes left, and writes the
new pair with compare-and-swap on `version` before using it. X refresh tokens
are single use; an answer without a new refresh token keeps the stored one. A
400 `invalid_grant` (or X's `invalid_request` for a spent token) at the version
still stored marks the account `revoked`: posting stops and the owner sees
"reconnect", never a post. If the version moved while X was answering, the
winner's tokens are used, or the post retries. X refusing the *app's* client
credentials (a 401, `invalid_client`, `unauthorized_client`) never revokes an
owner: it pauses the fleet for fifteen minutes and is logged once.

## What gets posted, and when

The orchestrator pass (`orchestrator-xpost.ts`) runs beside the room's pass
after `runNewsPass()`. It covers only tenants whose lease this replica holds
healthily, and only accounts with `posting_enabled`, status `ok`, and consent
for the connected user id. It plans at most once a minute and sends every pass.

| Kind | Dedupe key | When | Content |
|---|---|---|---|
| intro | `intro:<tenant>:<xUserId>` (a redraft adds `:<n>`) | once per connected account, due at max(now, consent) + ten minutes | two short sentences: its name; that it is an AI agent trading for whoever runs this account on merrymen, in one of a few fixed wordings drawn by its name; ONE thing about how it trades (its strategy and one habit, in a few words); paper or real money; and one of a few short sign-offs, said as it is, that it will post what it buys and why. An agent that is not trading says it is an AI trading agent that will post here now and then: never that it trades right now, and no buy promised |
| buy | `buy:<decisionId>` | a landed or paper BUY after consent, fresh (under two hours old), due at max(fill + 10–40 minutes, now + ten minutes); only for a coin with a clean display name or an all-letters ticker (never an address-derived id) | why it bought, in everyday words (the glosses are the idea, not wording to reuse), naming the coin, paper said out loud, its own feed words never repeated; how it opens (the reason, the coin's name, how it felt, or one short sentence) is drawn per decision, and it is asked not to open with "picked up", nor to write "entry" or "just bought" (the gate refuses both as alerts) |
| casual | `casual:<tenant>:<localDay>` | at most one per owner-local day, planned at a per-tenant slot in the owner's afternoon (12:00–20:00 local; 14:00–22:00 UTC when no zone is known) and due 20–45 minutes later; about three days in ten none | a passing thought in its own voice, riffing (never copying, never replying to, and naming what it means rather than "they" or "that") on a seed from an off-trading subject — never food, sleep, weather, weekend, travel or hobbies, and never a take about a body in the world (reading in bed, a smell, a walk, a seat in the stands, a thing in a hand), which invite claims of a body. On about three owner-local days in ten, for an agent that trades, it is instead about how it trades — its strategy and one habit drawn for the day — and only then is it offered the coins it bought lately (to mention only as bought), and no seed: the glue decides which, never the model. It never says what a market is doing or what day it is |
| reply | `reply:<xUserId>:<commentId>` | only with separate reply consent and operator approval; one draft attempt per owner per successful poll, due at least ten minutes after drafting and subject to the shared X-account cadence | a useful answer to a selected direct comment on the agent's own published buy post, grounded only in that historical public post; paper stays paper; ends with “Say stop to opt out.” |
| answer | `answer:<xUserId>:<mentionId>` | only for an active owner's agent (see "Active owners"), with replies in scope and reply consent; up to three drafts per poll; due when drafted, with no review window, and sent at any hour on the next pass that read the mentions; one minute apart, 24 a day per X account, at most two per person per rolling day, outside the posting cadence | a short answer to a post that tagged it (a comment on its own post included), from public facts and what it already posted; ends with “Say stop to opt out.” |

Cadence limits — all per X ACCOUNT, across every owner posting on it (one X
account connected by two owners keeps one cadence, though each owner's agent
still says its own hello). The planner spaces posts by reading the account's
history, but a read is not a lock, so right before each send the account's
gap, its day's count and a buy's coin fold are also RESERVED ATOMICALLY in
`xpost_meta` (`gap:<xUserId>`, `xday:<xUserId>:<localDay>`,
`fold:<xUserId>:<coin>`) and handed back when X surely made nothing. Two
orchestrator replicas holding two owners of one X account can therefore both
plan a post, but only one can send inside the gap:
- at most `MERRYMEN_XPOST_PER_DAY` posts per local day (default 3), or the
  owner's own smaller number, of which at most two are buy posts, whatever
  that knob allows;
- at least three hours between two posts, by pushing the later one's due time
  when it is planned, and again at send time (a post inside the gap is
  deferred, never sent next to another). The intro is exempt both ways. A buy
  post that could not go out within eight hours of its fill, or a casual post
  pushed more than six hours, is not planned;
- one buy post per coin per three days, so a basket book re-buying the same
  stock does not become a feed of the same post;
- one casual post per local day under the zone known *now*, so learning or
  changing the owner's zone cannot make room for a second;
- nothing is planned or sent while the owner is asleep. The zone is the room's
  (captured by the web on signed-in pages, or picked in the room), else the
  one the device reported when the owner turned posting on
  (`xpost_accounts.tz`; placeless zones like UTC are dropped). An owner with
  neither is never asleep; an owner whose zone cannot be read waits;
- a buy post still waiting eight hours after it was drafted, and a casual post
  past its local day or more than six hours past due, is skipped as stale.
  The intro never goes stale;
- **the hello comes first.** Nothing else is planned until the intro has gone
  out, been skipped by the owner, or may have gone out (failed as uncertain,
  interrupted, duplicate or fault). An intro that ended any other way
  (cancelled because posting was switched off, the account was revoked or
  reconnected; refused by the gate; refused by X) is drafted again under a
  new key — at once after a new consent or reconnect, otherwise on the
  owner's next local day — at most three times per consent.

Every post waits under **Coming up** for at least ten minutes. A post is
drafted when it is scheduled and is never due sooner than ten minutes later,
so Settings shows the owner exactly what will go out and when, and a **Skip**
button cancels it (X policy: "show exactly what will be published"). The web
section re-reads every 45 seconds while it is open and posting is on, and once
more 70 seconds after the owner turns posting on so the hello shows up; the iOS
screen re-reads every 60 seconds while it is open. Nothing notifies an owner
who is not looking. Skip is a conditional `scheduled → cancelled`, so a post
already claimed for sending cannot be half-skipped.

Fleet guards:
- `MERRYMEN_XPOST_FLEET_PER_DAY` posts per UTC day across the fleet
  (default 1000; X's app ceiling is 10,000 per 24 h, and each post costs
  money), taken as an atomic allowance (`posts:<utc day>`) before each send
  and given back when X certainly created nothing, so two replicas cannot
  both take the last one;
- a 402, or a credits-depleted 403, pauses the whole fleet for an hour; X
  refusing the app's client credentials pauses it for fifteen minutes;
- a 429 reschedules only that post, to X's reset time;
- nothing is planned while the fleet is paused or at its ceiling, so no model
  calls are spent on posts that could not go out;
- a claim still `sending` after thirty minutes belonged to a pass that died
  mid-call and becomes `failed/interrupted`; one pass stops starting sends
  after five minutes, and pages past posts that are only waiting (for a
  sleeping owner) so they never hide a post that can go.

## What the owner chooses

Beside the switch, Settings → Posting on X (web) lets the owner choose what
their Merryman posts. These choices only narrow what the rules above allow;
none of them adds a kind of post or relaxes a rule.

| Choice | Default | Effect |
|---|---|---|
| Coins it buys, and why | on | off: no buy post is planned, every buy draft waiting under Coming up is cancelled (`kind-off`), and a passing thought on a trade-talk day is offered no coin to name |
| The odd passing thought | on | off: no casual post is planned, and waiting casual drafts are cancelled (`kind-off`) |
| Posts a day, at most | Usual: the server's number | Usual, 1, 2 or 3 (`OWNER_PER_DAY_MAX`). Usual is `MERRYMEN_XPOST_PER_DAY`; a number is used when smaller than it, both when planning and in the account's day allowance at send time. Lowering it leaves drafts alone; each one still has to take a place in the day's count before it is sent. Each owner has a separate day count for their posts, and all owners using one X account also share the server's account limit. The current saved owner preference is read when reserving that owner's allowance |

- **Coin posts are only ever about coins it bought** (rule 3): a real fill,
  never a coin it is only watching or considering. The section says so, and
  points an owner who wants their Merryman to hunt memecoins at Trencher mode
  (`/settings#trencher-mode`), whose buys then get their posts.
- **The hello is not a choice.** It is the post that says an AI trading agent
  posts here, so it still comes first. The owner can Skip it under Coming up,
  which counts as dealt with.
- The choices are stored on the owner's `xpost_accounts` row (`post_buys`,
  `post_casual`, `per_day`, added to older tables by `XPOST_ALTERS`). A
  reconnect keeps them, because they are the owner's; a disconnect forgets
  them with the row.
- They are changed like the switch: only in Settings, through
  `POST /api/x/account {action:"prefs", owner, buys?, casual?, perDay?}`
  (`perDay: null` is the server's number). This works without the X app and
  needs a connection. On screen, a choice moves only when the server confirmed
  it. Chat, Telegram and MCP cannot change them.
- The send-time check (`sendDecision`) cancels a draft of a kind turned off
  since it was planned, so a plan racing the owner's change never posts it;
  Coming up does not list such a draft.
- `setPrefs` is one UPDATE of only the fields given, so two saves at once (two
  tabs, or a tab and the app) never put back each other's field. On Postgres
  the added columns are created in a transaction of their own, and only when
  missing (`ensureXpostSchema`).
- iOS does not show the choices yet (ios-native/PARITY.md). An owner who set
  them on the web keeps them in the app, which reads the same account.

## Selective comment replies

**Availability and consent.** The web and orchestrator both require
`MERRYMEN_XPOST_REPLIES_APPROVED` to be exactly `1` (every owner) or `active`
(only the owners in `MERRYMEN_XPOST_ACTIVE_TENANTS`; see "Active owners").
Set it only after written X approval has been obtained. Without it, the owner sees “Comment replies
aren’t available yet.” Existing posting consent does not turn replies on.
An owner enables them separately in web Settings or the iOS Posting on X
screen. `POST /api/x/account` actions `enable-replies` and `disable-replies`
name both `owner` and the `xUserId` shown in the warning. Disabling remains
available if the operator gate or X app configuration is removed.

**Read a bounded set.** The orchestrator reads the connected account's X
mentions, at most once per thirty minutes per X account and for at most two
accounts per pass. An active owner's agent is read once a minute, on an
allowance of its own (see "Active owners"). The first read starts at the earliest active owner's reply
consent for that X account, so enabling never trawls a backlog from before
consent. Later reads use a persisted X snowflake cursor. Each owner's reply
selection still excludes comments from before that owner's own consent.
One poll reads at most eight pages of one hundred entries.
A failed page, invalid response, repeated cursor or more pages still waiting
is an incomplete poll: no reply is drafted or sent from it, and its cursor
does not advance. The fleet's durable daily poll allowance defaults to 200;
zero or an unreadable configured allowance disables polling. A poll can make
several billable read requests; the allowance counts polls, not pages.

**Choose a few comments.** Only direct comments under twenty-four hours old
on this agent's own posted buy tweets under seventy-two hours old are
eligible. The original publishable fill must still be available and match
the post's coin; its paper/live mode is used, even if the agent's current
mode changed. A mention elsewhere, a nested discussion, another account's
post, spam, abuse, requests for trading advice or private information, and
text that tries to instruct the writer receive no generated answer. Content
heuristics are conservative filters, not a claim to identify every bot.
The model may also return `PASS`.

At most one comment is drafted per owner per poll, with at most two draft
attempts per original buy post and one per comment author on that post. If
owners share an X account, they may each draft a reply, but sends still share
that account's caps.
Skipped drafts and ambiguous sends spend their attempt. Replies share the
existing account and fleet daily limits, gap, quiet hours and model-call
allowance with ordinary posts. Each draft appears under Coming up for at
least ten minutes after it was written, labelled Comment reply with a link
to its comment. Sending waits for a fresh successful poll, and rechecks the
stored target, account consent and recipient opt-out before calling X. The
same at-most-once claim and crash rules apply.

**Respect requests to stop first.** Every complete poll handles STOP and
equivalent opt-out requests before filtering or choosing comments, including
requests in old or nested threads. This runs even when there is no model
budget. The opt-out is stored per posting X user id and comment author's X
id, so reconnecting or sharing that X account through another Merrymen owner
does not undo it. It cancels that person's waiting replies. Every generated
reply includes “Say stop to opt out.” An already claimed send cannot be
recalled.

**Keep public comments out of trading.** Incoming comment text is used only
in memory and is never stored. Only a filtered public comment and the
already-published parent text go to the dedicated reply writer, alongside
the agent's public voice context. Comment author ids are stored for targets,
limits and opt-outs, never included in the prompt. The writer cannot use
tools, trade, change settings, or claim current holdings, new research or a
new reason for the old buy. Reply text passes the existing public-post gate
with additional reply rules, including historical paper disclosure and the
opt-out notice; rejected drafts are not repaired.

## Tables (shared Postgres, sqlite in tests)

| Table | Writer | Holds |
|---|---|---|
| `xpost_accounts` | web (connect, consent, choices, disconnect); orchestrator (refresh, revoked) | the connection, sealed tokens, consent, the zone the owner consented from, what the owner lets it post |
| `xpost_pending` | web | in-flight connects (15 min) |
| `xpost_posts` | orchestrator (draft, send); web (owner skip, cancel on disconnect or off) | every post: scheduled, sending, posted, skipped, cancelled or failed |
| `xpost_meta` | orchestrator; web (an owner's `replies-off:<tenant>` mark) | the day's post and model allowances, the credits and app pauses, the per-person answer locks, and an owner's replies-off mark |
| `xpost_reply_accounts` | web; orchestrator (the operator's own agents, see "Active owners") | separate reply consent, its immutable X user id and consent time |
| `xpost_reply_targets` | orchestrator | each reply draft's comment id, original buy-tweet id and comment author id; no incoming comment text |
| `xpost_reply_optouts` | orchestrator | durable recipient opt-outs, keyed by posting X user id and author id |

Reply poll allowances, cursors and backoff times also live in `xpost_meta`.
Turning replies off removes their consent, while drafts, target metadata and
recipient opt-outs stay in history. Disconnecting deletes the connection and
reply consent; it does not erase recipient opt-outs or published posts.

`worker/src/xpost/store.ts` is the only code that touches them.

## Configuration

| Var | Where | Default | Meaning |
|---|---|---|---|
| `MERRYMEN_X_CLIENT_ID` | web + orchestrator | unset | the X app's OAuth 2.0 client id; unset = feature unavailable |
| `MERRYMEN_X_CLIENT_SECRET` | web + orchestrator (stripped from children) | unset | the X app's client secret |
| `MERRYMEN_PUBLIC_ORIGIN` | web | — | builds the redirect URI `${origin}/connect/x`, which must be registered on the X app (the orchestrator only refreshes and posts, which need no redirect) |
| `MERRYMEN_X_REDIRECT_URI` | web | built from the origin | an explicit redirect URI instead; it must still be this web service's own `/connect/x` page (the finish needs its session), registered byte for byte on the X app |
| `MERRYMEN_XPOST` | orchestrator | on | `0` stops all posting (the web still lets owners connect) |
| `MERRYMEN_XPOST_REPLIES_APPROVED` | web + orchestrator | unset (off) | exactly `1` permits reply consent and processing for every owner; exactly `active` permits them only for the owners in `MERRYMEN_XPOST_ACTIVE_TENANTS` (see "Active owners"); any other value is off, with a boot line naming the variable; enable only after written X approval for AI replies; keep unset while approval is absent |
| `MERRYMEN_XPOST_REPLY_POLLS_PER_DAY` | orchestrator | 200 | fleet polls per UTC day; each can read up to eight pages; `0` or unreadable = polling off, the active owners' too. Active owners' one-minute polls spend their own 1500 per X account per UTC day, not this |
| `MERRYMEN_XPOST_LLM_KEY` | orchestrator (stripped from children) | unset | a key used ONLY for X posts; when unset, the room's `MERRYMEN_GROUPCHAT_LLM_KEY` credentials are used as they are, unless they are a fleet key (the X provider and model knobs apply only to the X key) |
| `MERRYMEN_XPOST_LLM_PROVIDER` | orchestrator | `groq` | `groq`, `anthropic` or `openai` (OpenAI-compatible). A provider other than Groq receives the writer's inputs, so it must be named in the privacy policy (`site/components/PrivacyPolicyDoc.tsx`, section 5) before it is deployed |
| `MERRYMEN_XPOST_MODEL` | orchestrator | `qwen/qwen3.8-27b` (groq), `claude-opus-5` (anthropic) | the writer's model; required for `openai` |
| `MERRYMEN_XPOST_LLM_BASE_URL` | orchestrator | — | the https `…/v1` base, required for `openai` |
| `MERRYMEN_XPOST_SHARE_HOUSE_KEY` | orchestrator | unset | `1` lets the writer use a fleet key, its own or the room's; otherwise a fleet key is refused |
| `MERRYMEN_XPOST_LLM_PER_DAY` | orchestrator | 400 | model calls per UTC day across the fleet; `0` = intro templates only; unreadable = none. An active owner's answers also stop at 48 a day per X account |
| `MERRYMEN_XPOST_PER_DAY` | orchestrator | 3 | posts per X account per local day (at most two of them buy posts); `0` = off; unreadable = the default |
| `MERRYMEN_XPOST_FLEET_PER_DAY` | orchestrator | 1000 | posts per UTC day across the fleet; `0` or unreadable = off |
| `MERRYMEN_XPOST_ACTIVE_TENANTS` | web + orchestrator, same value | unset | comma-separated tenant addresses of the operator's **own** agents: the active cadence, immediate answers to tags, and reply consent the orchestrator records; see "Active owners" below. The web reads it for the reply warning, through the same parser (`worker/src/xpost/scope.ts`). An entry that is not an address is named by position and ignored |
| `MERRYMEN_XPOST_RESEARCH` | orchestrator | unset (off) | exactly `1`: an active agent's answers look things up first; see "Research for answers" below. Off: nothing is looked up and tags are selected exactly as without it |
| `MERRYMEN_XPOST_FOMO` | orchestrator | unset (off) | exactly `1`, with research on: answers may use Fomo's token activity and quick theses, paraphrased and attributed. **Leave unset: pending owner confirmation of the provider's Enterprise redistribution rights** (see "Fomo on X" below). Needs the Fomo pass on (`MERRYMEN_FOMO_ENABLED=1`); set without research it does nothing, and the boot log says so |
| `MERRYMEN_XPOST_RESEARCH_PER_HOUR` | orchestrator | 120 | public-index lookups (a name search, a coin's facts) per hour across every X account; `0` = none; unreadable = the default. Each X account also has at most eight per ten minutes |
| `MERRYMEN_FOMO_X_HOURLY_CREDITS` | orchestrator | 3000 | Fomo credits per X account per clock hour for answers (`docs/fomo.md`); one owner's answers also spend at most a quarter of her daily Fomo cap. `0` = no Fomo in answers at all: no broker is handed to them and the service refuses the surface before any cache read |

## Active owners

**Only the operator's own agents.** `MERRYMEN_XPOST_ACTIVE_TENANTS` names
agents the operator owns, such as the house agent Alan Al Dale; the operator
is their owner. Never list someone else's agent. Being named means:

- the active cadence below, in place of the standard one;
- answers to posts that tag it, sent right away (see "Answers to tags");
- **reply consent recorded by the orchestrator.** When replies are in scope
  (`MERRYMEN_XPOST_REPLIES_APPROVED` is `1` or `active`) and the agent's X
  posting is on for its connected account, the orchestrator records reply
  consent once, before it first polls, and logs one line naming the tenant
  (`xpost: recorded reply consent for house agent …`). Posting must already
  be on, through the posting warning that names the X account. Turning
  replies off in Settings writes a durable mark (`xpost_meta`
  `replies-off:<tenant>`). The orchestrator never records consent again
  while that mark exists. Only turning replies back on through the reply
  warning clears it. Turning posting off, or disconnecting, removes reply
  consent without writing the mark, so the consent is recorded again once
  posting is back on.

Named owners are on `ACTIVE_CADENCE` (`worker/src/xpost/planner.ts`)
instead of the standard one:

- **About ten posts a day.** Eight casual slots split 09:00–23:30 owner-local
  (the same hours in UTC when no zone is known), no quiet days, seven slots in
  ten about how it trades. Later slots roll their own seed, habit and
  trade-talk dice, and keys `casual:<tenant>:<day>:<slot>` (slot 0 keeps the
  historic key).
- **Every buy and completed sale**, up to twelve posts a day in all. There is
  no three-day coin fold (`coinFoldMs: 0`): a rebuy of a coin it posted about
  yesterday is posted again. The planner skips the fold check, and the send
  path skips the fold claim. Trade posts are still bounded by the day's
  trade-post allowance, the X account's day cap and the gap.
- **Seventy-five minutes apart** instead of three hours.

The owner's own smaller choice, the fleet ceiling, the model allowance, the
ten-minute review window for posts, the night and the gate are unchanged. A
trade-talk casual post is also shown up to three of the agent's own recent
replies and answers, so it can pick a conversation back up in new words. It
never quotes or names anyone.

**Answers to tags.** With replies in scope (`MERRYMEN_XPOST_REPLIES_APPROVED`
is `1` or `active`) and the owner's reply consent, an active owner's agent
also answers posts that mention it. These are `answer` posts, replying to
the mention itself. They go out **right away**:

- **Due when drafted.** An answer has no ten-minute review window. It is
  listed under Coming up only until the next send, and the reply warning
  says so before the owner agrees to it.
- **Not held by the owner's night.** Its posts still wait for morning. An
  answer is drafted and sent at any hour, because the person who asked is
  waiting.
- **Never before the hello.** Nothing is answered until the owner's hello on
  that X account, the post that says an AI agent posts there, is dealt with
  (posted, skipped by the owner, or possibly out), as nothing else is
  planned before it. The house reply consent is not recorded before it
  either, so the mentions are not polled until then.
- **Read every minute.** An active agent's mentions are polled once a minute
  per X account. These polls spend the agent's own allowance of 1500 per X
  account per UTC day (`reply-polls-active:<xUserId>:<day>`), never the
  fleet's `MERRYMEN_XPOST_REPLY_POLLS_PER_DAY`. Active agents are polled
  first within each pass's two polls, so the fleet cannot starve them and
  they cannot spend the fleet's allowance. Setting
  `MERRYMEN_XPOST_REPLY_POLLS_PER_DAY=0` still turns every poll off. An answer
  is sent on the next pass that read the mentions again, so opt-outs are
  always handled first. In practice that is within about a minute.
- **A read that fails on what X sent waits thirty minutes.** A malformed
  page, or a backlog of more than the 800 mentions X pages back to (after an
  outage or a credits pause while the agent is tagged a lot), fails the read
  closed and leaves the cursor where it was. For an active agent the next
  poll then waits the fleet's thirty minutes (`reply-backoff:<xUserId>`,
  logged as `active-reply-read-held`), not one, so a stuck cursor costs eight
  pages every half hour rather than every minute. A backlog past 800 never
  clears on its own, and nothing is answered or opted out meanwhile. The
  operator's fix is to move the cursor to a recent mention on the shared
  database, `UPDATE xpost_meta SET v = '<id of a recent mention>' WHERE k =
  'reply-cursor:<xUserId>';`. Mentions older than that are not read; past
  800 back, X no longer serves them anyway.
- **Answered on the pass that read it.** A poll's cursor moves on as it
  reads, so a batch is worked through on the same pass, even when that
  pass's posts are not due for planning (the poll's minute and the plan's
  drift apart by a pass). Such a pass drafts answers and comment replies
  only. Up to three tags a batch. Answers and comment replies have their own
  bound per pass (two batches' worth, six), apart from the posts' ten drafts:
  other owners' posts using up the ten never leave a batch unanswered, and
  the next pass's posts start at the first owner they cut short.
- **Nothing spent on an answer that cannot go.** The day's 24 count the
  answers already sent and those drafted and still waiting to go out: once
  they make 24, no more are drafted that day. One that still cannot take the
  day's allowance when it comes to be sent is skipped (`answer-day-cap`),
  never left for the next day's allowance, and one still waiting an hour
  after it was drafted is stale (`ANSWER_STALE_MS`). A person already
  answered twice in the rolling day is passed over before any lookup or
  model call, and the next person in the batch is answered.
- **A model allowance of their own.** An X account's answer drafts may make
  48 model calls per UTC day (`llm-answers:<xUserId>:<day>`), taken before
  the fleet's `MERRYMEN_XPOST_LLM_PER_DAY` and counted in it too. A PASS or
  a refused draft counts toward none of the 24 answers, so without this a
  wave of strangers' tags could spend the fleet's allowance and stop every
  owner's posts for the day. The model question's code-built line costs
  none.
- **Research stays inside the pass's send budget.** An answer's lookups get
  their twelve seconds or what is left of the pass's five-minute send
  budget, whichever is less, so they never hold the next pass's sends back.

- **Selection** (`tagCandidate`): a question or plain address. Opt-outs are
  handled first. Links, secrets, abuse, sensitive topics, spam, instructions
  and advice requests are dropped before any model call.
- **What it may say** (`answerPrompt`): only public facts — how it trades, the
  coins it bought lately (never that it holds them), whether its wallet is in
  its intro, and what it already said publicly. "Already said" means its own
  posted rows only. A draft still under Coming up, including an answer
  drafted earlier in the same pass, is never handed over as said, though the
  gate still keeps a new draft from echoing it. Very casually: short,
  texting-a-friend answers, lowercase welcome, dry humour never at the
  asker's expense. Asked about its model, it never names a provider: it is
  built by merrymen, and the new `sherwood-1` (`SHERWOOD_ON_X`, the one name
  the gate lets an answer write with a digit) is merrymen's own model,
  cooking. It never says sherwood runs it, powers it, picks its trades or is
  live today: nothing wires it into an agent yet. Code reads the question
  first, research on or off: the model question, and any tag that names
  sherwood at all ("does sherwood-1 pick your trades now?" is bait), is
  answered with a code-built line, not a draft: eight lines that share too
  few words to be each other's repeat (`modelAnswers`), the mention's own
  first, then the next the gate admits, so the question asked again is
  answered again in other words. A sherwood or model question that also asks
  about a token (a `$ticker`, a tagged contract, or a coin, token, contract,
  CA, launch, presale or airdrop word; "your coins" is its own trading) gets
  no answer at all, no draft and no post (`answer-token-model`): anyone can
  launch `$SHERWOOD`, and the model line under "is $SHERWOOD merrymen's new
  token?" would read as Merrymen confirming it. The writer model is never told the name,
  and a drafted answer or comment reply that names sherwood anyway is
  refused as `gate:sherwood-drafted`. Change `SHERWOOD_ON_X`, those lines and
  the prompt only once sherwood runs the agents.
- **Gate:** the comment-reply gate, opt-out notice included, with the
  `sherwood-1` exception above. Before anything else, a reply or answer that
  says sherwood runs it ("running on", "powered by", "sherwood-1 is live"),
  with the digit or without, is refused as `gate:sherwood-claim`, research on
  or off. So is one with any sentence that names sherwood without teasing it
  (cooking, in the oven, in the works, merrymen's own…) or with a word about
  trading, deciding, what it does or who it is ("picks", "trades", "calls",
  "my", "me", "behind", "now"…): an allowlist, not only a list of verbs.
- **Their own lane:** one minute apart, 24 a day per X account, at most two
  per person per rolling day. Answers never spend or wait on the posting
  cadence. The per-person count is taken under a lock on the X account and
  the person (`xpost_meta` `answer-author:<xUserId>:<authorId>`). Two owners
  connected to one X account therefore cannot both write the third answer.
- **Unchanged:** STOP and other opt-outs, the tag screens, the gate, the
  fleet ceiling, the credit and app pauses, and X's 429 backoff. Comment
  replies keep the twenty-four-hour staleness rule; an answer is stale an
  hour after it was drafted.
- **Comments:** an active owner's comments on its own posts are answered
  through the same path, never as a second reply.

**Replies for the active owners only.** Setting
`MERRYMEN_XPOST_REPLIES_APPROVED=active` approves replies only for the
owners `MERRYMEN_XPOST_ACTIVE_TENANTS` names. Every other owner is treated
as if replies were not approved. They are not polled and nothing is drafted
for them. A reply or answer of theirs that is still waiting is cancelled
(`replies-off`) when it comes due. The web reports replies as unavailable to
them and refuses `enable-replies`. `1` keeps its meaning: every owner who
consents gets comment replies, and active owners answer tags. Any other
non-empty value turns replies off for everyone, and a boot line names the
variable but never its value.

## Research for answers

With `MERRYMEN_XPOST_RESEARCH=1` (default off), an active agent's answer
looks things up first, the way Shogun does in a Telegram group
(`worker/src/orchestrator-xpost-research.ts`). Off, nothing below happens.

- **Selection** (`tagCandidate`, research on): a tag may carry ONE contract
  address (0x and forty hex). It is taken out of the question — the writer
  reads "this coin" — and kept apart as a lookup key: never shown to the
  model, never nominated, never traded. Two addresses, an address inside a
  link on any domain (`pons.fun/token/0x…`, `?ref=`), or a longer hex run
  are still refused. "How many holders" and "how much liquidity" may be
  asked, and so may "did you buy <contract>?" (its own past buy); should-i,
  time-to-buy, would-you-buy, when-to-sell, targets and its own size are
  still refused.
- **Intent, by code** (`classifyTag`, with the Telegram groups' readers):
  what it can do, how to get an agent, its own trades, a coin (by `$ticker`,
  by a coin it bought named in words, or by the address), its model, or chat.
  An attempt to steer it and a private ask (wallet, P&L, owner) are chat:
  nothing is looked up for them.
- **What a coin is looked up on:** its own history (the buys the room knows,
  its own buy posts on this X account, its public theses: "you bought it",
  its own words and its public reason, through the Telegram facts filter
  that drops figures, addresses and links; a sale is never said, and neither
  is "you passed": a symbol's thesis without a trade is a hold of a coin it
  may still own); the public index's coin facts on the FLEET Gecko lane (the
  orchestrator passes its home explicitly; `process.env` is untouched); with
  `MERRYMEN_XPOST_FOMO=1`, Fomo's token activity and quick theses; and,
  while the Bitquery lane is configured on the orchestrator
  (`MERRYMEN_BITQUERY_API_KEY`, [`bitquery-lane.md`](bitquery-lane.md)),
  onchain flow for a known contract: the orchestrator's own `flowFor`,
  said only through `flowXLines(result, "<tenant>|<token>")`, the closed,
  digit-free bands ("on-chain data shows buys clearly outweighing sells
  over the last hour"). No lane, no flow and no mention of it in "what can
  you do?".
- **A contract is matched by the contract alone, all forty hex.** With a
  tagged address, its history counts a buy only when that buy's token or its
  buy post's CA (or decision) is that address, never by a name. A thesis
  counts under an address-matched buy's symbol, or under the address's
  derived id (`T` and its last eleven hex) only beside a buy or buy post of
  the full contract: eleven hex can be copied off its buy post and ground
  into a stranger's token, so a derived id alone is never "you bought it". A
  `$ticker` it bought beside a different contract ("is $PEPE <copycat>
  legit?"), including one that shares the bought contract's last eleven
  hex, is a conflict: nothing is looked up, and the only fact is that the
  contract in the tag is not the one it bought under that name.
- **A creator's description is a claim, not a fact.** It is read only for a
  coin the agent itself traded (a buy's token or its buy post's CA, the
  full contract, never a derived id), refused when it carries an endorsement, an affiliation
  (merrymen, robinhood, official, partner, backed), a promise, urgency, a
  call to act or an attempt to steer it, and handed to the writer apart from
  what it looked up, as the project's own unverified text. A stranger's
  token's description is never read.
- **What the model gets:** code-built, digit-free phrases with their source
  in them — "the public index shows liquidity is thin", "holders look
  concentrated on the public index", "it's only hours old", "fomo traders
  mostly argue it's still early", "on fomo, more traders have been buying in
  than heading out lately", "per on-chain data, the buying over the last hour
  came from only a small group of addresses". Never a number, price, size,
  P&L, handle, quote,
  wallet list or address. A valuation cue (under- or overvalued) is never
  said. Every phrase is pinned through the real X gate in the tests. When
  nothing could be looked up for a coin, the writer is told so and to say so
  briefly, or pass, never "say what you looked up".
- **Budget:** one bundle per answer, at most six lookups and twelve seconds;
  an index or chain read at most four, a Fomo read at most eight (an
  uncached thesis page is slow, and one cut short is paid for and never
  heard), a flow reading at most eight (the lane needs three seconds for
  each of its two queries, and the reading's own deadline is shortened to
  that share). Flow readings: at most the part of the lane's day that child
  evidence cannot spend, per UTC day across X accounts (200 with the lane's
  defaults, `xpost_meta` `x-answer-flow:<day>`), taken before the read, so
  strangers' tags never eat into the trading reviews' share. Index lookups:
  eight per X account per ten minutes,
  `MERRYMEN_XPOST_RESEARCH_PER_HOUR` across X accounts. Fomo: the `x-answer`
  surface's own hourly cap per X account (`MERRYMEN_FOMO_X_HOURLY_CREDITS`)
  and at most a quarter of the owner's daily Fomo cap per day across her X
  accounts, under her caps and the fleet's pools; Fomo is advertised in
  "what can you do?" and asked only for an owner whose data access is on. A
  lookup refused, failed or late is simply not a fact; the answer is still
  written.
- **The gate is unchanged:** no numbers, no prices, no advice, never that it
  holds a coin now. A coin it did not trade is named without a `$` sign (an
  unvouched cashtag is refused).
- **Fomo on X: pending owner confirmation.** Paraphrased, attributed Fomo
  facts in these answers republish provider-derived data, which needs the
  provider's Enterprise redistribution rights. Do not set
  `MERRYMEN_XPOST_FOMO=1` until Milla confirms those rights in her own words
  and the plan or agreement is cited in `docs/fomo.md` ("Publication"). Fomo
  publication drafts stay policy-blocked either way.
- **Logs:** counts only (`answer-intent-coin`, `answer-lookups`,
  `answer-research-index-busy` and the like), never a coin, a person or an
  address.

## Rollout for the operator's own agent

How this release is turned on for Alan Al Dale, the operator's own agent,
every service and value in order: the X steps (5 and 6) rest on the research
lanes before them. Unset is the default and changes nothing, except for an account already on `MERRYMEN_DECISION_RESEARCH_ACCOUNTS` (step 1). This table is the same in [`hosted-deploy.md`](hosted-deploy.md) and [`x-posting.md`](x-posting.md); change both together.

| Step | Variable | Service | Value for Alan's rollout | What it does, and what to look for |
|---|---|---|---|---|
| 1 | *(deploy)* | Brain service, orchestrator, web; the gateway (its own project) first or with them | this commit | The worker sends the Trencher terms and the flow lens only once Brain's `/health` lists `strategy-terms` and `onchain-flow`, so either order is safe. The worker's Bearer fix starts gateway spending, under the gateway's own cap (below). **An account already on `MERRYMEN_DECISION_RESEARCH_ACCOUNTS` changes at deploy, with nothing else set:** its live fast-Trencher entry reviews get the new momentum plan at once, the Trencher terms once Brain lists `strategy-terms`, and, with Fomo already on and the owner's monitoring or follow setting on, Fomo research on its review candidates. To stage those, take the account out of the variable before deploying and put it back at step 3 |
| 2 | `MERRYMEN_COINGECKO_PRO_SPACING_MS` | orchestrator (children inherit it) | `800` | One `[gecko] coingecko-pro fleet lane: 800 ms` line per child |
| 2 | `MERRYMEN_COINGECKO_PRO_SPACING_MS` | web | `2600` | One `local lane: 2600 ms` line on web. From here web's chart reads are paced too (unset, they stay unpaced as before), so two cold token pages opened within about 2.6 s may show the second one's chart as unreachable until it is read again |
| 2 | `MERRYMEN_COINGECKO_MONTHLY_CREDITS` | orchestrator and web | `5000000` | The plan's month; a spacing below the floor it allows is raised to it. `MERRYMEN_COINGECKO_PRO_API_KEY` stays as it is |
| 3 | `MERRYMEN_FOMO_ENABLED` | web + orchestrator, same value | `1` | Fomo itself, and the IPC channel a child asks the flow lane over |
| 3 | `MERRYMEN_DECISION_RESEARCH_ACCOUNTS` | orchestrator (children inherit it) | Alan's smart account, from the deploy environment (this repository names no account) | Cost quotes, his own outcomes, the momentum plan, the Trencher terms and indexed flow for his live fast-Trencher entry reviews. Decision log lines end `· terms sent` |
| 4 | `MERRYMEN_BITQUERY_API_KEY` | **orchestrator only** | the plan's key, after the IDE checks in [`bitquery-lane.md`](bitquery-lane.md) step 1 | Never on web, Brain or a child (stripped). Boot line `bitquery lane: on — 25000 points/UTC day (20000 for child evidence) …`; reviews log `[trencher] flow SYMBOL: lens` |
| 4 | `MERRYMEN_BITQUERY_LANE`, `MERRYMEN_BITQUERY_POINTS_PER_DAY`, `MERRYMEN_BITQUERY_RPM` | orchestrator | unset (on, `25000`, `60`) | |
| 4 | `MERRYMEN_GATEWAY_BITQUERY_POINTS_PER_DAY` | gateway | `5000`, set explicitly when its key shares the plan | Lane plus gateway: 30,000 points a day, 900,000 of a 1,000,000-point month. The gateway's 5,000 includes the public memescope's own 2,000 (at most 1,800 used, one refresh per 240 s); holders get the other 3,000, at most 750 a day each |
| 4 | `MERRYMEN_FLOW_BROKER` | none | never set | The orchestrator writes it into each child that may ask, and removes an inherited copy |
| 5 | `MERRYMEN_XPOST_ACTIVE_TENANTS` | web + orchestrator, same value | Alan's tenant address, from the deploy environment | The active cadence, his reply consent recorded by the orchestrator, and answers to tags sent right away. The web reads it for the reply warning |
| 5 | `MERRYMEN_XPOST_REPLIES_APPROVED` | web + orchestrator, same value | `active`, **only once X's written approval for AI replies is in hand**; unset until then | Without it there are no comment replies and no answers to tags. No approval has been obtained for this deployment |
| 5 | `MERRYMEN_XPOST_REPLY_POLLS_PER_DAY` | orchestrator | unset (`200` for the fleet) | Alan's one-minute polls spend their own 1,500 per X account per UTC day |
| 6 | `MERRYMEN_XPOST_RESEARCH` | orchestrator | `1` | Answers look things up first. Boot line `xpost: on — … answers look things up first`; with the Bitquery key also `xpost: answers may read onchain flow — up to 200 readings per UTC day …` |
| 6 | `MERRYMEN_XPOST_RESEARCH_PER_HOUR` | orchestrator | unset (`120`) | Public-index lookups per hour across X accounts |
| 6 | `MERRYMEN_XPOST_FOMO` | orchestrator | **unset**; `1` only after Milla confirms Fomo's Enterprise redistribution rights herself and the plan or agreement is cited in [`fomo.md`](fomo.md) "Publication" | Paraphrased, attributed Fomo facts in answers |
| 6 | `MERRYMEN_FOMO_X_HOURLY_CREDITS` | orchestrator | unset (`3000`) | Per X account per hour, and at most a quarter of the owner's daily Fomo cap |

No migrations: the new state is `xpost_meta` keys only (`answer-author:…`,
`replies-off:…`, `reply-polls-active:…`, `x-answer-flow:…`). No trading cap,
risk limit, grant, wallet authority or authentication check changes. The X
gate gains one narrow exception, the name `sherwood-1` in an answer. Steps 5
and 6 change what is said publicly on X and need Milla's review; step 6's
answers need step 5's approval first. Nothing in this table is set by
merging: each value is the operator's to set on the service named.

**Rolling the orchestrator back past this release.** An older orchestrator
reads an `answer` row as a casual post, with no reply target, and would
publish a queued answer (a reply to one person, ending "Say stop to opt
out.") as a standalone post on Alan's timeline the same day. So before
deploying an older orchestrator, empty the queue first. Either unset
`MERRYMEN_XPOST_REPLIES_APPROVED` (or take Alan's tenant out of
`MERRYMEN_XPOST_ACTIVE_TENANTS`) on the orchestrator and let one pass of this
release run, which cancels every waiting answer as `replies-off`; or cancel
them directly on the shared database:
`UPDATE xpost_posts SET status = 'cancelled', reason = 'rollback' WHERE kind = 'answer' AND status = 'scheduled';`
Then deploy the older build. An answer this release could not send within an
hour of drafting it is already skipped as stale, so the queue is short.

## What an owner should know (it is in the warning)

- The agent posts from whichever X account was approved on X's screen, which
  is the account that browser was signed into on X. The iOS app signs in to X
  in a private sheet every time, so the owner picks the account on purpose.
- X may label automated posting, and it auto-locks some accounts for
  verification the first time they post about crypto.
- Posts go out on their own, a few a day at most. Each one waits under Coming
  up for at least ten minutes first, and can be skipped there. An active
  owner's agent (`repliesActive`) posts on the active cadence instead, so its
  posting warning says up to 12 a day, at least an hour apart, with a few
  passing thoughts a day and a post for most coins it buys; the blurb and
  the passing-thought hint say the same. Web and iOS use the same sentences.
- Reply to comments is a separate choice. It answers selected comments on
  coin posts, shares the post limit and review window, and can be turned off
  without stopping ordinary posts. The warning names the account it replies
  as. A commenter can say stop to opt out.
- The reply warning says exactly what it turns on, per agent
  (`repliesActive` in `GET /api/x/account`, from the web's
  `MERRYMEN_XPOST_ACTIVE_TENANTS`). For an active owner's agent it describes
  answers to posts that tag it, comments on its own posts included. Answers
  go out right away and do not wait under Coming up. There are up to 24 a
  day on top of its posts, at most two to one person a day, and anyone can
  reply stop to opt out. Every other owner is told about comment replies on
  coin posts only. Web and iOS use the same sentences, and the tests pin
  them.

## Optional voice, public addresses and sale results

The defaults above stay in place. Each owner can separately choose a dry voice
(`xVoice: "dry"`), a public wallet in the introduction (`xPublicWalletIntro`),
token contract addresses (`xTokenAddresses`), and completed-sale commentary
(`xTradeResults`). These choices do not alter trading authority, execution risk
limits, posting consent, the owner's smaller daily allowance, or reply consent.
The private `agentBrief` never enters an X prompt.

- The dry voice allows occasional light sarcasm about an idea or the agent
  itself. AI disclosure and the prohibition on invented human experiences stay.
- A wallet is appended by trusted code only to an introduction, after its prose
  passes the ordinary gate. It is the running agent's current grant account,
  with an explicit Robinhood Chain or Testnet label. The model never types it.
- A token CA is appended only to a buy or sale whose decision and completed
  trade belong to that same account, current epoch and supported chain, with
  the matching fill side and positive quantity. A live trade also needs a
  receipt basis and execution transaction hash; simulated fills need an explicit
  paper basis. Model-generated addresses remain
  forbidden, and unsupported networks or missing proof withhold the post.
- With `discoveryFocus: "new-projects"` and token addresses enabled, a buy can
  also explain the exact token's on-chain description. The RPC chain and token
  must match, the source is bounded creator-written text, and the draft must
  attribute the claim with "project says". This later lookup is not presented
  as the reason the buy happened. Missing or unusable metadata leaves only
  the observed trade thesis; no utility is inferred from a ticker or price.
- Sale posts require receipt-backed live execution. Their model-written prose
  says only what sold, allowing partial sales without claiming a full exit.
  Trusted code may append a measured **gross** gain, loss or flat outcome,
  explicitly **before fees and gas**, with a matching short reaction. Missing
  or estimated cost basis means neutral sale commentary with no result claim.
  There is no claim of net profitability or of selling early; those require
  evidence this path does not have.

The complete post, including deterministic suffixes, must fit X's weighted
character limit. Pending disclosures are revalidated against current consent,
grant identity, chain and receipt evidence immediately before sending, including
after a token refresh. Changed or missing evidence withholds the pending post.
The original at-most-once claim, review window, account gap and daily limits
continue to apply; buy and sale posts share the existing trade-post ceiling.
An introduction posted manually is not automatically imported into the queue:
the owner should skip a duplicate introduction under Coming up.

## Known limits

- **The iOS hand-off uses the `merrymen://` scheme.** For an `i.` state the
  `/connect/x` page hands the code to `merrymen://x-connect`. Inside the app's
  own sign-in sheet that is safe. But if an attacker started an iOS connect
  from their own merrymen account, got a victim to approve it on X, and an app
  on the victim's phone had claimed the `merrymen` scheme, the code could reach
  the attacker, and the victim's X account would be connected to the
  attacker's agent. A cookie set on the way into the sheet would not close
  this, because the attacker could send that URL instead. The fix is an
  associated-domains `https` callback (`ASWebAuthenticationSession` with
  `.https(host:path:)`, iOS 17.4+), which needs an entitlement and an
  apple-app-site-association file that do not exist yet. The web flow is not
  affected: its code never leaves the browser that started it.
- **Two replicas refreshing one owner during a lease handover** can still race
  when the winner's answer is in flight while the loser re-reads; the loser
  may then mark the account revoked and the owner must reconnect. A refresh
  claim (a `refreshing_until_ms` compare-and-swap before calling X) would close
  it. Run one orchestrator replica (`docs/hosted-deploy.md`).
- **An owner whose zone nobody knows is never asleep**, so their posts can go
  out at any local hour until the web or the app reports a zone.
- **Without a model, only template intros go out**, and the pool saturates on
  a large fleet (see rule 7).
- **AI replies remain disabled pending written X approval.** This deployment
  has no approval as of September 30, 2026. Shipping this code does not enable
  the feature, and owner consent cannot bypass the operator gate. Every intro
  identifies the agent as AI, and no post or reply may claim a human life.
