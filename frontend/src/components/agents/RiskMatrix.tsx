import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RiskItem, RiskResult } from '../../types/agent';
import { getRisksList } from '../../utils/agentUtils';

interface Props {
  result: RiskResult | null | undefined;
}

export function getCellSeverity(likelihood: number, impact: number): 'low' | 'medium' | 'high' | 'critical' {
  const score = likelihood * impact;
  if (score >= 15) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

const severityColors = {
  low: 'var(--status-success)',      // Emerald Green
  medium: 'var(--status-warning-strong)',   // Amber Yellow
  high: 'var(--status-warning)',     // Orange
  critical: 'var(--status-danger)', // Red
};

const heatmapColors = {
  low: 'var(--status-success-surface-muted)',
  medium: 'var(--status-warning-surface-muted)',
  high: 'var(--status-warning-surface)',
  critical: 'var(--status-danger-surface-strong)',
};

const RiskMatrix: React.FC<Props> = ({ result }) => {
  const { t } = useTranslation();
  const risks = getRisksList(result);
  const [hoveredRisk, setHoveredRisk] = useState<{ risk: RiskItem; cx: number; cy: number; index: number } | null>(null);

  if (!risks || risks.length === 0) {
    return (
      <div
        className="empty-state"
        id="empty-risk"
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          background: 'var(--white-alpha-02)',
          borderRadius: 'var(--radius-lg)',
          border: '1px dashed var(--white-alpha-10)',
        }}
      >
        {t('agent.risk.empty')}
      </div>
    );
  }

  // SVG dimensions
  const svgWidth = 500;
  const svgHeight = 500;
  const gridPaddingLeft = 60;
  const gridPaddingBottom = 60;
  const gridPaddingTop = 20;
  const gridPaddingRight = 20;
  
  const gridWidth = svgWidth - gridPaddingLeft - gridPaddingRight;
  const gridHeight = svgHeight - gridPaddingTop - gridPaddingBottom;
  const cellSize = gridWidth / 5; // 420 / 5 = 84px per cell

  // Map of cells with their counts of dots to apply jitter
  const cellCounts: Record<string, number> = {};

  return (
    <div
      className="risk-matrix-wrapper"
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: '500px',
        margin: '0 auto',
        userSelect: 'none',
      }}
    >
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        style={{
          width: '100%',
          height: 'auto',
          backgroundColor: 'var(--surface-black-subtle)',
          borderRadius: 'var(--radius-xl)',
          border: '1px solid var(--white-alpha-05)',
        }}
        id="risk-matrix-svg"
      >
        {/* Heatmap Cell Rectangles */}
        {Array.from({ length: 5 }).map((_, rIdx) => {
          const likelihood = 5 - rIdx;
          const y = gridPaddingTop + rIdx * cellSize;

          return Array.from({ length: 5 }).map((__, cIdx) => {
            const impact = cIdx + 1;
            const x = gridPaddingLeft + cIdx * cellSize;
            const severity = getCellSeverity(likelihood, impact);
            const fillColor = heatmapColors[severity];

            return (
              <rect
                key={`cell-${likelihood}-${impact}`}
                x={x}
                y={y}
                width={cellSize}
                height={cellSize}
                fill={fillColor}
                stroke="var(--white-alpha-05)"
                strokeWidth="1"
                className="risk-cell"
                data-testid={`risk-cell-${likelihood}-${impact}`}
              />
            );
          });
        })}

        {/* Outer border of grid */}
        <rect
          x={gridPaddingLeft}
          y={gridPaddingTop}
          width={gridWidth}
          height={gridHeight}
          fill="none"
          stroke="var(--white-alpha-15)"
          strokeWidth="1.5"
        />

        {/* Y Axis Labels (Likelihood) */}
        {Array.from({ length: 5 }).map((_, idx) => {
          const likelihood = 5 - idx;
          const yCenter = gridPaddingTop + idx * cellSize + cellSize / 2;
          return (
            <text
              key={`label-y-${likelihood}`}
              x={gridPaddingLeft - 12}
              y={yCenter}
              fill="var(--text-secondary)"
              fontSize="12"
              textAnchor="end"
              alignmentBaseline="middle"
              style={{ fontWeight: 500 }}
            >
              {likelihood}
            </text>
          );
        })}

        {/* X Axis Labels (Impact) */}
        {Array.from({ length: 5 }).map((_, idx) => {
          const impact = idx + 1;
          const xCenter = gridPaddingLeft + idx * cellSize + cellSize / 2;
          return (
            <text
              key={`label-x-${impact}`}
              x={xCenter}
              y={svgHeight - gridPaddingBottom + 18}
              fill="var(--text-secondary)"
              fontSize="12"
              textAnchor="middle"
              style={{ fontWeight: 500 }}
            >
              {impact}
            </text>
          );
        })}

        {/* Axis Titles */}
        <text
          x={gridPaddingLeft + gridWidth / 2}
          y={svgHeight - 15}
          fill="var(--text-primary)"
          fontSize="14"
          textAnchor="middle"
          style={{ fontWeight: 600, letterSpacing: '0.05em' }}
        >
          {t('agent.risk.axisImpact')}
        </text>

        <text
          transform={`rotate(-90, 18, ${gridPaddingTop + gridHeight / 2})`}
          x={18}
          y={gridPaddingTop + gridHeight / 2}
          fill="var(--text-primary)"
          fontSize="14"
          textAnchor="middle"
          style={{ fontWeight: 600, letterSpacing: '0.05em' }}
        >
          {t('agent.risk.axisLikelihood')}
        </text>

        {/* Plotted Risk Dots */}
        {risks.map((risk, index) => {
          const L = Math.min(5, Math.max(1, risk.likelihood));
          const I = Math.min(5, Math.max(1, risk.impact));
          
          const cellKey = `${L}-${I}`;
          const currentCountInCell = cellCounts[cellKey] || 0;
          cellCounts[cellKey] = currentCountInCell + 1;

          // Calculate center of target cell
          const cellXStart = gridPaddingLeft + (I - 1) * cellSize;
          const cellYStart = gridPaddingTop + (5 - L) * cellSize;
          
          const baseCx = cellXStart + cellSize / 2;
          const baseCy = cellYStart + cellSize / 2;

          // Apply Jitter offset if there are multiple dots in the same cell
          let offsetX = 0;
          let offsetY = 0;
          if (currentCountInCell > 0) {
            // spiral jitter pattern
            const angle = (currentCountInCell * 137.5) * (Math.PI / 180);
            const radius = Math.min(cellSize * 0.25, 12 + Math.floor(currentCountInCell / 4) * 4);
            offsetX = Math.cos(angle) * radius;
            offsetY = Math.sin(angle) * radius;
          }

          const cx = baseCx + offsetX;
          const cy = baseCy + offsetY;

          const severity = risk.severity || getCellSeverity(L, I);
          const color = severityColors[severity] || severityColors.low;

          return (
            <g
              key={`risk-group-${index}`}
              className="risk-point"
              tabIndex={0}
              role="img"
              aria-label={`${risk.description}. Likelihood ${L}, impact ${I}, severity ${severity}.`}
              aria-describedby={hoveredRisk?.index === index ? 'risk-tooltip' : undefined}
              onFocus={() => setHoveredRisk({ risk, cx, cy, index })}
              onBlur={() => setHoveredRisk(null)}
            >
              {/* Outer glow ring */}
              <circle
                cx={cx}
                cy={cy}
                r="10"
                fill="none"
                stroke={color}
                strokeWidth="1.5"
                opacity="0.3"
                style={{ transition: 'all 0.2s ease' }}
              />
              {/* Solid dot */}
              <circle
                cx={cx}
                cy={cy}
                r="6"
                fill={color}
                className="risk-dot"
                data-testid={`risk-dot-${index}`}
                style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
                onMouseEnter={() => setHoveredRisk({ risk, cx, cy, index })}
                onMouseLeave={() => setHoveredRisk(null)}
              />
            </g>
          );
        })}
      </svg>

      {/* Hover Tooltip Overlay */}
      {hoveredRisk && (
        <div
          id="risk-tooltip"
          data-testid="risk-tooltip"
          role="tooltip"
          style={{
            position: 'absolute',
            top: `${(hoveredRisk.cy / svgHeight) * 100}%`,
            left: `${(hoveredRisk.cx / svgWidth) * 100}%`,
            transform: 'translate(-50%, -100%) translateY(-12px)',
            backgroundColor: 'var(--surface-canvas)',
            color: 'var(--text-primary)',
            border: `1px solid ${severityColors[hoveredRisk.risk.severity || getCellSeverity(hoveredRisk.risk.likelihood, hoveredRisk.risk.impact)]}`,
            borderRadius: 'var(--radius-md)',
            padding: '10px 14px',
            fontSize: '0.8rem',
            width: '200px',
            boxShadow: 'var(--shadow-sm)',
            zIndex: 100,
            pointerEvents: 'none',
            lineHeight: '1.4',
            transition: 'opacity 0.15s ease',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>
            {hoveredRisk.risk.description}
          </div>
          {hoveredRisk.risk.mitigations && hoveredRisk.risk.mitigations.length > 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', borderTop: '1px solid var(--white-alpha-10)', paddingTop: '4px', marginTop: '4px' }}>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{t('agent.risk.mitigation')}</span>
              {hoveredRisk.risk.mitigations[0]}
            </div>
          )}
          {/* Arrow */}
          <div
            style={{
              position: 'absolute',
              bottom: '-6px',
              left: '50%',
              transform: 'translateX(-50%) rotate(45deg)',
              width: '10px',
              height: '10px',
              backgroundColor: 'var(--surface-canvas)',
              borderBottom: `1px solid ${severityColors[hoveredRisk.risk.severity || getCellSeverity(hoveredRisk.risk.likelihood, hoveredRisk.risk.impact)]}`,
              borderRight: `1px solid ${severityColors[hoveredRisk.risk.severity || getCellSeverity(hoveredRisk.risk.likelihood, hoveredRisk.risk.impact)]}`,
            }}
          />
        </div>
      )}
    </div>
  );
};

export default RiskMatrix;
