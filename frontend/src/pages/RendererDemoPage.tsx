import React from 'react';
import { useTranslation } from 'react-i18next';
import AgentOutputRenderer from '../components/agents/AgentOutputRenderer';
import { RiskItem, ComponentNode } from '../types/agent';

const dummyMarkdown = `
# Research Report: Stellar Network Status

This is a **bold** report on the status of the network.

## Key Metrics
- TPS: 150+
- Latency: < 5s
- Validator Count: 100+

Here is a [link to the explorer](https://stellar.expert).
`;

const dummyCode = `
import { Keypair } from '@stellar/stellar-sdk';

export function generateNewKeypair() {
  const pair = Keypair.random();
  console.log("Public Key:", pair.publicKey());
  return pair;
}
`;

const dummyRisks: RiskItem[] = [
  {
    likelihood: 5,
    impact: 5,
    description: 'Validator network outage due to coordination failure',
    mitigations: ['Run standby validators', 'Coordinate with SDF'],
    severity: 'critical',
  },
  {
    likelihood: 4,
    impact: 3,
    description: 'High tx fee spikes',
    mitigations: ['Optimize smart contract logic', 'Implement fee buffering'],
    severity: 'high',
  },
  {
    likelihood: 3,
    impact: 4,
    description: 'Oracle feed desynchronization',
    mitigations: ['Use multiple independent data feeds'],
    severity: 'medium',
  },
  {
    likelihood: 2,
    impact: 2,
    description: 'Minor front-end component alignment issues',
    mitigations: ['Establish design system library testing'],
    severity: 'low',
  },
  {
    likelihood: 5,
    impact: 1,
    description: 'Frequent non-critical console warnings in UI',
    mitigations: ['Clean up React warnings and strict-mode effects'],
    severity: 'medium',
  }
];

const dummyDesign = {
  palette: [
    { name: 'Dark Bg', hex: '#0f172a' },
    { name: 'Card Slate', hex: '#1e293b' },
    { name: 'Stellar Blue', hex: '#38bdf8' },
    { name: 'Green Alert', hex: '#10b981' },
    { name: 'Red Danger', hex: '#ef4444' }
  ],
  hierarchy: {
    name: 'AppShell',
    children: [
      {
        name: 'TopNav',
        children: [{ name: 'WalletConnect' }, { name: 'ThemeToggle' }]
      },
      {
        name: 'Dashboard',
        children: [
          { name: 'KpiGrid' },
          { name: 'RecentTasks' },
          { name: 'RiskMatrix' }
        ]
      }
    ]
  } as ComponentNode
};

const RendererDemoPage: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '30px' }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '10px' }}>{t('page.rendererDemo.title')}</h1>
      <p style={{ color: 'var(--text-secondary)' }}>{t('page.rendererDemo.subtitle')}</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '30px' }}>
        {/* Research */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--primary)' }}>{t('page.rendererDemo.research')}</h2>
          <AgentOutputRenderer agentType="research" result={dummyMarkdown} />
        </div>

        {/* Report */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--primary)' }}>{t('page.rendererDemo.report')}</h2>
          <AgentOutputRenderer agentType="report" result={dummyMarkdown} />
        </div>

        {/* Coding */}
        <div className="glass-panel" style={{ padding: '24px', gridColumn: 'span 2' }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--primary)' }}>{t('page.rendererDemo.coding')}</h2>
          <AgentOutputRenderer agentType="coding" result={{ code: dummyCode, language: 'typescript' }} />
        </div>

        {/* Risk */}
        <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--primary)', alignSelf: 'flex-start' }}>{t('page.rendererDemo.risk')}</h2>
          <AgentOutputRenderer agentType="risk" result={dummyRisks} />
        </div>

        {/* Design */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--primary)' }}>{t('page.rendererDemo.design')}</h2>
          <AgentOutputRenderer agentType="design" result={dummyDesign} />
        </div>

        {/* Null Result Placeholder */}
        <div className="glass-panel" style={{ padding: '24px', gridColumn: 'span 2' }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--primary)' }}>{t('page.rendererDemo.null')}</h2>
          <AgentOutputRenderer agentType="research" result={null} />
        </div>
      </div>
    </div>
  );
};

export default RendererDemoPage;
