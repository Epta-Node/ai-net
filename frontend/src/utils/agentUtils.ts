import {
  ResearchReportResult,
  CodingResult,
  RiskResult,
  RiskItem,
  DesignResult,
  DesignColor,
  ComponentNode
} from '../types/agent';

export interface ExtractedImage {
  url: string;
  title?: string;
  alt?: string;
}

export function getMarkdown(result: ResearchReportResult | null | undefined): string | null {
  if (!result) return null;
  if (typeof result === 'string') return result;

  if (result.markdown) return result.markdown;
  if (result.content) return result.content;
  
  if (result.summary) {
    let md = `## Summary\n${result.summary}\n\n`;
    if (result.keyFindings && result.keyFindings.length > 0) {
      md += `### Key Findings\n`;
      result.keyFindings.forEach((finding) => {
        md += `- ${finding}\n`;
      });
      md += `\n`;
    }
    if (result.sources && result.sources.length > 0) {
      md += `### Sources\n`;
      result.sources.forEach((source) => {
        md += `- [${source.title}](${source.url})\n`;
      });
    }
    return md;
  }
  return null;
}

export function getCodeDetails(result: CodingResult | null | undefined): { code: string; language: string } | null {
  if (!result) return null;
  if (typeof result === 'string') {
    return { code: result, language: 'javascript' };
  }
  if (result.code) {
    return { code: result.code, language: result.language || 'javascript' };
  }
  return null;
}

export function getRisksList(result: RiskResult | null | undefined): RiskItem[] | null {
  if (!result) return null;
  if (Array.isArray(result)) return result;
  if (result.risks && Array.isArray(result.risks)) return result.risks;
  return null;
}

export function getDesignDetails(result: DesignResult | null | undefined): {
  colors: DesignColor[];
  hierarchy: ComponentNode | null;
  images: ExtractedImage[];
} | null {
  if (!result) return null;

  const colorsList: DesignColor[] = [];
  const rawColors = result.colors || result.palette;
  if (Array.isArray(rawColors)) {
    rawColors.forEach((c) => {
      if (typeof c === 'string') {
        colorsList.push({ name: c, hex: c, value: c });
      } else if (c && typeof c === 'object') {
        const hexVal = c.hex || c.value || '';
        colorsList.push({
          name: c.name || hexVal,
          hex: hexVal,
          value: hexVal
        });
      }
    });
  }

  const hierarchy = result.hierarchy || result.components || null;

  const imagesList: ExtractedImage[] = [];
  const rawImageSources = [
    ...(Array.isArray(result.images) ? result.images : []),
    ...(Array.isArray(result.mockups) ? result.mockups : []),
    ...(Array.isArray(result.wireframes) ? result.wireframes : [])
  ];

  rawImageSources.forEach((img, idx) => {
    if (typeof img === 'string') {
      imagesList.push({
        url: img,
        title: `Design Output #${idx + 1}`,
        alt: `Design image ${idx + 1}`
      });
    } else if (img && typeof img === 'object') {
      const url = img.url || img.src || img.image || '';
      if (url) {
        imagesList.push({
          url,
          title: img.title || img.name || img.description || `Design Output #${idx + 1}`,
          alt: img.alt || img.description || img.name || `Design image ${idx + 1}`
        });
      }
    }
  });

  return {
    colors: colorsList,
    hierarchy,
    images: imagesList
  };
}
