// Issue #724: Test fixtures for output renderers

export const codingFixtures = {
  normal: {
    code: 'function hello() {\n  console.log("Hello, world!");\n}',
    language: 'javascript',
    description: 'A simple greeting function',
  },
  malformed: {
    code: null,
    language: undefined,
    description: '',
  },
  empty: {
    code: '',
    language: '',
    description: '',
  },
  veryLong: {
    code: 'x'.repeat(100000),
    language: 'text',
    description: 'y'.repeat(10000),
  },
};

export const designFixtures = {
  normal: {
    imageUrl: 'https://example.com/design.png',
    title: 'Homepage Design',
    description: 'Modern landing page layout',
    dimensions: { width: 1920, height: 1080 },
  },
  malformed: {
    imageUrl: null,
    title: undefined,
    description: null,
  },
  empty: {
    imageUrl: '',
    title: '',
    description: '',
  },
  veryLong: {
    imageUrl: 'https://example.com/image.png',
    title: 'A'.repeat(1000),
    description: 'B'.repeat(50000),
  },
};

export const reportFixtures = {
  normal: {
    title: 'Q4 Analysis Report',
    sections: [
      { heading: 'Executive Summary', content: 'Key findings...' },
      { heading: 'Methodology', content: 'We analyzed...' },
    ],
    charts: [
      { type: 'bar', data: [10, 20, 30] },
    ],
  },
  malformed: {
    title: null,
    sections: undefined,
    charts: 'not-an-array',
  },
  empty: {
    title: '',
    sections: [],
    charts: [],
  },
  veryLong: {
    title: 'Report Title',
    sections: Array(1000).fill({ heading: 'Section', content: 'Content...' }),
    charts: [],
  },
};

export const researchFixtures = {
  normal: {
    topic: 'AI Ethics',
    findings: [
      'Finding 1: Bias detection is critical',
      'Finding 2: Transparency improves trust',
    ],
    sources: [
      { title: 'Paper A', url: 'https://example.com/a' },
      { title: 'Paper B', url: 'https://example.com/b' },
    ],
  },
  malformed: {
    topic: null,
    findings: 'not-an-array',
    sources: undefined,
  },
  empty: {
    topic: '',
    findings: [],
    sources: [],
  },
  veryLong: {
    topic: 'Long Research Topic',
    findings: Array(10000).fill('Finding...'),
    sources: Array(5000).fill({ title: 'Source', url: 'https://example.com' }),
  },
};

export const riskFixtures = {
  normal: {
    riskLevel: 'medium',
    factors: [
      { name: 'Market volatility', score: 6 },
      { name: 'Regulatory changes', score: 4 },
    ],
    mitigation: [
      'Diversify portfolio',
      'Monitor regulations',
    ],
  },
  malformed: {
    riskLevel: null,
    factors: 'invalid',
    mitigation: undefined,
  },
  empty: {
    riskLevel: '',
    factors: [],
    mitigation: [],
  },
  veryLong: {
    riskLevel: 'high',
    factors: Array(1000).fill({ name: 'Factor', score: 5 }),
    mitigation: Array(1000).fill('Mitigation strategy...'),
  },
};
