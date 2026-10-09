const { build } = require('esbuild');
const { execFileSync } = require('node:child_process');

const testFiles = [
  'test/groqService.test.ts',
  'test/webview.test.ts',
  'test/pipeline.test.ts',
];

async function main() {
  await build({
    entryPoints: testFiles,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outdir: 'dist-test',
    logLevel: 'warning',
  });

  for (const file of testFiles) {
    const output = file.replace(/^test[\\/]/, 'dist-test/').replace(/\.ts$/, '.js');
    execFileSync(process.execPath, [output], { stdio: 'inherit' });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
