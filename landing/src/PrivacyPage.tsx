import { Navbar, Footer } from './components'

export default function PrivacyPage() {
  return (
    <>
      <Navbar />
      <div className="legal-page">
        <a href="/" className="legal-back">← Back to home</a>
        <h1>Privacy Policy</h1>
        <p className="legal-date">Last updated: June 3, 2026</p>

        <p>
          This Privacy Policy describes how Workspace Lens ("Service", "we", "our")
          collects, uses, and stores information when you use the Service to connect Claude with
          your Google Workspace account.
        </p>

        <h2>1. Information We Collect</h2>
        <p>When you authorize the Service, we collect and store:</p>
        <ul>
          <li><strong>Google OAuth tokens</strong> — access token and refresh token issued by Google after your authorization. These tokens allow the Service to call Google APIs on your behalf.</li>
          <li><strong>Google account email address and user ID</strong> — used to associate your tokens with your session and to identify your account across reconnections.</li>
          <li><strong>OAuth session state</strong> — short-lived state parameters used during the OAuth flow to prevent CSRF attacks. These are deleted within 10 minutes.</li>
        </ul>
        <p>We do <strong>not</strong> collect the contents of your Google Docs, Sheets, Slides, Drive files, Emails, or any other Google Workspace content unless you explicitly instruct Claude to process a specific file or item.</p>

        <h2>2. Google API Scopes Requested</h2>
        <p>The Service requests the following Google OAuth scopes, depending on which services you use:</p>
        <ul>
          <li><code>https://www.googleapis.com/auth/drive.file</code> — Create and manage files created by this app</li>
          <li><code>https://www.googleapis.com/auth/documents</code> — Create and edit Google Docs</li>
          <li><code>https://www.googleapis.com/auth/spreadsheets</code> — Create and edit Google Sheets</li>
          <li><code>https://www.googleapis.com/auth/presentations</code> — Create and edit Google Slides</li>
          <li><code>https://www.googleapis.com/auth/forms.body</code> — Create and edit Google Forms</li>
          <li><code>https://www.googleapis.com/auth/script.projects</code> — Manage Apps Script projects</li>
          <li><code>https://www.googleapis.com/auth/script.deployments</code> — Manage Apps Script deployments</li>
          <li><code>https://www.googleapis.com/auth/script.metrics</code> — View Apps Script execution metrics</li>
          <li><code>https://www.googleapis.com/auth/tasks</code> — Manage Google Tasks</li>
          <li><code>openid</code>, <code>email</code>, <code>profile</code> — Identify your account</li>
        </ul>
        <p>These scopes are used exclusively to execute tool calls that you initiate through Claude. The Service does not access your data autonomously or in the background.</p>

        <h2>3. How We Use Your Information</h2>
        <ul>
          <li><strong>OAuth tokens</strong> are used solely to authenticate API requests to Google on your behalf, when you ask Claude to perform a specific action (e.g., "create a spreadsheet", "read this document").</li>
          <li><strong>Email address and user ID</strong> are used to store and retrieve your tokens and to identify your session. They are not used for marketing, analytics, or shared with third parties.</li>
          <li>We do <strong>not</strong> use your data for advertising, training AI models, or any purpose other than executing the Google API calls you request.</li>
        </ul>

        <h2>4. Data Storage and Security</h2>
        <ul>
          <li>OAuth tokens are stored in <strong>Cloudflare Workers KV</strong>, a globally distributed key-value store operated by Cloudflare, Inc.</li>
          <li>Tokens are stored with a 90-day time-to-live (TTL) and are automatically expired after that period.</li>
          <li>Access to stored tokens is restricted to the Service's Cloudflare Worker — no other party has access.</li>
          <li>All data is transmitted over HTTPS/TLS.</li>
        </ul>

        <h2>5. Third-Party Services</h2>
        <p>The Service uses the following third-party infrastructure:</p>
        <ul>
          <li><strong>Cloudflare Workers and KV</strong> (cloudflare.com) — hosting, edge computing, and token storage.</li>
          <li><strong>Google APIs</strong> (googleapis.com) — all Google Workspace API calls are made to Google's servers.</li>
        </ul>
        <p>We do not use any analytics, advertising, or tracking third-party services.</p>

        <h2>6. Data Retention</h2>
        <ul>
          <li>OAuth tokens are retained for 90 days from the last authentication or until you revoke access.</li>
          <li>You can delete your tokens at any time by revoking the app's access in your <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">Google Account security settings</a>. Revocation immediately invalidates the tokens; the stored record will expire naturally within 90 days.</li>
        </ul>

        <h2>7. Your Rights</h2>
        <p>You have the right to:</p>
        <ul>
          <li><strong>Revoke access</strong> at any time via Google Account → Security → Third-party apps with account access.</li>
          <li><strong>Request deletion</strong> of your stored token data by contacting us at the email below. We will delete your token record within 7 business days.</li>
          <li><strong>Know what data is stored</strong> — as described in Section 1, we only store OAuth tokens and your email/user ID.</li>
        </ul>

        <h2>8. Children's Privacy</h2>
        <p>
          The Service is not intended for use by children under 13 years of age. We do not knowingly collect
          personal information from children under 13.
        </p>

        <h2>9. Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. The updated date at the top of this page
          indicates when the policy was last revised. Continued use of the Service after changes constitutes
          acceptance of the updated policy.
        </p>

        <h2>10. Contact</h2>
        <p>
          For questions about this Privacy Policy or to request data deletion, contact us at:{' '}
          <a href="mailto:manhtuongdz@gmail.com">manhtuongdz@gmail.com</a>
        </p>

        <p style={{ marginTop: 32, fontSize: 13, color: 'var(--text-muted)' }}>
          This Service is not affiliated with, endorsed by, or sponsored by Google LLC.
          Google Workspace, Google Docs, Google Sheets, Google Slides, Google Drive, Google Forms,
          Google Apps Script, and Google Tasks are trademarks of Google LLC.
        </p>
      </div>
      <Footer />
    </>
  )
}
