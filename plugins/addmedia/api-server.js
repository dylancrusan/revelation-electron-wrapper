// Registers HTTP API routes for the addmedia plugin.
// Called by apiServer._loadPluginRoutes() at startup.
//
// Handler signature: async (searchParams, res) → result object | undefined
// Throw { status, message } for HTTP errors, plain Error for 500s.

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Read all sidecar .json files from _media (the source of truth).
function readAllMedia(mediaDir) {
  if (!fs.existsSync(mediaDir)) return [];
  return fs.readdirSync(mediaDir)
    .filter(f => f.endsWith('.json') && f !== 'index.json')
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(mediaDir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

// Deterministic tag: first word of original_filename (≤7 chars) + first 4 digits of hash.
function generateTag(meta) {
  const base = (meta.original_filename || meta.filename || 'media')
    .split(/\W+/)[0]
    .slice(0, 7)
    .toLowerCase() || 'media';
  const digits = (meta.filename.match(/\d/g) || []).slice(0, 4);
  while (digits.length < 4) digits.push('0');
  return `${base}${digits.join('')}`;
}

// Build a front-matter-ready entry object, omitting blank optional fields.
function buildEntry(meta) {
  const fields = {
    filename:          meta.filename          || '',
    title:             meta.title             || '',
    mediatype:         meta.mediatype         || '',
    description:       meta.description       || '',
    attribution:       meta.attribution       || '',
    license:           meta.license           || '',
    url_origin:        meta.url_origin        || '',
    url_library:       meta.url_library       || '',
    url_direct:        meta.url_direct        || ''
  };
  // Strip empty optional fields for cleaner output (filename, title, mediatype kept always).
  const required = new Set(['filename', 'title', 'mediatype']);
  for (const [k, v] of Object.entries(fields)) {
    if (!required.has(k) && v === '') delete fields[k];
  }
  if (meta.large_variant?.filename) {
    const lv = { filename: meta.large_variant.filename };
    if (meta.large_variant.original_filename) lv.original_filename = meta.large_variant.original_filename;
    if (meta.large_variant.url_direct)        lv.url_direct        = meta.large_variant.url_direct;
    fields.large_variant = lv;
  }
  return fields;
}

module.exports = {
  register(routes, _callPlugin, AppContext) {

    // GET /api/addmedia/search?query=sunset
    // Returns a short listing of matching media items (filename, title, mediatype,
    // description snippet, keywords). Searches title, description, keywords, original_filename.
    routes['GET /api/addmedia/search'] = async (sp) => {
      const query = sp.get('query');
      if (!query) throw { status: 400, message: 'Missing query parameter' };
      const mediaDir = path.join(AppContext.config.presentationsDir, '_media');
      const lower = query.toLowerCase();
      return readAllMedia(mediaDir)
        .filter(m => ['title', 'description', 'keywords', 'original_filename']
          .some(k => String(m[k] || '').toLowerCase().includes(lower)))
        .map(m => ({
          filename:    m.filename    || '',
          title:       m.title       || '',
          mediatype:   m.mediatype   || '',
          keywords:    m.keywords    || '',
          description: (m.description || '').slice(0, 120)
        }));
    };

    // GET /api/addmedia/item?filename=abc123.mp4
    // Returns a YAML snippet ready to paste directly under `media:` in front matter.
    // The tag is deterministically derived from the item's filename and original_filename.
    routes['GET /api/addmedia/item'] = async (sp, res) => {
      const filename = sp.get('filename');
      if (!filename) throw { status: 400, message: 'Missing filename parameter' };
      const mediaDir = path.join(AppContext.config.presentationsDir, '_media');
      const metaPath = path.join(mediaDir, `${filename}.json`);
      if (!fs.existsSync(metaPath)) {
        throw { status: 404, message: `Media item not found: ${filename}` };
      }
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const tag   = generateTag(meta);
      const entry = buildEntry(meta);
      const snippet = yaml.dump({ [tag]: entry }, { lineWidth: -1 });
      const body = Buffer.from(snippet, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'Content-Length': body.length });
      res.end(body);
      // return undefined so apiServer skips its own wrapping
    };

  }
};
