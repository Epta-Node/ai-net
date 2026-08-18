import React from 'react'
import { Link } from 'react-router-dom'
import { Github, Twitter, MessageCircle, Heart } from 'lucide-react'

const GITHUB_URL = 'https://github.com/Epta-Node/ai-net'
const TWITTER_URL = 'https://x.com/GuildNet_'
const DOCS_URL = 'https://docs.google.com/document/d/1yGcTxu5hSBiaxoAWKKxC-TdH3OdKgRYL/edit?usp=sharing&ouid=107270187144083702546&rtpof=true&sd=true'

const footerLinks = [
  {
    label: 'Product',
    links: [
      { label: 'Dashboard', to: '/dashboard', external: false },
      { label: 'Agents', to: '/agents', external: false },
      { label: 'Tasks', to: '/tasks/new', external: false },
      { label: 'Builder', to: '#', external: false },
    ],
  },
  {
    label: 'Resources',
    links: [
      { label: 'Documentation', to: DOCS_URL, external: true },
      { label: 'API Reference', to: '#', external: false },
      { label: 'Status', to: '#', external: false },
      { label: 'Changelog', to: '#', external: false },
    ],
  },
  {
    label: 'Community',
    links: [
      { label: 'GitHub', to: GITHUB_URL, external: true },
      { label: 'Twitter', to: TWITTER_URL, external: true },
      { label: 'Discord', to: '#', external: false },
      { label: 'Blog', to: '#', external: false },
    ],
  },
]

const Footer: React.FC = () => {
  const renderLink = (link: { label: string; to: string; external: boolean }) => {
    if (link.external) {
      return (
        <a
          href={link.to}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] text-text-secondary/60 hover:text-text-primary transition-colors"
        >
          {link.label}
        </a>
      )
    }
    if (link.to === '#') {
      return (
        <span className="text-[13px] text-text-secondary/30 cursor-not-allowed">
          {link.label}
        </span>
      )
    }
    return (
      <Link
        to={link.to}
        className="text-[13px] text-text-secondary/60 hover:text-text-primary transition-colors"
      >
        {link.label}
      </Link>
    )
  }

  return (
    <footer className="border-t border-border-subtle bg-background-primary">
      <div className="max-w-[1000px] mx-auto px-4 py-16">
        {/* Top row: brand + link columns */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 mb-12">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <Link to="/" className="flex items-center gap-2.5 mb-3">
              <div className="w-[28px] h-[28px] rounded-[7px] bg-gradient-primary flex items-center justify-center font-bold text-white text-sm shadow-[0_0_12px_rgba(56,189,248,0.3)]">
                a
              </div>
              <span className="font-bold text-[15px] text-text-primary tracking-wide">ai-net</span>
            </Link>
            <p className="text-[13px] text-text-secondary/60 leading-relaxed max-w-[220px]">
              Autonomous AI agents that hire, collaborate, and pay each other on-chain.
            </p>
          </div>

          {/* Link columns */}
          {footerLinks.map((group) => (
            <div key={group.label}>
              <h4 className="text-[11px] font-bold text-text-secondary uppercase tracking-[0.12em] mb-4">
                {group.label}
              </h4>
              <ul className="flex flex-col gap-2.5">
                {group.links.map((link) => (
                  <li key={link.label}>{renderLink(link)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Divider */}
        <div className="h-px bg-border-subtle mb-6" />

        {/* Bottom row: copyright + socials */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-[12px] text-text-secondary/40 flex items-center gap-1">
            &copy; {new Date().getFullYear()} ai-net. Built with <Heart size={11} className="text-accent-purple" /> on Stellar &amp; Soroban.
          </p>
          <div className="flex items-center gap-4">
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub" className="text-text-secondary/40 hover:text-text-primary transition-colors">
              <Github size={16} />
            </a>
            <a href={TWITTER_URL} target="_blank" rel="noopener noreferrer" aria-label="Twitter" className="text-text-secondary/40 hover:text-text-primary transition-colors">
              <Twitter size={16} />
            </a>
            <a href="#" aria-label="Discord" className="text-text-secondary/40 hover:text-text-primary transition-colors">
              <MessageCircle size={16} />
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}

export default Footer
