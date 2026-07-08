"use client"

import Image from "next/image"
import { motion } from "framer-motion"
import { Slack } from "lucide-react"
import { SiGithub, SiLinear, SiVscodium } from "@icons-pack/react-simple-icons"
import { Claude, Cursor, DeepSeek, OpenAI } from "@lobehub/icons"

export function LogoCloud() {
  return (
    <div className="relative z-20 pb-24 pt-8" style={{ backgroundColor: "#09090B" }}>
      <div className="w-full flex justify-center px-6">
        <div className="w-full max-w-4xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="flex items-center justify-center gap-2 mb-8"
          >
            <span className="text-base text-zinc-500">Powered by</span>
            <Image
              src="/cognee-logo-white.svg"
              alt="Cognee"
              width={120}
              height={35}
              className="h-7 w-auto opacity-80"
            />
          </motion.div>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-lg text-zinc-300 mb-2"
          >
            One memory across every tool your team uses.
          </motion.p>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-lg text-zinc-500 mb-16"
          >
            GitHub, Slack, Linear, and any MCP-capable agent.
          </motion.p>

          <motion.a
            href="/#integrations"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="relative group cursor-pointer block"
          >
            {/* Logo grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-16 gap-y-10 items-center justify-items-center transition-all duration-300 group-hover:blur-[2.5px] group-hover:opacity-50">
              {[
                { name: "GitHub", Icon: SiGithub },
                { name: "Slack", Icon: Slack },
                { name: "Linear", Icon: SiLinear },
                { name: "Cursor", Icon: Cursor },
                { name: "Claude Code", Icon: Claude },
                { name: "VS Code", Icon: SiVscodium },
                { name: "DeepSeek", Icon: DeepSeek },
                { name: "Codex", Icon: OpenAI },
              ].map(({ name, Icon }) => (
                <div key={name} className="text-white font-semibold text-xl flex items-center gap-2">
                  <Icon className="w-5 h-5" />
                  {name}
                </div>
              ))}
            </div>

            {/* Hover overlay button */}
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
              <div className="px-5 py-2.5 bg-zinc-800/80 backdrop-blur-sm border border-zinc-700 rounded-full text-sm text-zinc-300 flex items-center gap-2">
                See all integrations
                <span aria-hidden="true">›</span>
              </div>
            </div>
          </motion.a>
        </div>
      </div>
    </div>
  )
}
