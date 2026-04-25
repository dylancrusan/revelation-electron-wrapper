/*
 * canvasbuilder/client.js — Plugin Registration
 *
 * Registered in the global RevelationPlugins registry.
 * builder.js is lazy-loaded only on the builder page to keep startup overhead low.
 */
window.RevelationPlugins = window.RevelationPlugins || {};
window.RevelationPlugins.canvasbuilder = {
  init(ctx) {
    this._ctx = ctx;
  },

  async getBuilderExtensions(ctx) {
    if ((this._ctx?.page || '').toLowerCase() !== 'builder') return [];
    const mod = await import('./builder.js');
    return mod.getBuilderExtensions(ctx);
  },

  preprocessMarkdown(md) {
    return md.replace(/\{(#[0-9a-fA-F]{3,6}):([^}]+)\}/g, '<span style="color:$1">$2</span>');
  }
};
