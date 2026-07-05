export function Footer() {
  const footerLinks = {
    Product: ["Catches", "Decisions", "Knowledge graph", "Feedback loop", "Pre-flight", "Security", "MCP"],
    Integrations: ["GitHub App", "Slack app", "Linear agent", "MCP server", "CLI", "GitHub Action", "Dashboard"],
    Company: ["About", "Built on Cognee", "Roadmap", "README", "Quality", "Brand"],
    Resources: ["Docs", "Status", "Self-hosting", "Report vulnerability", "Privacy", "Terms"],
    Connect: ["Contact us", "Community", "X (Twitter)", "GitHub", "YouTube"],
  }

  return (
    <footer className="border-t border-zinc-800 py-16 px-6" style={{ backgroundColor: "#09090B" }}>
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-8">
          {/* Logo */}
          <div className="col-span-2 md:col-span-1">
            <svg width="20" height="20" viewBox="0 0 100 100" fill="none" className="text-white">
              <path
                d="M20 30 L50 10 L80 30 L80 70 L50 90 L20 70 Z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M50 10 L50 50 L20 30" fill="#09090B" />
              <path d="M50 50 L80 70 L50 90" fill="#09090B" />
            </svg>
          </div>

          {/* Links */}
          {Object.entries(footerLinks).map(([category, links]) => (
            <div key={category}>
              <h3 className="text-white font-medium text-sm mb-4">{category}</h3>
              <ul className="space-y-3">
                {links.map((link) => (
                  <li key={link}>
                    <a href="#" className="text-zinc-500 hover:text-zinc-300 transition-colors text-sm">
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </footer>
  )
}
