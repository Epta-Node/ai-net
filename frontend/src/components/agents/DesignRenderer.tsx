import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DesignResult, ComponentNode } from '../../types/agent';
import { getDesignDetails } from '../../utils/agentUtils';
import { useLightbox } from '../../hooks/useLightbox';
import ImageLightbox from '../common/ImageLightbox';
import { Maximize2 } from 'lucide-react';

interface Props {
  result: DesignResult | null | undefined;
}

// Collapsible Tree Node Component
const TreeNode: React.FC<{ node: ComponentNode; depth: number }> = ({ node, depth }) => {
  const [isOpen, setIsOpen] = useState(true);
  const hasChildren = node.children && node.children.length > 0;

  const toggle = () => {
    if (hasChildren) {
      setIsOpen(!isOpen);
    }
  };

  return (
    <div className="tree-node-wrapper" style={{ margin: '4px 0' }}>
      <div
        className="tree-node-header"
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 10px',
          borderRadius: '6px',
          cursor: hasChildren ? 'pointer' : 'default',
          backgroundColor: 'var(--white-alpha-02)',
          transition: 'background-color 0.2s ease',
          fontSize: '0.9rem',
          userSelect: 'none',
        }}
        onMouseEnter={(e) => {
          if (hasChildren) e.currentTarget.style.backgroundColor = 'var(--white-alpha-05)';
        }}
        onMouseLeave={(e) => {
          if (hasChildren) e.currentTarget.style.backgroundColor = 'var(--white-alpha-02)';
        }}
      >
        {hasChildren ? (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', transition: 'transform 0.2s ease', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }}>
            ▶
          </span>
        ) : (
          <span style={{ fontSize: '0.75rem', color: 'var(--white-alpha-15)' }}>●</span>
        )}
        <span style={{ color: 'var(--white-alpha-30)', fontFamily: 'monospace', fontSize: '0.8rem' }}>&lt;</span>
        <span style={{ fontWeight: 600, color: hasChildren ? 'var(--accent-info)' : 'var(--text-primary)' }}>{node.name}</span>
        <span style={{ color: 'var(--white-alpha-30)', fontFamily: 'monospace', fontSize: '0.8rem' }}>/&gt;</span>
      </div>

      {hasChildren && isOpen && (
        <div
          className="tree-node-children"
          style={{
            borderLeft: '1px solid var(--white-alpha-08)',
            marginLeft: '18px',
            paddingLeft: '12px',
          }}
        >
          {node.children!.map((child, idx) => (
            <TreeNode key={`${child.name}-${idx}`} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

const DesignRenderer: React.FC<Props> = ({ result }) => {
  const { t } = useTranslation();
  const details = getDesignDetails(result);
  const [copiedColor, setCopiedColor] = useState<string | null>(null);
  const lightbox = useLightbox();

  if (!details || (details.colors.length === 0 && !details.hierarchy && details.images.length === 0)) {
    return (
      <div
        className="empty-state"
        id="empty-design"
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          background: 'var(--white-alpha-02)',
          borderRadius: 'var(--radius-lg)',
          border: '1px dashed var(--white-alpha-10)',
        }}
      >
        {t('agent.design.empty')}
      </div>
    );
  }

  const handleCopyColor = async (hex: string) => {
    try {
      await navigator.clipboard.writeText(hex);
      setCopiedColor(hex);
      setTimeout(() => setCopiedColor(null), 1500);
    } catch (err) {
      console.error('Failed to copy hex', err);
    }
  };

  return (
    <div className="design-renderer" id="design-output">
      {/* Design Outputs & Wireframes Gallery */}
      {details.images.length > 0 && (
        <div style={{ marginBottom: '32px' }} data-testid="design-images-gallery">
          <h4 style={{ marginBottom: '14px', color: 'var(--text-secondary)', fontSize: '0.9rem', fontWeight: 600 }}>
            {t('agent.design.outputsTitle', { total: details.images.length })}
          </h4>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '16px',
            }}
          >
            {details.images.map((img, idx) => (
              <div
                key={`design-img-${idx}`}
                onClick={() => lightbox.openLightbox(details.images, idx)}
                style={{
                  position: 'relative',
                  backgroundColor: 'var(--surface-hover-subtle)',
                  border: '1px solid var(--white-alpha-08)',
                  borderRadius: 'var(--radius-xl)',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
                className="design-image-card"
                data-testid={`design-image-card-${idx}`}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.borderColor = 'var(--info-border)';
                  e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'none';
                  e.currentTarget.style.borderColor = 'var(--white-alpha-08)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <div style={{ position: 'relative', height: '160px', overflow: 'hidden', backgroundColor: 'var(--surface-black)' }}>
                  <img
                    src={img.url}
                    alt={img.alt || img.title || t('a11y.designOutput', { index: idx + 1 })}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      top: '8px',
                      right: '8px',
                      background: 'var(--surface-scrim)',
                      backdropFilter: 'blur(4px)',
                      borderRadius: 'var(--radius-md)',
                      padding: '4px 8px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      color: 'var(--text-inverse)',
                      fontSize: '0.75rem',
                    }}
                  >
                    <Maximize2 size={12} />
                    <span>{t('common.expand')}</span>
                  </div>
                </div>
                {img.title && (
                  <div style={{ padding: '10px 12px', fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                    {img.title}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Color Palette Swatches */}
      {details.colors.length > 0 && (
        <div style={{ marginBottom: '32px' }}>
          <h4 style={{ marginBottom: '14px', color: 'var(--text-secondary)', fontSize: '0.9rem', fontWeight: 600 }}>{t('agent.design.colorPalette')}</h4>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
              gap: '12px',
            }}
          >
            {details.colors.map((color, idx) => {
              const hexVal = color.hex || color.value || '#000000';
              const nameVal = color.name || hexVal;
              const isCopied = copiedColor === hexVal;

              return (
                <div
                  key={`color-${idx}`}
                  onClick={() => handleCopyColor(hexVal)}
                  style={{
                    backgroundColor: 'var(--surface-hover-subtle)',
                    border: '1px solid var(--white-alpha-05)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '8px',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    textAlign: 'center',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.borderColor = 'var(--white-alpha-15)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'none';
                    e.currentTarget.style.borderColor = 'var(--white-alpha-05)';
                  }}
                >
                  <div
                    style={{
                      height: '50px',
                      backgroundColor: hexVal,
                      borderRadius: 'var(--radius-md)',
                      marginBottom: '8px',
                      border: '1px solid var(--white-alpha-10)',
                    }}
                  />
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', color: 'var(--text-inverse)' }}>
                    {nameVal}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: isCopied ? 'var(--status-success)' : 'var(--text-secondary)', marginTop: '2px', fontFamily: 'monospace' }}>
                    {isCopied ? t('agent.design.copied') : hexVal}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Collapsible Component Hierarchy Tree */}
      {details.hierarchy && (
        <div>
          <h4 style={{ marginBottom: '14px', color: 'var(--text-secondary)', fontSize: '0.9rem', fontWeight: 600 }}>{t('agent.design.hierarchy')}</h4>
          <div
            style={{
              padding: '16px',
              backgroundColor: 'var(--surface-black-subtle)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--white-alpha-05)',
              overflowX: 'auto',
            }}
          >
            <TreeNode node={details.hierarchy} depth={0} />
          </div>
        </div>
      )}

      {/* Lightbox Component */}
      <ImageLightbox
        isOpen={lightbox.isOpen}
        images={lightbox.images}
        currentIndex={lightbox.currentIndex}
        scale={lightbox.scale}
        position={lightbox.position}
        onClose={lightbox.closeLightbox}
        onPrev={lightbox.prevImage}
        onNext={lightbox.nextImage}
        onSelectIndex={lightbox.setIndex}
        onZoomIn={lightbox.zoomIn}
        onZoomOut={lightbox.zoomOut}
        onResetZoom={lightbox.resetZoom}
        onWheel={lightbox.handleWheel}
        onPinch={lightbox.handlePinch}
        onPositionChange={lightbox.setPosition}
      />
    </div>
  );
};

export default DesignRenderer;
