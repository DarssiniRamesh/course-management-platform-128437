#!/usr/bin/env node

/**
 * Extract all icon image assets from a Figma file and save them locally.
 *
 * Requirements (env):
 *  - REACT_APP_FIGMA_PERSONAL_ACCESS_TOKEN: Figma PAT with file read scope.
 *  - FIGMA_FILE_KEY: The Figma file key (the part after /file/<KEY>/... in the URL).
 *
 * Optional env:
 *  - ICON_MATCH: Regex (string) to filter node/component names considered "icons" (default: "(?i)icon|ic_|24|16|glyph")
 *  - FIGMA_IMAGE_FORMAT: "svg" or "png" (default exports both svg and png@1x)
 *
 * Output:
 *  - Saves into ./assets/icons within frontend_app
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.REACT_APP_FIGMA_PERSONAL_ACCESS_TOKEN || process.env.FIGMA_TOKEN || '';
const FILE_KEY = process.env.FIGMA_FILE_KEY || '';
const ICON_MATCH_INPUT = process.env.ICON_MATCH || '(?i)icon|ic_|glyph|/24|/16|/20|/32';
const IMAGE_FORMAT_ENV = (process.env.FIGMA_IMAGE_FORMAT || '').toLowerCase();

if (!TOKEN) {
  console.error('Missing REACT_APP_FIGMA_PERSONAL_ACCESS_TOKEN environment variable.');
  process.exit(1);
}
if (!FILE_KEY) {
  console.error('Missing FIGMA_FILE_KEY environment variable.');
  process.exit(1);
}

// Resolve output directory relative to this script => ../assets/icons
const OUT_DIR = path.resolve(__dirname, '../assets/icons');

// Helpers
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function httpsGetJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'GET', headers: { 'X-Figma-Token': TOKEN, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(`Figma API error ${res.statusCode}: ${data}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e.message} - Body: ${data?.slice(0, 200)}...`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpsDownloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // handle redirect
        httpsDownloadToFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: ${res.statusCode} - ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => {
      fs.unlink(destPath, () => reject(err));
    });
  });
}

function normalizeName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s:\/\\]+/g, '-')
    .replace(/[^a-z0-9\-_.]/g, '')
    .replace(/-+/g, '-');
}

function collectNodes(tree, out = []) {
  if (!tree) return out;
  if (tree.id && tree.name) {
    out.push({ id: tree.id, name: tree.name, type: tree.type || '' });
  }
  if (Array.isArray(tree.children)) {
    for (const child of tree.children) {
      collectNodes(child, out);
    }
  }
  return out;
}

(async () => {
  try {
    ensureDir(OUT_DIR);

    const iconRegex = new RegExp(ICON_MATCH_INPUT, 'i');

    console.log('Fetching Figma file structure...');
    const fileJson = await httpsGetJSON(`https://api.figma.com/v1/files/${FILE_KEY}`);

    // Gather all nodes
    const allNodes = [];
    for (const page of fileJson.document?.children || []) {
      collectNodes(page, allNodes);
    }

    // Also read components and componentSets; these are often icons
    const components = fileJson.components ? Object.values(fileJson.components) : [];
    const componentSets = fileJson.componentSets ? Object.values(fileJson.componentSets) : [];

    // Build a set of candidate node IDs by name matching and type heuristics
    const candidateIds = new Map();

    // From raw nodes: filter likely icon sizes/types and matching names
    for (const n of allNodes) {
      const likelyType = ['COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'VECTOR', 'FRAME', 'GROUP'].includes(n.type);
      const namedLikeIcon = iconRegex.test(n.name);
      if (likelyType && namedLikeIcon) {
        candidateIds.set(n.id, { id: n.id, name: n.name });
      }
    }

    // From components
    for (const c of components) {
      const n = { id: c.node_id || c.nodeId || c.nodeID || c.id, name: c.name || '' };
      if (n.id && iconRegex.test(n.name)) {
        candidateIds.set(n.id, n);
      }
    }

    // From component sets
    for (const s of componentSets) {
      const n = { id: s.node_id || s.nodeId || s.nodeID || s.id, name: s.name || '' };
      if (n.id && iconRegex.test(n.name)) {
        candidateIds.set(n.id, n);
      }
    }

    const ids = Array.from(candidateIds.keys());
    if (ids.length === 0) {
      console.warn('No icon-like nodes found via name match. Consider adjusting ICON_MATCH env.');
      console.warn('Attempting a fallback: export any component with 16/20/24/32 size patterns.');
      for (const c of components) {
        const nm = (c.name || '').toLowerCase();
        if (/(^|\/|\s)(16|20|24|32)(x|$|\/|\s)/.test(nm)) {
          const nid = c.node_id || c.nodeId || c.id;
          if (nid) candidateIds.set(nid, { id: nid, name: c.name });
        }
      }
    }

    const finalIds = Array.from(candidateIds.keys());
    if (finalIds.length === 0) {
      console.log('No candidates identified. Exiting with no downloads.');
      process.exit(0);
    }

    console.log(`Identified ${finalIds.length} candidate icon nodes. Requesting exports...`);

    // Request image URLs for SVG and PNG, depending on env
    const wantSVG = IMAGE_FORMAT_ENV === 'svg' || IMAGE_FORMAT_ENV === '';
    const wantPNG = IMAGE_FORMAT_ENV === 'png' || IMAGE_FORMAT_ENV === '';

    const images = { svg: {}, png: {} };

    if (wantSVG) {
      const svgResp = await httpsGetJSON(
        `https://api.figma.com/v1/images/${FILE_KEY}?ids=${encodeURIComponent(finalIds.join(','))}&format=svg&svg_include_id=true&use_absolute_bounds=true`
      );
      Object.assign(images.svg, svgResp.images || {});
    }
    if (wantPNG) {
      const pngResp = await httpsGetJSON(
        `https://api.figma.com/v1/images/${FILE_KEY}?ids=${encodeURIComponent(finalIds.join(','))}&format=png&scale=1`
      );
      Object.assign(images.png, pngResp.images || {});
    }

    // Map id -> name for better filenames
    const idToName = {};
    for (const [id, meta] of candidateIds.entries()) {
      idToName[id] = meta.name || `icon-${id}`;
    }

    // Download all found images
    let downloadCount = 0;
    const tasks = [];

    function queueDownload(url, outPath) {
      tasks.push(
        httpsDownloadToFile(url, outPath)
          .then(() => {
            downloadCount += 1;
            console.log(`Saved: ${path.relative(process.cwd(), outPath)}`);
          })
          .catch((e) => {
            console.warn(`Failed to download ${url}: ${e.message}`);
          })
      );
    }

    // SVGs
    if (wantSVG) {
      for (const [id, url] of Object.entries(images.svg)) {
        if (!url) continue;
        const base = normalizeName(idToName[id] || `icon-${id}`);
        const outPath = path.join(OUT_DIR, `${base}.svg`);
        queueDownload(url, outPath);
      }
    }

    // PNGs
    if (wantPNG) {
      for (const [id, url] of Object.entries(images.png)) {
        if (!url) continue;
        const base = normalizeName(idToName[id] || `icon-${id}`);
        const outPath = path.join(OUT_DIR, `${base}.png`);
        queueDownload(url, outPath);
      }
    }

    await Promise.all(tasks);

    console.log(`Done. Downloaded ${downloadCount} file(s) into ${path.relative(process.cwd(), OUT_DIR)}.`);
    console.log('Tip: Adjust ICON_MATCH or FIGMA_IMAGE_FORMAT env vars if you need different filtering or formats.');
  } catch (err) {
    console.error('Extraction failed:', err.message);
    process.exit(1);
  }
})();
