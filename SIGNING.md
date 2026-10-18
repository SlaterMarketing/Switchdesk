# Signing the installers

Without signing, macOS says Switchdesk "is damaged and can't be opened" (people have to use
right-click → Open, or Privacy & Security → Open Anyway), and Windows shows a SmartScreen warning.
The release workflow signs both as soon as the secrets below are set in the repository
(Settings → Secrets and variables → Actions). Until then it builds them unsigned, as now.

## Mac: Developer ID and notarisation

1. Join the [Apple Developer Program](https://developer.apple.com/programs/).
2. In Xcode (Settings → Accounts → Manage Certificates) or on the developer site, make a
   **Developer ID Application** certificate. Export it from Keychain Access as a `.p12` with a password.
3. Make an [app-specific password](https://account.apple.com) for your Apple ID (Sign-In and Security → App-Specific Passwords).
4. Add these **secrets**:

| Secret | What goes in it |
| --- | --- |
| `MAC_CSC_LINK` | The `.p12`, base64-encoded: `base64 -i cert.p12 \| pbcopy` |
| `MAC_CSC_KEY_PASSWORD` | The `.p12`'s password |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password from step 3 |
| `APPLE_TEAM_ID` | Your team ID (Membership details on the developer site) |

The Mac builds are then signed with the hardened runtime (`build/entitlements.mac.plist`) and notarised.

## Windows: Azure Trusted Signing

1. In the Azure portal, create a **Trusted Signing account** and a **Public Trust** certificate profile
   (identity validation for you or Slater Marketing takes a few days).
2. Create an app registration and give it the **Trusted Signing Certificate Profile Signer** role on the account.
3. Add these **secrets**: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` (from the app registration).
4. Add these **variables**:

| Variable | Example |
| --- | --- |
| `AZURE_SIGN_ENDPOINT` | `https://weu.codesigning.azure.net` (your account's region) |
| `AZURE_SIGN_ACCOUNT` | The Trusted Signing account's name |
| `AZURE_SIGN_PROFILE` | The certificate profile's name |
| `AZURE_SIGN_PUBLISHER` | The name on the certificate, e.g. `Slater Marketing Ltd` |

`scripts/signing-config.js` turns signing on in the build settings for that release build only.

Once both are signed, take the "isn't signed" notes out of the README's install section.
