import { CSSProperties } from 'react'

export type VisualElementKey =
  | 'navLogo'
  | 'sourceTabs'
  | 'headerTools'
  | 'menuContent'
  | 'menuGuitar'
  | 'studioIndex'
  | 'studioGuitar'
  | 'studioContent'
  | 'uploadPanel'
  | 'youtubePanel'
  | 'livePanel'
  | 'reportHeader'
  | 'reportSummary'
  | 'reportScore'

export interface VisualTransform {
  x: number
  y: number
  scale: number
  rotation: number
  zIndex: number
}

export type VisualConfig = Record<VisualElementKey, VisualTransform>

export const VISUAL_ELEMENT_LABELS: Record<VisualElementKey, string> = {
  navLogo: 'Navigation logo',
  sourceTabs: 'Source tabs',
  headerTools: 'Header account',
  menuContent: 'Menu content',
  menuGuitar: 'Menu guitar',
  studioIndex: 'Studio number',
  studioGuitar: 'Studio guitar',
  studioContent: 'Studio controls',
  uploadPanel: 'File panel',
  youtubePanel: 'YouTube panel',
  livePanel: 'Live panel',
  reportHeader: 'Report header',
  reportSummary: 'Report metrics',
  reportScore: 'Report score',
}

export const DEFAULT_VISUAL_CONFIG: VisualConfig = {
  navLogo: { x: 0, y: 0, scale: 1.15, rotation: 0, zIndex: 10 },
  sourceTabs: { x: 0, y: 0, scale: 1, rotation: 0, zIndex: 10 },
  headerTools: { x: 0, y: 0, scale: 1, rotation: 0, zIndex: 12 },
  menuContent: { x: -14, y: 0, scale: 1, rotation: 0, zIndex: 2 },
  menuGuitar: { x: 0, y: 0, scale: 1, rotation: 0, zIndex: 1 },
  studioIndex: { x: 0, y: 0, scale: 1, rotation: 0, zIndex: 0 },
  studioGuitar: { x: 0, y: 0, scale: 1.08, rotation: -20, zIndex: 1 },
  studioContent: { x: 0, y: 0, scale: 1, rotation: 0, zIndex: 2 },
  uploadPanel: { x: 190, y: 0, scale: 1, rotation: 0, zIndex: 2 },
  youtubePanel: { x: 190, y: 0, scale: 1, rotation: 0, zIndex: 2 },
  livePanel: { x: 190, y: 0, scale: 1, rotation: 0, zIndex: 2 },
  reportHeader: { x: 0, y: 0, scale: 1, rotation: 0, zIndex: 2 },
  reportSummary: { x: 0, y: 0, scale: 1, rotation: 0, zIndex: 2 },
  reportScore: { x: 0, y: 0, scale: 1, rotation: 0, zIndex: 2 },
}

export function visualStyle(transform: VisualTransform): CSSProperties {
  return {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
    zIndex: transform.zIndex,
  }
}

export function mergeVisualConfig(value: unknown): VisualConfig {
  if (!value || typeof value !== 'object') return DEFAULT_VISUAL_CONFIG
  const stored = value as Partial<VisualConfig>
  return Object.fromEntries(
    Object.entries(DEFAULT_VISUAL_CONFIG).map(([key, defaults]) => [
      key,
      { ...defaults, ...(stored[key as VisualElementKey] || {}) },
    ]),
  ) as VisualConfig
}
