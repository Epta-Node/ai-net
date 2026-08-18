import React, { useState } from 'react'
import { motion } from 'framer-motion'
import Navbar from '../components/landing/Navbar'
import Sidebar from '../components/landing/Sidebar'
import Hero from '../components/landing/Hero'
import StatsBar from '../components/landing/StatsBar'
import SpecialistAgentsSection from '../components/landing/SpecialistAgentsSection'
import Footer from '../components/landing/Footer'

const LandingPage: React.FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  return (
    <div className="min-h-screen bg-background-primary text-text-primary font-sans flex relative overflow-x-hidden">
      {/* Background Orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -right-40 w-[600px] h-[600px] rounded-full bg-accent-cyan/5 blur-[120px]" />
        <div className="absolute -bottom-40 -left-40 w-[500px] h-[500px] rounded-full bg-accent-purple/5 blur-[120px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full bg-accent-cyan/3 blur-[150px]" />
      </div>

      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((prev) => !prev)}
      />

      <motion.div
        className="flex-1 flex flex-col relative z-10"
        animate={{ marginLeft: sidebarCollapsed ? 0 : 200 }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
      >
        <Navbar />

        <motion.main
          className="flex-1 w-full relative z-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
        >
          <Hero />
          <StatsBar />
          <SpecialistAgentsSection />
          <Footer />
        </motion.main>
      </motion.div>
    </div>
  )
}

export default LandingPage
