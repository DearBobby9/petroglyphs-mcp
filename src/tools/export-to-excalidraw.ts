import { writeExport } from '../safe-export.js';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { store } from '../store.js';

interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  roughness: number;
  opacity: number;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  boundElements: null;
  updated: number;
  link: null;
  locked: boolean;
  [key: string]: unknown;
}

function strokesToExcalidraw(submission: import('../types.js').Submission): ExcalidrawElement[] {
  const strokes = submission.strokeMetadata.strokes;
  if (!strokes || strokes.length === 0) return [];

  return strokes.map((stroke) => {
    const points = stroke.points;
    const firstPoint = points[0];
    const x = firstPoint.x;
    const y = firstPoint.y;

    // Normalize points relative to first point
    const normalizedPoints = points.map((p) => [p.x - x, p.y - y]);
    const pressures = points.map((p) => p.pressure);

    // Calculate bounds
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    return {
      id: randomUUID(),
      type: 'freedraw',
      x,
      y,
      width,
      height,
      strokeColor: '#000000',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      roughness: 0,
      opacity: 100,
      seed: Math.floor(Math.random() * 2147483647),
      version: 1,
      versionNonce: Math.floor(Math.random() * 2147483647),
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
      points: normalizedPoints,
      pressures,
      simulatePressure: false,
      lastCommittedPoint: normalizedPoints[normalizedPoints.length - 1],
    };
  });
}

export function register(server: McpServer, sessionId: string): void {
  server.tool(
    'export_to_excalidraw',
    'Exports the latest handwriting strokes as an Excalidraw file (.excalidraw JSON)',
    {
      filename: z.string().optional().describe('Output filename without extension (default: petroglyphs-{timestamp})'),
    },
    async ({ filename }) => {
      const latest = store.getLatest(sessionId);
      if (!latest) {
        return {
          content: [{ type: 'text', text: 'No handwriting to export. The slate is empty.' }],
          isError: true,
        };
      }

      const elements = strokesToExcalidraw(latest);

      if (elements.length === 0) {
        return {
          content: [{ type: 'text', text: 'No stroke data available for Excalidraw export. The iPad app needs to send stroke point data for this feature.' }],
          isError: true,
        };
      }

      const doc = {
        type: 'excalidraw',
        version: 2,
        source: 'petroglyphs',
        elements,
        appState: {
          viewBackgroundColor: '#ffffff',
          gridSize: null,
        },
        files: {},
      };

      const outName = filename ?? `petroglyphs-${Date.now()}`;
      const outPath = await writeExport(config.exportPath, '', `${outName}.excalidraw`, JSON.stringify(doc, null, 2));

      return {
        content: [{ type: 'text', text: `Exported ${elements.length} stroke(s) to ${outPath}` }],
      };
    }
  );
}
