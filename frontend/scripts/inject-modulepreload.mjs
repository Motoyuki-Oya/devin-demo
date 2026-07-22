import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.join(__dirname, '..', 'dist');

// Find all HTML files in dist
function findHtmlFiles(dir) {
    const files = [];
    const items = fs.readdirSync(dir);

    for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            files.push(...findHtmlFiles(fullPath));
        } else if (item.endsWith('.html')) {
            files.push(fullPath);
        }
    }

    return files;
}

// Find all JS files in _astro directory
function findAstroJsFiles() {
    const astroDir = path.join(distDir, '_astro');
    if (!fs.existsSync(astroDir)) {
        return [];
    }

    return fs.readdirSync(astroDir)
        .filter(file => file.endsWith('.js'))
        .map(file => `/_astro/${file}`);
}

// Inject modulepreload tags into HTML
function injectModulepreload(htmlPath) {
    let html = fs.readFileSync(htmlPath, 'utf-8');

    // Check if already has modulepreload tags
    if (html.includes('rel="modulepreload"')) {
        console.log(`[inject-modulepreload] Skipping ${path.basename(htmlPath)} (already has modulepreload)`);
        return;
    }

    const jsFiles = findAstroJsFiles();

    if (jsFiles.length === 0) {
        console.log(`[inject-modulepreload] No JS files found in _astro directory`);
        return;
    }

    // Create modulepreload tags
    const preloadTags = jsFiles
        .map(file => `    <link rel="modulepreload" href="${file}" />`)
        .join('\n');

    // Insert before </head>
    const headCloseIndex = html.indexOf('</head>');
    if (headCloseIndex === -1) {
        console.log(`[inject-modulepreload] No </head> found in ${path.basename(htmlPath)}`);
        return;
    }

    const before = html.substring(0, headCloseIndex);
    const after = html.substring(headCloseIndex);

    html = `${before}    <!-- Auto-injected modulepreload -->\n${preloadTags}\n  ${after}`;

    fs.writeFileSync(htmlPath, html, 'utf-8');
    console.log(`[inject-modulepreload] Injected ${jsFiles.length} modulepreload tag(s) into ${path.basename(htmlPath)}`);
}

// Main
const htmlFiles = findHtmlFiles(distDir);

if (htmlFiles.length === 0) {
    console.log('[inject-modulepreload] No HTML files found in dist directory');
    process.exit(0);
}

for (const htmlFile of htmlFiles) {
    injectModulepreload(htmlFile);
}

console.log(`[inject-modulepreload] Done. Processed ${htmlFiles.length} HTML file(s).`);
