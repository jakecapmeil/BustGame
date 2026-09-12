/**
 * BUST — iOS native config patch.
 *
 * Writes the product-level iOS settings Capacitor leaves blank, into the
 * generated project at ios/ios/App/App/Info.plist, and disables Xcode's user
 * script sandboxing (which blocks CocoaPods' embed-frameworks build phase —
 * https://github.com/CocoaPods/CocoaPods/issues/11582) in project.pbxproj.
 * Re-run after `cap sync ios` regenerates the native project.
 *
 * Orientation: the web PWA is `orientation:any`, so the app allows all four
 * device orientations. To lock the app to portrait, delete the two
 * Landscape* strings below (or edit this template).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ios = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(ios, 'ios', 'App', 'App', 'Info.plist');
const pbxproj = path.join(ios, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>BUST</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>com.bust.game</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>BUST</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>UILaunchStoryboardName</key><string>LaunchScreen</string>
  <key>UIMainStoryboardFile</key><string>Main</string>
  <key>UIRequiredDeviceCapabilities</key>
  <array>
    <string>armv7</string>
  </array>
  <!-- Orientation: allow every rotation (matches manifest "orientation": "any").
       For a portrait lock, drop the two Landscape* entries. -->
  <key>UISupportedInterfaceOrientations</key>
  <array>
    <string>UIInterfaceOrientationPortrait</string>
    <string>UIInterfaceOrientationPortraitUpsideDown</string>
    <string>UIInterfaceOrientationLandscapeLeft</string>
    <string>UIInterfaceOrientationLandscapeRight</string>
  </array>
  <key>UISupportedInterfaceOrientations~ipad</key>
  <array>
    <string>UIInterfaceOrientationPortrait</string>
    <string>UIInterfaceOrientationPortraitUpsideDown</string>
    <string>UIInterfaceOrientationLandscapeLeft</string>
    <string>UIInterfaceOrientationLandscapeRight</string>
  </array>
  <key>UIViewControllerBasedStatusBarAppearance</key><true/>
  <!-- The game is canvas-first; it runs edge-to-edge under the notch. Safe areas
       are honoured in CSS via env(safe-area-inset-*) — see ios/app.css. -->
  <key>UIRequiresFullScreen</key><false/>
</dict>
</plist>
`;

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, PLIST);
console.log('Info.plist →', target);

if (fs.existsSync(pbxproj)) {
  const before = fs.readFileSync(pbxproj, 'utf8');
  const after = before.replaceAll('ENABLE_USER_SCRIPT_SANDBOXING = YES;', 'ENABLE_USER_SCRIPT_SANDBOXING = NO;');
  if (after !== before) {
    fs.writeFileSync(pbxproj, after);
    console.log('project.pbxproj → disabled ENABLE_USER_SCRIPT_SANDBOXING');
  }
}