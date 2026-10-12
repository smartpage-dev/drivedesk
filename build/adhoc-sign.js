// Without an Apple Developer ID, apps on Apple silicon still need a (free) ad-hoc signature to launch.
// If signing secrets are configured (CSC_LINK), electron-builder signs properly instead and this is skipped.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin' || process.env.CSC_LINK) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log('  • ad-hoc signing', appPath);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
