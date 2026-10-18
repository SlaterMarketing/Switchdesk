// Turns on code signing in package.json's build settings for a release build, when the signing
// secrets are there (see SIGNING.md). Without them, builds stay as they are: unsigned on Windows,
// signed ad hoc on Mac.
//   node scripts/signing-config.js mac   Developer ID signing with the hardened runtime (and
//                                        notarisation, which electron-builder does when APPLE_ID is set)
//   node scripts/signing-config.js win   Azure Trusted Signing, named by the AZURE_SIGN_* variables
'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const which = process.argv[2];

if (which === 'mac') {
  delete pkg.build.mac.identity; // found from CSC_LINK
  Object.assign(pkg.build.mac, { hardenedRuntime: true, gatekeeperAssess: false, entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist' });
} else if (which === 'win') {
  const need = ['AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER'].filter((k) => !process.env[k]);
  if (need.length) throw new Error(`Set these repository variables for Windows signing: ${need.join(', ')}`);
  pkg.build.win.azureSignOptions = {
    endpoint: process.env.AZURE_SIGN_ENDPOINT,
    codeSigningAccountName: process.env.AZURE_SIGN_ACCOUNT,
    certificateProfileName: process.env.AZURE_SIGN_PROFILE,
    publisherName: process.env.AZURE_SIGN_PUBLISHER,
  };
} else throw new Error('Say mac or win.');

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Signing on for ${which}.`);
