import { createHash } from "node:crypto";
import type { ExpressAdapter } from "@microsoft/teams.apps";

const styles = `
:root {
  color-scheme: light dark;
  --background: #fafbfc;
  --text: #202631;
  --muted: #4e5969;
  --accent: #2455a4;
  --border: #c9d1de;
  --inset: #edf1f7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #151a22;
    --text: #eef1f6;
    --muted: #bac4d3;
    --accent: #a4c7ff;
    --border: #485466;
    --inset: #232c39;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--background);
  color: var(--text);
  font: 1rem/1.7 "Segoe UI", system-ui, sans-serif;
  overflow-wrap: anywhere;
}
header, main, footer { width: min(100% - 3rem, 72ch); margin-inline: auto; }
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding-block: 1rem;
  border-bottom: 1px solid var(--border);
}
nav { display: flex; gap: 1.25rem; }
a { color: var(--accent); text-underline-offset: .2em; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
[aria-current="page"] { font-weight: 700; text-decoration-thickness: 2px; }
main { padding-block: 2.75rem 3rem; }
h1 { font-size: clamp(2rem, 5vw, 2.75rem); line-height: 1.15; letter-spacing: -.025em; }
h1, h2 { font-weight: 650; }
h2 { font-size: 1.3rem; line-height: 1.35; margin-top: 2rem; }
p { margin-block: 1rem; }
.lead { font-size: 1.15rem; color: var(--muted); }
.notice { padding: 1rem 1.25rem; border-left: 3px solid var(--accent); background: var(--inset); }
code { padding: .1em .35em; background: var(--inset); font-size: .95em; }
li + li { margin-top: .6rem; }
dt { font-weight: 650; margin-top: 1rem; }
dd { margin: .25rem 0 1rem; }
footer { border-top: 1px solid var(--border); padding-block: 1.25rem 2rem; color: var(--muted); font-size: .9rem; }
.skip-link { position: absolute; top: -5rem; left: 1rem; padding: .5rem 1rem; background: var(--background); }
.skip-link:focus { top: .5rem; }
@media (max-width: 480px) {
  header, main, footer { width: calc(100% - 2rem); }
  header { align-items: flex-start; flex-direction: column; gap: .5rem; }
  main { padding-top: 1.5rem; }
}
`;

const pages = [
  {
    path: "/", label: "Overview", title: "Multi-model Agent",
    content: `
      <p class="lead">A personal Teams chat for working with Claude, Gemini, and Azure OpenAI.</p>
      <p class="notice">A pilot published by <strong>isaru66</strong>. Use nonsensitive test content only.</p>
      <h2>Start in Teams</h2>
      <p>Sign in with the approved pilot account and add the app package supplied by your
      pilot administrator. Open the agent's personal chat and send <code>help</code>.
      This website provides information; it is not a public chat interface.</p>
      <h2>Choose a model</h2>
      <p>Send <code>model</code> to see enabled providers, then select one.
      You can also send <code>model claude</code>, <code>model gemini</code>, or
      <code>model azure-openai</code>. The available deployment is configured by the
      operator; choosing Claude does not necessarily select an Opus model.</p>
      <h2>Keep control of your conversation</h2>
      <dl>
        <dt>Separate context</dt>
        <dd>Each provider has its own recent history. A failed request does not
        automatically switch to a different provider.</dd>
        <dt>Stop a response</dt>
        <dd>Use Teams' Stop control while a response is streaming. Work already
        processed by the provider may still be billed.</dd>
        <dt>Reset app-held context</dt>
        <dd>Send <code>reset</code> to clear all provider histories and the model selection
        for this conversation. This does not delete messages from Teams.</dd>
      </dl>
      <h2>Before sending a prompt</h2>
      <p>Your prompt and the selected provider's recent context leave Teams for model
      processing. Read the <a href="/privacy">privacy notice</a> and
      <a href="/terms">pilot terms</a>. AI responses may be incorrect; review them
      before relying on or executing them.</p>`,
  },
  {
    path: "/privacy", label: "Privacy", title: "Privacy notice",
    content: `
      <p class="lead">How the isaru66 Multi-model Agent pilot handles your information.</p>
      <h2>Information processed</h2>
      <p>The bot receives your message and Teams activity metadata, including tenant,
      user, conversation, and activity identifiers. These support authorization,
      reply delivery, isolated conversation state, and duplicate suppression.
      The app uses hashed scope and activity identifiers in its conversation store;
      hashing is not a claim that all information is anonymous.</p>
      <h2>Model processing</h2>
      <p>Your prompt, system instructions, and relevant recent history for the selected
      provider are sent to its operator-configured endpoint. This pilot supports
      Claude, Google Gemini, and Azure OpenAI. Only the selected provider is used for
      a request; errors do not trigger automatic switching to another provider.</p>
      <p>Processing locations, retention, and training rules depend on the endpoint
      and provider account terms. This notice does not promise zero retention,
      exclusion from training, or a particular data residency. Confirm those
      settings with the pilot administrator before submitting any sensitive data.</p>
      <h2>Conversation storage and expiry</h2>
      <p>The deployed app stores recent completed prompts and answers in Azure Cosmos DB,
      separately for each provider. It retains at most 20 completed exchanges per
      provider for a conversation and excludes exchanges from context once they reach
      24 hours after completion. Older context may be omitted earlier to meet request
      size limits. Incomplete answers are not saved as reusable conversation history.</p>
      <p>Cosmos DB physical cleanup is eventual and may occur after logical expiry.
      Conversation state also includes model selection, short-lived coordination
      state, and bounded duplicate-detection records.</p>
      <h2>Your controls</h2>
      <p>Send <code>reset</code> in the personal chat to clear the app-held provider
      histories and selection for that conversation. Reset and expiry do not delete
      Teams messages or copies already processed or retained by model providers.
      Teams and provider data are governed by their own retention controls.</p>
      <h2>Operational information</h2>
      <p>The application emits sanitized operational events, such as provider names,
      status codes, timing, token counts, and correlation identifiers. Its logging
      code does not intentionally include prompt bodies, API keys, authorization
      headers, or raw SDK payloads. Hosting and identity services may process
      connection and authentication metadata under their own policies.</p>
      <p>These information pages contain no analytics scripts, third-party resources,
      forms, or application cookies. Visiting them does not send a model prompt.</p>
      <h2>Questions</h2>
      <p>Contact the publisher, isaru66, through your pilot administrator for access
      or privacy questions. Do not include API keys or sensitive conversation content
      in a support message.</p>`,
  },
  {
    path: "/terms", label: "Terms", title: "Pilot terms of use",
    content: `
      <p class="lead">Conditions for evaluating the Multi-model Agent published by isaru66.</p>
      <h2>Evaluation use</h2>
      <p>This app is a limited pilot for authorized users in the configured Teams tenant.
      It is not a production service with a guaranteed availability or support level.
      Availability, model access, and limits may change or the pilot may be stopped.</p>
      <h2>Responsible use</h2>
      <p>Use nonsensitive test content. Only submit information you are authorized to
      share with the configured model endpoint. Do not submit secrets, passwords,
      payment details, confidential records, or regulated personal data.
      Follow your organization's policies and the applicable model-provider terms.
      Do not attempt to bypass access controls or abuse service capacity.</p>
      <h2>Review model output</h2>
      <p>Responses are AI-generated and may be inaccurate, incomplete, or unsuitable.
      Verify facts and review generated code before running it. Do not use this
      pilot as the sole basis for consequential decisions or as a substitute for
      qualified professional advice.</p>
      <h2>Processing and charges</h2>
      <p>Prompts and context are processed as described in the
      <a href="/privacy">privacy notice</a>. Model calls use the operator's configured
      provider accounts and may incur charges. Output limits and Stop are not
      monetary spending caps; work already processed may still be billed.</p>
      <h2>Access and support</h2>
      <p>The publisher may restrict or discontinue pilot access. Contact isaru66
      through your pilot administrator for questions or to report an issue.
      This pilot is published by isaru66, not by Microsoft, Anthropic, or Google.</p>`,
  },
] as const;

function renderPage(page: typeof pages[number]): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${page.title} | isaru66</title>
  <style>${styles}</style>
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  <header>
    <strong>isaru66</strong>
    <nav aria-label="Main navigation">
      ${pages.map(({ path, label }) => `<a href="${path}"${path === page.path ? ' aria-current="page"' : ""}>${label}</a>`).join("\n      ")}
    </nav>
  </header>
  <main id="content" tabindex="-1">
    <h1>${page.title}</h1>
    ${page.content}
  </main>
  <footer>Multi-model Agent. Published by isaru66 for pilot evaluation.</footer>
</body>
</html>`;
}

const contentSecurityPolicy = [
  "default-src 'none'",
  `style-src 'sha256-${createHash("sha256").update(styles).digest("base64")}'`,
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

export function registerPilotPages(adapter: ExpressAdapter): void {
  for (const page of pages) {
    const html = renderPage(page);
    adapter.get(page.path, (_request, response) => response
      .set({
        "Content-Security-Policy": contentSecurityPolicy,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-cache",
      })
      .status(200).type("html").send(html));
  }
}
