import { Navbar, Footer } from './components'

export default function TermsPage() {
  return (
    <>
      <Navbar />
      <div className="legal-page">
        <a href="/" className="legal-back">← Back to home</a>
        <h1>Terms of Service</h1>
        <p className="legal-date">Last updated: June 3, 2026</p>

        <p>
          Please read these Terms of Service ("Terms") carefully before using Workspace Lens
          server ("Service"). By connecting the Service to your Claude.ai account, you agree to be
          bound by these Terms.
        </p>

        <h2>1. Description of Service</h2>
        <p>
          The Service is a Model Context Protocol (MCP) server that allows Anthropic's Claude AI assistant
          to interact with your Google Workspace account — including Google Docs, Sheets, Slides, Drive,
          Forms, Apps Script, and Tasks — through tool calls initiated by you during a Claude conversation.
        </p>
        <p>
          The Service acts as a bridge between Claude and Google APIs. All actions performed by the Service
          are initiated by you through your Claude conversation; the Service does not act autonomously.
        </p>

        <h2>2. Eligibility</h2>
        <p>
          You must be at least 13 years old and have a valid Google account to use the Service.
          By using the Service, you represent that you meet these requirements and that you have
          the authority to authorize access to the Google Workspace account you connect.
        </p>

        <h2>3. Acceptable Use</h2>
        <p>You agree to use the Service only for lawful purposes. You may not:</p>
        <ul>
          <li>Use the Service to access Google accounts you do not own or are not authorized to access.</li>
          <li>Automate requests in a way that violates Google's Terms of Service or API rate limits.</li>
          <li>Use the Service to send spam, distribute malware, or engage in any form of abuse.</li>
          <li>Attempt to reverse-engineer, disrupt, or interfere with the Service's infrastructure.</li>
          <li>Use the Service for any purpose that is illegal under applicable law.</li>
        </ul>

        <h2>4. Google Account Authorization</h2>
        <p>
          By authorizing the Service with your Google account, you grant the Service permission to
          call Google APIs on your behalf using the OAuth scopes listed in our Privacy Policy.
          You can revoke this authorization at any time through your Google Account settings.
        </p>
        <p>
          You are responsible for all actions taken through your authorized session.
          Do not share your MCP connection or allow others to use your authorized session.
        </p>

        <h2>5. No Warranty</h2>
        <p>
          THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND,
          EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY,
          FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
        </p>
        <p>
          We do not warrant that the Service will be uninterrupted, error-free, or that data
          transmitted through the Service will be secure. Google API availability and functionality
          are outside our control.
        </p>

        <h2>6. Limitation of Liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL WE BE LIABLE FOR
          ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES ARISING OUT OF
          OR IN CONNECTION WITH YOUR USE OF THE SERVICE, INCLUDING BUT NOT LIMITED TO LOSS OF DATA,
          LOSS OF REVENUE, OR LOSS OF BUSINESS OPPORTUNITIES.
        </p>
        <p>
          Our total liability to you for any claim arising from these Terms or your use of the
          Service shall not exceed USD $0, as the Service is provided free of charge.
        </p>

        <h2>7. Third-Party Services</h2>
        <p>
          The Service connects to Google APIs (google.com) and is hosted on Cloudflare (cloudflare.com).
          Your use of those services is governed by their respective terms of service.
          This Service is not affiliated with, endorsed by, or sponsored by Google LLC or Cloudflare, Inc.
        </p>

        <h2>8. Modifications to Service</h2>
        <p>
          We reserve the right to modify, suspend, or discontinue the Service at any time without notice.
          We will not be liable to you or any third party for any modification, suspension, or discontinuation.
        </p>

        <h2>9. Modifications to Terms</h2>
        <p>
          We may update these Terms from time to time. The updated date at the top of this page indicates
          when the Terms were last revised. Your continued use of the Service after changes constitutes
          acceptance of the updated Terms.
        </p>

        <h2>10. Governing Law</h2>
        <p>
          These Terms are governed by and construed in accordance with the laws of Vietnam,
          without regard to its conflict of law provisions.
        </p>

        <h2>11. Contact</h2>
        <p>
          For questions about these Terms, contact us at:{' '}
          <a href="mailto:manhtuongdz@gmail.com">manhtuongdz@gmail.com</a>
        </p>
      </div>
      <Footer />
    </>
  )
}
