import { Navbar, Footer, FeaturesSection, HowItWorksSection, PricingSection, CopyButton, MCP_URL } from './components'

export default function LandingPage() {
  return (
    <>
      <Navbar />

      {/* Hero */}
      <section className="hero">
        <div className="container">
          <div className="hero-badge anim-fade-up">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M6 0L7.8 4.2L12 6L7.8 7.8L6 12L4.2 7.8L0 6L4.2 4.2L6 0Z"/>
            </svg>
            Remote MCP Server for Claude.ai
          </div>
          <h1 className="hero-title anim-fade-up anim-delay-1">
            Workspace Lens
          </h1>
          <p className="hero-subtitle anim-fade-up anim-delay-2">
            Workspace Lens is a remote MCP server that connects Claude to your Google Workspace.
            Read and write Docs, Sheets, Slides, Drive, Forms, Apps Script, and Tasks
            through natural conversation — no configuration required.
          </p>

          <div className="hero-cta anim-fade-up anim-delay-3">
            <a href="#how-it-works" className="btn btn-primary">Get started free</a>
            <a href="#features" className="btn btn-secondary">See all tools</a>
          </div>

          <div className="anim-fade-up anim-delay-4" style={{ display: 'flex', justifyContent: 'center' }}>
            <div className="url-widget">
              <span className="url-widget-label">MCP URL</span>
              <span className="url-widget-value">{MCP_URL}</span>
              <CopyButton text={MCP_URL} />
            </div>
          </div>
        </div>
      </section>

      <FeaturesSection />
      <HowItWorksSection />
      <PricingSection />
      <Footer />
    </>
  )
}
