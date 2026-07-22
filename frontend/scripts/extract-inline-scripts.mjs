/**
 * Post-build script to extract inline <script> tags from HTML and externalize them.
 * Run after `astro build` to reduce index.html size.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const distDir = 'dist';

function processHtmlFile(htmlPath) {
  let html = readFileSync(htmlPath, 'utf8');
  const scripts = [];
  let scriptIndex = 0;

  // Extract inline scripts (not scripts with src attribute)
  const processed = html.replace(
    /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi,
    (match, attrs, content) => {
      // Skip empty scripts
      if (!content.trim()) return match;

      // Skip very small scripts (< 100 bytes) - not worth externalizing
      if (content.length < 100) return match;

      const filename = `_inline-${scriptIndex++}.js`;
      scripts.push({ filename, content: content.trim() });

      // Preserve attributes but add src and defer
      const cleanAttrs = attrs.trim();
      return `<script src="/${filename}" defer${cleanAttrs ? ' ' + cleanAttrs : ''}></script>`;
    }
  );

  if (scripts.length === 0) {
    console.log(`[extract-inline-scripts] No inline scripts found in ${htmlPath}`);
    return;
  }

  // Write processed HTML
  writeFileSync(htmlPath, processed, 'utf8');
  console.log(`[extract-inline-scripts] Processed: ${htmlPath}`);

  // Write extracted scripts
  for (const { filename, content } of scripts) {
    const outPath = join(distDir, filename);
    writeFileSync(outPath, content, 'utf8');
    console.log(`[extract-inline-scripts] Extracted: ${filename} (${content.length} bytes)`);
  }

  // Report size reduction
  const originalSize = html.length;
  const newSize = processed.length;
  console.log(`[extract-inline-scripts] HTML size: ${originalSize} -> ${newSize} bytes (saved ${originalSize - newSize} bytes)`);
}

function findHtmlFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...findHtmlFiles(fullPath));
    } else if (entry.endsWith('.html')) {
      files.push(fullPath);
    }
  }
  return files;
}

// Process all HTML files in dist
const htmlFiles = findHtmlFiles(distDir);
for (const htmlFile of htmlFiles) {
  processHtmlFile(htmlFile);
}

console.log(`[extract-inline-scripts] Done. Processed ${htmlFiles.length} HTML file(s).`);
