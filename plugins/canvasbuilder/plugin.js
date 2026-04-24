const canvasBuilderPlugin = {
  clientHookJS: 'client.js',
  exposeToBrowser: true,
  priority: 141,
  version: '1.0.0',
  config: {},
  register(AppContext) {
    AppContext.log('[canvasbuilder] Registered');
  }
};

module.exports = canvasBuilderPlugin;
