export function Footer() {
  const footerLinks: Record<string, Array<{ label: string; href: string }>> = {
    Product: [
      { label: "Catches", href: "/dashboard" },
      { label: "Decisions", href: "/dashboard" },
      { label: "Knowledge graph", href: "/dashboard" },
      { label: "Feedback loop", href: "/#how-it-works" },
      { label: "Pre-flight", href: "/#integrations" },
      { label: "Precision", href: "/#product" },
      { label: "MCP", href: "/#agents" },
    ],
    Integrations: [
      { label: "GitHub App", href: "https://github.com/apps/orinbot" },
      { label: "Slack app", href: "https://orin-bot.duckdns.org/slack/install" },
      { label: "Linear agent", href: "https://orin-bot.duckdns.org/linear/install" },
      { label: "MCP server", href: "/#agents" },
      { label: "CLI", href: "/#integrations" },
      { label: "GitHub Action", href: "/#integrations" },
      { label: "Dashboard", href: "/dashboard" },
    ],
    Company: [
      { label: "About", href: "/#product" },
      { label: "Built on Cognee", href: "https://www.cognee.ai" },
      { label: "Roadmap", href: "https://github.com/apps/orinbot" },
      { label: "README", href: "https://github.com/apps/orinbot" },
    ],
    Resources: [
      { label: "How it works", href: "/#how-it-works" },
      { label: "Agents", href: "/#agents" },
      { label: "Report vulnerability", href: "mailto:contact@hooman.digital" },
      { label: "Status", href: "https://orin-bot.duckdns.org/v1/me" },
    ],
    Connect: [
      { label: "Contact us", href: "mailto:contact@hooman.digital" },
      { label: "GitHub", href: "https://github.com/apps/orinbot" },
      { label: "Dashboard", href: "/dashboard" },
    ],
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
                  <li key={link.label}>
                    <a href={link.href} className="text-zinc-500 hover:text-zinc-300 transition-colors text-sm">
                      {link.label}
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
