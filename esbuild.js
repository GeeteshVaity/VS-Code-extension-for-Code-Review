// esbuild bundler for the VS Code extension.
// Usage:
//   node esbuild.js                 -> one-off dev build (sourcemaps, unminified)
//   node esbuild.js --watch         -> incremental rebuilds on change
//   node esbuild.js --production    -> minified, no sourcemaps (used by vsce)
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').BuildOptions}
 */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  sourcesContent: false,
  logLevel: 'info',
  // The extension host provides CommonJS globals; banner keeps __dirname-like
  // references working inside the bundle.
  banner: {
    js: '// CoT Deep Code Review — bundled extension entry point.',
  },
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[esbuild] watching for changes…');
  } else {
    const result = await esbuild.build(buildOptions);
    if (result.errors.length > 0) {
      process.exitCode = 1;
    }
    console.log(
      `[esbuild] build ${result.errors.length > 0 ? 'FAILED' : 'OK'} (production=${production})`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
