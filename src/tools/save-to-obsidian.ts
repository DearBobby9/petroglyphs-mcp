import { writeExport } from '../safe-export.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { store } from '../store.js';

export function register(server: McpServer, sessionId: string): void {
  server.tool(
    'save_to_obsidian',
    'Saves content as a markdown file to an Obsidian vault with YAML frontmatter. Optionally embeds the handwriting image.',
    {
      title: z.string().describe('Note title (used as filename)'),
      content: z.string().describe('Markdown content for the note body'),
      folder: z.string().optional().describe('Subfolder within the vault (default: root)'),
      tags: z.array(z.string()).optional().describe('Tags for YAML frontmatter'),
      embed_image: z.boolean().optional().describe('Whether to embed the latest handwriting PNG (default: false)'),
    },
    async ({ title, content, folder, tags, embed_image }) => {
      if (!config.vaultPath) {
        return {
          content: [{ type: 'text', text: 'Error: --vault-path not configured. Start the server with --vault-path /path/to/vault' }],
          isError: true,
        };
      }

      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const latest = store.getLatest(sessionId);

      // Build YAML frontmatter
      const frontmatter: Record<string, unknown> = {
        date: dateStr,
        source: 'petroglyphs',
      };
      if (tags && tags.length > 0) {
        frontmatter.tags = tags;
      }

      const yamlLines = Object.entries(frontmatter).map(([key, value]) => {
        if (Array.isArray(value)) {
          return `${key}:\n${value.map((v) => `  - ${v}`).join('\n')}`;
        }
        return `${key}: ${value}`;
      });

      let body = content;

      // Embed image if requested
      if (embed_image && latest) {
        const imgFilename = `petroglyphs-${now.getTime()}.png`;
        await writeExport(config.vaultPath, 'attachments', imgFilename, Buffer.from(latest.imageBase64, 'base64'));

        body = `![[${imgFilename}]]\n\n${body}`;
      }

      const md = `---\n${yamlLines.join('\n')}\n---\n\n${body}\n`;

      const sanitizedTitle = title.replace(/[/\\:*?"<>|]/g, '-');
      const filePath = await writeExport(config.vaultPath, folder ?? '', `${sanitizedTitle}.md`, md);

      return {
        content: [{ type: 'text', text: `Saved to ${filePath}` }],
      };
    }
  );
}
