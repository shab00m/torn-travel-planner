/** Torn API Terms of Service markup — single source for /tos and login disclosure. */

const API_TOS_ROWS = [
  {
    label: "Data Storage",
    question: "Will the data be stored for any purpose?",
    value:
      "Persistent — until account deletion (player id, name, login metadata). Page-view analytics retained for service operation. Market price cache refreshed/overwritten over time.",
  },
  {
    label: "Data Sharing",
    question: "Who can access the data besides the end user?",
    value:
      "Service owners (admins: users list and analytics). Aggregated market averages and public stock tools are available to site users / general public. Personal Torn payload beyond stored identity is not shared with other players.",
  },
  {
    label: "Purpose of Use",
    question: "What is the stored data being used for?",
    value:
      "Public community tools — foreign stock travel planning (capacity, in-flight status, market averages, restock graphs).",
  },
  {
    label: "Key Storage & Sharing",
    question: "Will the API key be stored securely and who can access it?",
    value:
      "Stored locally / Not shared (browser localStorage). Relayed through our server to Torn only; never persisted. Optional operator key: Stored remotely securely / Used only for automation (market cache). Not shared with YATA or other third-party services.",
  },
  {
    label: "Key Access Level",
    question: "What key access level or specific selections are required?",
    value: "Custom — user → basic, perks, travel; market → itemmarket",
  },
];

function apiTosTableHtml() {
  const rows = API_TOS_ROWS.map(
    (row) => `
      <tr>
        <th scope="row">
          <span class="api-tos-label">${row.label}</span>
          <span class="api-tos-question">${row.question}</span>
        </th>
        <td>${row.value}</td>
      </tr>
    `
  ).join("");

  return `
    <div class="api-tos-table-wrap">
      <table class="api-tos-table">
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function apiTosProseHtml() {
  return `
    <div class="api-tos-prose">
      <p>
        Your Torn API key stays under your control in the browser. We never ask for your Torn password.
        The key is sent to this site only so we can relay requests to the Torn API; it is not written to our database.
      </p>
      <p>
        Foreign stock levels come from the
        <a href="https://yata.yt/" target="_blank" rel="noopener noreferrer">YATA</a>
        travel export and do <strong>not</strong> use your Torn API key.
      </p>
      <ul>
        <li><code>user</code> → <code>basic</code>, <code>perks</code> — login, travel type, and capacity</li>
        <li><code>user</code> → <code>travel</code> — whether you are flying to a destination</li>
        <li><code>market</code> → <code>itemmarket</code> — item market average prices (cached)</li>
      </ul>
    </div>
  `;
}

/** Full-page body for /tos. */
function apiTosPageHtml() {
  return `
    <section class="api-tos-page">
      <p class="api-tos-lead">
        How Torn Travel Planner uses your API key, in the format required by
        <a href="https://www.torn.com/api.html" target="_blank" rel="noopener noreferrer">Torn’s API Terms of Service guidelines</a>.
      </p>
      ${apiTosTableHtml()}
      ${apiTosProseHtml()}
    </section>
  `;
}

/** Collapsed disclosure shown next to every API key login form. */
function apiTosDisclosureHtml() {
  return `
    <details class="api-tos">
      <summary>
        API Terms of Service
        <a class="api-tos-full-link" href="/tos">Full page</a>
      </summary>
      <div class="api-tos-body">
        ${apiTosTableHtml()}
        ${apiTosProseHtml()}
      </div>
    </details>
  `;
}

function injectApiTosDisclosure() {
  const form = document.getElementById("login-form");
  if (!form || form.parentElement?.querySelector(":scope > .api-tos")) return;

  const wrap = document.createElement("div");
  wrap.innerHTML = apiTosDisclosureHtml().trim();
  const details = wrap.firstElementChild;
  if (!details) return;

  const fullLink = details.querySelector(".api-tos-full-link");
  if (fullLink) {
    fullLink.addEventListener("click", (e) => e.stopPropagation());
  }

  form.insertAdjacentElement("afterend", details);
}

function injectSiteFooter() {
  if (document.querySelector(".site-footer")) return;

  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `
    <div class="site-footer-inner">
      <span id="status" class="status site-footer-status"></span>
      <a href="/tos">API Terms of Service</a>
    </div>
  `;
  document.body.appendChild(footer);
}

injectSiteFooter();
