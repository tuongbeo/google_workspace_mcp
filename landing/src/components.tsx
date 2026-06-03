import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

const MCP_URL = 'https://office.lens.io.vn/mcp'
const BYOC_URL = 'https://auth.lens.io.vn/byoc-register'
const GITHUB_URL = 'https://github.com/tuongbeo/google_workspace_mcp'

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button onClick={copy} className={`url-copy-btn ${copied ? 'copied' : ''} ${className}`}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'Copied!' : 'Copy URL'}
    </button>
  )
}

const FEATURES = [
  { icon: '📝', name: 'Google Docs', bg: '#e8f0fe', desc: 'Create, read, and edit documents. Write rich content with headings, tables, and images.' },
  { icon: '📊', name: 'Google Sheets', bg: '#e6f4ea', desc: 'Read and write spreadsheets. Build formatted sheets with charts, formulas, and themes.' },
  { icon: '🎞️', name: 'Google Slides', bg: '#fce8e6', desc: 'Create presentations from outlines. Add slides, shapes, images, and text boxes.' },
  { icon: '📁', name: 'Google Drive', bg: '#fef7e0', desc: 'Create and manage files and folders. Share files and manage permissions.' },
  { icon: '📋', name: 'Google Forms', bg: '#f3e8fd', desc: 'Create and update forms. Read responses and configure publish settings.' },
  { icon: '⚙️', name: 'Apps Script', bg: '#e8f0fe', desc: 'Read and update script projects. Create versions, manage deployments, and run functions.' },
  { icon: '✅', name: 'Google Tasks', bg: '#e6f4ea', desc: 'Create and manage task lists. Add, update, complete, and organize tasks.' },
]

export function FeaturesSection() {
  return (
    <section className="section section-alt" id="features">
      <div className="container">
        <p className="section-eyebrow">What's included</p>
        <h2 className="section-title">Seven Google services,<br />fully connected</h2>
        <p className="section-subtitle">
          Each service exposes a complete set of read and write tools — not just basic lookups.
        </p>
        <div className="features-grid">
          {FEATURES.map(f => (
            <div className="feature-card" key={f.name}>
              <div className="feature-icon" style={{ background: f.bg }}>{f.icon}</div>
              <div className="feature-name">{f.name}</div>
              <div className="feature-desc">{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export function HowItWorksSection() {
  return (
    <section className="section" id="how-it-works">
      <div className="container">
        <p className="section-eyebrow">Setup</p>
        <h2 className="section-title">Three steps,<br />no configuration</h2>
        <p className="section-subtitle">
          No API keys to manage. No server to run. Just copy a URL and authenticate with your Google account.
        </p>
        <div className="steps">
          <div className="step">
            <div className="step-number">1</div>
            <div className="step-title">Copy the MCP URL</div>
            <div className="step-desc">Copy the URL below and open Claude.ai settings.</div>
            <code className="step-code">office.lens.io.vn/mcp</code>
          </div>
          <div className="step">
            <div className="step-number">2</div>
            <div className="step-title">Add as a connector</div>
            <div className="step-desc">In Claude.ai → Settings → Integrations → Add custom integration, paste the URL.</div>
          </div>
          <div className="step">
            <div className="step-number">3</div>
            <div className="step-title">Authenticate once</div>
            <div className="step-desc">Authorize with your Google account. Claude can now read and write your Workspace files.</div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function PricingSection() {
  return (
    <section className="section section-alt" id="pricing">
      <div className="container" style={{ textAlign: 'center' }}>
        <p className="section-eyebrow">Pricing</p>
        <h2 className="section-title">Free to use</h2>
        <p className="section-subtitle" style={{ margin: '0 auto' }}>
          The shared tier is completely free. Bring your own OAuth app for a dedicated, isolated setup.
        </p>
        <div className="pricing-grid">
          <div className="pricing-card featured">
            <div className="pricing-badge">Recommended</div>
            <div className="pricing-tier">Shared</div>
            <div className="pricing-price">Free <span>forever</span></div>
            <div className="pricing-tagline">Use the shared OAuth app. No account required.</div>
            <ul className="pricing-features">
              <li><span className="check-icon">✓</span> All 7 Google services</li>
              <li><span className="check-icon">✓</span> All read & write tools</li>
              <li><span className="check-icon">✓</span> Shared OAuth credentials</li>
              <li><span className="check-icon">✓</span> Instant setup — just copy the URL</li>
            </ul>
            <a href={MCP_URL} className="btn btn-primary pricing-cta" onClick={e => { e.preventDefault(); navigator.clipboard.writeText(MCP_URL) }}>
              <Copy size={14} /> Copy MCP URL
            </a>
          </div>
          <div className="pricing-card">
            <div className="pricing-tier">BYOC</div>
            <div className="pricing-price">Free <span>+ your GCP</span></div>
            <div className="pricing-tagline">Bring your own Google Cloud OAuth app.</div>
            <ul className="pricing-features">
              <li><span className="check-icon">✓</span> Your own OAuth credentials</li>
              <li><span className="check-icon">✓</span> Dedicated tenant URL</li>
              <li><span className="check-icon">✓</span> No shared token storage</li>
              <li><span className="check-icon">✓</span> Full audit control</li>
            </ul>
            <a href={BYOC_URL} className="btn btn-secondary pricing-cta" target="_blank" rel="noreferrer">
              Register your app ↗
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

export function Navbar() {
  return (
    <nav className="navbar">
      <div className="container navbar-inner">
        <a href="/" className="navbar-logo">
          <div className="logo-icon">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 1L15 5V11L8 15L1 11V5L8 1Z" stroke="white" strokeWidth="1.5" fill="none"/>
              <circle cx="8" cy="8" r="2.5" fill="white"/>
            </svg>
          </div>
          Workspace MCP
        </a>
        <ul className="navbar-links">
          <li><a href="#features">Features</a></li>
          <li><a href="#how-it-works">Setup</a></li>
          <li><a href="#pricing">Pricing</a></li>
          <li><a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a></li>
          <li><a href={MCP_URL} className="btn-nav" onClick={e => { e.preventDefault(); navigator.clipboard.writeText(MCP_URL) }}>Copy MCP URL</a></li>
        </ul>
      </div>
    </nav>
  )
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="footer-left">
          <span>© 2026 Workspace MCP</span>
          <span style={{ color: 'var(--border-strong)' }}>·</span>
          <span>Not affiliated with Google LLC</span>
        </div>
        <ul className="footer-links">
          <li><a href="/privacy">Privacy Policy</a></li>
          <li><a href="/terms">Terms of Service</a></li>
          <li><a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a></li>
        </ul>
      </div>
    </footer>
  )
}

export { MCP_URL, BYOC_URL }
