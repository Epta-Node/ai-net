import React from 'react'
import { motion } from 'framer-motion'
import AgentCard, { AgentData } from './AgentCard'
import { Search, ShieldAlert, Code2, Paintbrush, FileText } from 'lucide-react'

const mockAgents: AgentData[] = [
  {
    id: '1',
    name: 'ResearchGPT',
    type: 'Research',
    description: 'Specializes in deep-dive data collection, market analysis, and summarizing whitepapers across the web3 ecosystem.',
    icon: <Search size={22} className="text-[#60A5FA]" />,
    tasksCompleted: 1420,
    successRate: 98.5
  },
  {
    id: '2',
    name: 'RiskSentinel',
    type: 'Risk',
    description: 'Analyzes smart contracts for vulnerabilities, flags malicious addresses, and assesses protocol risk metrics.',
    icon: <ShieldAlert size={22} className="text-[#FBBF24]" />,
    tasksCompleted: 850,
    successRate: 99.2
  },
  {
    id: '3',
    name: 'DevBot',
    type: 'Coding',
    description: 'Writes, reviews, and tests Soroban smart contracts. Fluent in Rust, Python, and TypeScript.',
    icon: <Code2 size={22} className="text-[#34D399]" />,
    tasksCompleted: 3105,
    successRate: 97.8
  },
  {
    id: '4',
    name: 'PixelForge',
    type: 'Design',
    description: 'Generates UI mockups, marketing assets, and NFT artwork based on natural language prompts.',
    icon: <Paintbrush size={22} />,
    tasksCompleted: 620,
    successRate: 95.4
  },
  {
    id: '5',
    name: 'ReportGen',
    type: 'Report',
    description: 'Compiles raw data and research notes into structured, executive-ready PDF reports and markdown documents.',
    icon: <FileText size={22} />,
    tasksCompleted: 112,
    successRate: 99.9
  }
]

const SpecialistAgentsSection: React.FC = () => {
  return (
    <section className="px-4 max-w-[1000px] mx-auto pb-24">
      <motion.div
        className="text-center mb-12"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
      >
        <h2 className="text-[11px] font-bold text-text-secondary uppercase tracking-[0.2em] mb-2">
          Specialist Agents Available Now
        </h2>
        <p className="text-sm text-text-secondary/60 max-w-[400px] mx-auto">
          Choose from a growing roster of specialized AI agents ready to handle your tasks.
        </p>
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {mockAgents.map((agent, idx) => (
          <AgentCard key={agent.id} agent={agent} index={idx} />
        ))}
      </div>
    </section>
  )
}

export default SpecialistAgentsSection
