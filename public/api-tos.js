/** Torn API Terms of Service markup — single source for /tos and login disclosure. */

function apiTosTableHtml() {
  return `
    <div class="api-tos-table-wrap">
      <table class="api-tos-table">
        <thead>
          <tr>
            <th scope="col">Data Storage</th>
            <th scope="col">Data Sharing</th>
            <th scope="col">Purpose of Use</th>
            <th scope="col">Key Storage &amp; Sharing</th>
            <th scope="col">Key Access Level</th>
          </tr>
          <tr class="api-tos-questions">
            <th scope="col">Will the data be stored for any purpose?</th>
            <th scope="col">Who can access the data besides the end user?</th>
            <th scope="col">What is the stored data being used for?</th>
            <th scope="col">Will the API key be stored securely and who can access it?</th>
            <th scope="col">What key access level or specific selections are required?</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Persistent — until account deletion (player id, name, login metadata). Page-view analytics retained for service operation. Market price cache refreshed/overwritten over time.</td>
            <td>Service owners (admins: users list and analytics). Aggregated market averages and public stock tools are available to site users / general public. Personal Torn payload beyond stored identity is not shared with other players.</td>
            <td>Public community tools — foreign stock travel planning (capacity, in-flight status, market averages, restock graphs).</td>
            <td>Stored locally / Not shared (browser localStorage). Relayed through our server to Torn only; never persisted. Optional operator key: Stored remotely securely / Used only for automation (market cache). Not shared with YATA or other third-party services.</td>
            <td>Custom — user → basic, perks, travel; market → itemmarket</td>
          </tr>
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
