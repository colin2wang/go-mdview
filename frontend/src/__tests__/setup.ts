import { vi } from 'vitest'

// mindmap.ts creates a Ruler at module load and calls getContext('2d');
// jsdom has no canvas and would log "Not implemented" noise to console.
// Returning null lets Ruler take the plain-text heuristic branch, not affecting tested logic.
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as typeof HTMLCanvasElement.prototype.getContext
