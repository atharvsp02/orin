import { CirclePower } from "lucide-react"

export function Footer() {
  const columns: Record<string, Array<{ label: string; href: string; external?: boolean }>> = {
    Product: [
      { label: "Product", href: "/#product" },
      { label: "How it works", href: "/#how-it-works" },
      { label: "Integrations", href: "/#integrations" },
      { label: "Agents", href: "/#agents" },
    ],
    "Get started": [
      { label: "Dashboard", href: "/dashboard" },
      { label: "GitHub App", href: "https://github.com/apps/orinbot", external: true },
    ],
  }

  return (
    <footer className="border-t border-zinc-800 py-14 px-6" style={{ backgroundColor: "#09090B" }}>
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-10">
          {/* Brand */}
          <div className="max-w-xs">
            <div className="flex items-center gap-2">
              <CirclePower className="w-5 h-5 text-white" />
              <span className="text-white font-semibold">Orin</span>
            </div>
            <p className="text-zinc-500 text-sm mt-3 leading-relaxed">
              Institutional memory for engineering teams. Remember every decision, catch the ones you are about to repeat.
            </p>
          </div>

          {/* Links */}
          <div className="flex gap-16">
            {Object.entries(columns).map(([category, links]) => (
              <div key={category}>
                <h3 className="text-white font-medium text-sm mb-4">{category}</h3>
                <ul className="space-y-3">
                  {links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
                        className="text-zinc-500 hover:text-zinc-300 transition-colors text-sm"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-zinc-800/60 mt-12 pt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-zinc-600 text-xs">© 2026 Orin</p>
          <a
            href="https://www.cognee.ai"
            target="_blank"
            rel="noreferrer"
            className="text-zinc-600 hover:text-zinc-400 transition-colors text-xs"
          >
            Built on self-hosted Cognee
          </a>
        </div>
      </div>
    </footer>
  )
}
