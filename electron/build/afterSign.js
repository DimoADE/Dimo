const path = require('node:path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }
  if (process.env.DIMO_SKIP_NOTARIZE === '1') {
    console.log('[afterSign] skipping macOS notarization (DIMO_SKIP_NOTARIZE=1)');
    return;
  }

  const appleApiKey = process.env.APPLE_API_KEY_PATH?.trim();
  const appleApiKeyId = process.env.APPLE_API_KEY?.trim();
  const appleApiIssuer = process.env.APPLE_API_ISSUER?.trim();

  if (!appleApiKey || !appleApiKeyId || !appleApiIssuer) {
    console.log(
      '[afterSign] skipping macOS notarization (APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH not configured)'
    );
    return;
  }

  const { notarize } = await import('@electron/notarize');
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`[afterSign] notarizing ${appPath} via App Store Connect API`);
  await notarize({
    appPath,
    appleApiKey,
    appleApiKeyId,
    appleApiIssuer,
  });
  console.log('[afterSign] macOS notarization completed');
};
