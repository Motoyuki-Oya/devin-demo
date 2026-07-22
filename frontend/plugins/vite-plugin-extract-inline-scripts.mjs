/**
 * Vite plugin to extract inline <script> tags from HTML and externalize them.
 * This reduces the size of index.html by moving Astro's island runtime to external files.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export default function extractInlineScripts() {
  let outDir = 'dist';

  return {
    name: 'extract-inline-scripts',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir || 'dist';
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const scripts = [];
        let scriptIndex = 0;

        // Extract inline scripts (not module scripts with src)
        const processed = html.replace(
          /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi,
          (match, attrs, content) => {
            // Skip empty scripts
            if (!content.trim()) return match;

            // Skip very small scripts (< 100 bytes) - not worth externalizing
            if (content.length < 100) return match;

            const filename = `_astro-inline-${scriptIndex++}.js`;
            scripts.push({ filename, content: content.trim() });

            // Preserve attributes but add src
            const cleanAttrs = attrs.trim();
            return `<script src="/${filename}"${cleanAttrs ? ' ' + cleanAttrs : ''}></script>`;
          }
        );

        // Write extracted scripts to dist folder after build
        if (scripts.length > 0) {
          this._extractedScripts = scripts;
        }

        return processed;
      },
    },
    closeBundle() {
      const scripts = this._extractedScripts;
      if (!scripts || scripts.length === 0) return;

      for (const { filename, content } of scripts) {
        const outPath = join(outDir, filename);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, content, 'utf8');
        console.log(`[extract-inline-scripts] Extracted: ${filename} (${content.length} bytes)`);
      }
    },
  };
}
