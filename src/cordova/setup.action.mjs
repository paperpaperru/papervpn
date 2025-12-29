// Copyright 2022 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import os from 'os';
import url from 'url';
import rmfr from 'rmfr';
import path from 'path';
import fs from 'fs/promises';
import {readFileSync, writeFileSync} from 'fs';

import replace from 'replace-in-file';
import cordovaLib from 'cordova-lib';
const {cordova} = cordovaLib;

import {getRootDir} from '../build/get_root_dir.mjs';
import {runAction} from '../build/run_action.mjs';
import {getBuildParameters} from '../build/get_build_parameters.mjs';
import {spawnStream} from '../build/spawn_stream.mjs';
import chalk from 'chalk';

const WORKING_CORDOVA_OSX_COMMIT = '07e62a53aa6a8a828fd988bc9e884c38c3495a67';

/**
 * @description Prepares the paramterized cordova project (ios, macos, android) for being built.
 * We have a couple custom things we must do - like rsyncing code from our apple project into the project
 * cordova creates.
 *
 * @param {string[]} parameters
 */
export async function main(...parameters) {
  const {platform, buildMode, verbose, buildNumber, versionName} = getBuildParameters(parameters);

  await runAction('www/build', ...parameters);
  await runAction('tun2socks/build', ...parameters);
  await runAction('build/download_geo_files', ...parameters);

  if (['ios', 'macos'].includes(platform)) {
    await copyGeoFilesForApple(platform);
  }

  await rmfr(path.resolve(getRootDir(), 'platforms'));
  await rmfr(path.resolve(getRootDir(), 'plugins'));

  if (verbose) {
    cordova.on('verbose', message => console.debug(`[cordova:verbose] ${message}`));
  }

  switch (platform + buildMode) {
    case 'android' + 'debug':
      return androidDebug(verbose);
    case 'android' + 'release':
      console.warn('NOTE: You must open the Outline.zip file after building to upload to the Play Store.');
      return androidRelease(versionName, buildNumber, verbose);
    case 'ios' + 'debug':
    case 'maccatalyst' + 'debug':
      return appleIosDebug(verbose);
    case 'macos' + 'debug':
      return appleMacOsDebug(verbose);
    case 'ios' + 'release':
    case 'maccatalyst' + 'release':
      return appleIosRelease(versionName, buildNumber, verbose);
    case 'macos' + 'release':
      return appleMacOsRelease(versionName, buildNumber, verbose);
    case 'browser' + 'debug':
    default:
      return cordova.prepare({
        platforms: ['browser'],
        save: false,
      });
  }
}

async function androidDebug(verbose) {
  await cordova.prepare({
    platforms: ['android'],
    save: false,
    verbose,
  });
}

async function makeReplacements(replacements) {
  let results = [];

  for (const replacement of replacements) {
    results = [...results, ...(await replace(replacement))];
  }
}

async function androidRelease(versionName, buildNumber, verbose) {
  await cordova.prepare({
    platforms: ['android'],
    save: false,
    verbose,
  });

  const manifestXmlGlob = path.join(getRootDir(), 'platforms', 'android', '**', 'AndroidManifest.xml');
  const configXmlGlob = path.join(getRootDir(), 'platforms', 'android', '**', 'config.xml');

  await makeReplacements([
    {
      files: manifestXmlGlob,
      from: ['android:versionName="1.0"', 'android:versionName="0.0.0-debug"'],
      to: `android:versionName="${versionName}"`,
    },
    {
      files: manifestXmlGlob,
      from: 'android:versionCode="1"',
      to: `android:versionCode="${buildNumber}"`,
    },
    {
      files: configXmlGlob,
      from: 'version="0.0.0-debug"',
      to: `version="${versionName}"`,
    },
    {
      files: configXmlGlob,
      from: 'android-versionCode="1"',
      to: `android-versionCode="${buildNumber}"`,
    },
  ]);
}

function addGeoFilesBuildPhase(projectPath) {
  const projectContent = readFileSync(projectPath, 'utf8');
  
  const scriptPhaseId = generateUUID();
  const scriptPhaseName = 'Copy Geo Files';
  
  const shellScript = 'GEO_SOURCE_DIR="${SRCROOT}/../../src/cordova/apple/PepperAppleLib/Sources/PacketTunnelProvider"\n' +
    '\n' +
    'if [ -n "${UNLOCALIZED_RESOURCES_FOLDER_PATH}" ]; then\n' +
    '    RESOURCES_DIR="${BUILT_PRODUCTS_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"\n' +
    'elif [ -n "${CONTENTS_FOLDER_PATH}" ]; then\n' +
    '    RESOURCES_DIR="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Resources"\n' +
    'else\n' +
    '    if [ "${PLATFORM_NAME}" = "macosx" ]; then\n' +
    '        RESOURCES_DIR="${BUILT_PRODUCTS_DIR}/${WRAPPER_NAME}/Contents/Resources"\n' +
    '    else\n' +
    '        RESOURCES_DIR="${BUILT_PRODUCTS_DIR}/${WRAPPER_NAME}"\n' +
    '    fi\n' +
    'fi\n' +
    '\n' +
    'echo "Copying geo files from ${GEO_SOURCE_DIR} to ${RESOURCES_DIR}"\n' +
    'echo "BUILT_PRODUCTS_DIR: ${BUILT_PRODUCTS_DIR}"\n' +
    'echo "WRAPPER_NAME: ${WRAPPER_NAME}"\n' +
    'echo "PLATFORM_NAME: ${PLATFORM_NAME}"\n' +
    'echo "UNLOCALIZED_RESOURCES_FOLDER_PATH: ${UNLOCALIZED_RESOURCES_FOLDER_PATH}"\n' +
    '\n' +
    'mkdir -p "${RESOURCES_DIR}"\n' +
    'if [ $? -ne 0 ]; then\n' +
    '    echo "ERROR: Failed to create resources directory: ${RESOURCES_DIR}"\n' +
    '    exit 1\n' +
    'fi\n' +
    '\n' +
    'if [ -f "${GEO_SOURCE_DIR}/geoip.dat" ]; then\n' +
    '    cp "${GEO_SOURCE_DIR}/geoip.dat" "${RESOURCES_DIR}/"\n' +
    '    if [ $? -eq 0 ]; then\n' +
    '        echo "✓ Copied geoip.dat to ${RESOURCES_DIR}"\n' +
    '    else\n' +
    '        echo "✗ ERROR: Failed to copy geoip.dat"\n' +
    '        exit 1\n' +
    '    fi\n' +
    'else\n' +
    '    echo "✗ ERROR: geoip.dat not found at ${GEO_SOURCE_DIR}/geoip.dat"\n' +
    '    exit 1\n' +
    'fi\n' +
    '\n' +
    'if [ -f "${GEO_SOURCE_DIR}/geosite.dat" ]; then\n' +
    '    cp "${GEO_SOURCE_DIR}/geosite.dat" "${RESOURCES_DIR}/"\n' +
    '    if [ $? -eq 0 ]; then\n' +
    '        echo "✓ Copied geosite.dat to ${RESOURCES_DIR}"\n' +
    '    else\n' +
    '        echo "✗ ERROR: Failed to copy geosite.dat"\n' +
    '        exit 1\n' +
    '    fi\n' +
    'else\n' +
    '    echo "✗ ERROR: geosite.dat not found at ${GEO_SOURCE_DIR}/geosite.dat"\n' +
    '    exit 1\n' +
    'fi\n' +
    '\n' +
    'echo "Geo files copied successfully"\n';

  if (projectContent.includes(scriptPhaseName)) {
    console.log(`Build phase "${scriptPhaseName}" already exists in ${projectPath}`);
    return;
  }

  const shellScriptPhasePattern = /(\/\* End PBXShellScriptBuildPhase section \*\/)/;
  if (!shellScriptPhasePattern.test(projectContent)) {
    console.warn(`Could not find PBXShellScriptBuildPhase section in ${projectPath}`);
    return;
  }

  const newBuildPhase = `\t\t${scriptPhaseId} /* ${scriptPhaseName} */ = {
  \t\t\tisa = PBXShellScriptBuildPhase;
  \t\t\tbuildActionMask = 2147483647;
  \t\t\tfiles = (
  \t\t\t);
  \t\t\tinputPaths = (
  \t\t\t);
  \t\t\tname = "${scriptPhaseName}";
  \t\t\toutputPaths = (
  \t\t\t);
  \t\t\trunOnlyForDeploymentPostprocessing = 0;
  \t\t\tshellPath = "/bin/sh";
  \t\t\tshellScript = "${shellScript.replace(/\n/g, '\\n').replace(/"/g, '\\"')}";
  \t\t};
  $1`;
  let updatedContent = projectContent.replace(shellScriptPhasePattern, newBuildPhase);

  const vpnExtensionTargetPattern = /(3B0347471F212F0100C8EF1F|\w+) \/\* VpnExtension \*\/ = \{[^}]*buildPhases = \(([^)]*)\);/s;
  
  if (vpnExtensionTargetPattern.test(updatedContent)) {
    updatedContent = updatedContent.replace(
      vpnExtensionTargetPattern,
      (match, targetId, buildPhases) => {
        const newBuildPhases = `\n\t\t\t\t${scriptPhaseId} /* ${scriptPhaseName} */,${buildPhases}`;
        return match.replace(buildPhases, newBuildPhases);
      }
    );
  } else {
    const macosVpnExtensionPattern = /(FC5FF92A1F3E1E5F0032A745|\w+) \/\* VpnExtension \*\/ = \{[^}]*buildPhases = \(([^)]*)\);/s;
    if (macosVpnExtensionPattern.test(updatedContent)) {
      updatedContent = updatedContent.replace(
        macosVpnExtensionPattern,
        (match, targetId, buildPhases) => {
          const newBuildPhases = `\n\t\t\t\t${scriptPhaseId} /* ${scriptPhaseName} */,${buildPhases}`;
          return match.replace(buildPhases, newBuildPhases);
        }
      );
    } else {
      console.warn(`Could not find VpnExtension target in ${projectPath}`);
      return;
    }
  }

  writeFileSync(projectPath, updatedContent, 'utf8');
  console.log(`Added "${scriptPhaseName}" build phase to VpnExtension target in ${projectPath}`);
}

function generateUUID() {
  return Array.from({length: 24}, () => 
    '0123456789ABCDEF'[Math.floor(Math.random() * 16)]
  ).join('');
}

async function appleIosDebug(verbose) {
  if (os.platform() !== 'darwin') {
    throw new Error('Building an Apple binary requires xcodebuild and can only be done on MacOS');
  }

  await cordova.prepare({
    platforms: ['ios'],
    save: false,
    verbose,
  });

  // TODO(daniellacosse): move this to a cordova hook
  await spawnStream('rsync', '-avc', 'src/cordova/apple/xcode/ios/', 'platforms/ios/');
  
  const iosProjectPath = path.join(getRootDir(), 'platforms', 'ios', 'PepperVPN.xcodeproj', 'project.pbxproj');
  if (await fileExists(iosProjectPath)) {
    addGeoFilesBuildPhase(iosProjectPath);
  }
}

async function appleMacOsDebug(verbose) {
  if (os.platform() !== 'darwin') {
    throw new Error('Building an Apple binary requires xcodebuild and can only be done on MacOS');
  }

  console.warn(
    chalk.yellow('Debug mode on the MacOS client is currently broken. Try running with `--buildMode=release` instead.')
  );

  await cordova.platform('add', [`github:apache/cordova-osx#${WORKING_CORDOVA_OSX_COMMIT}`], {save: false});

  await cordova.prepare({
    platforms: ['osx'],
    save: false,
    verbose,
  });

  // TODO(daniellacosse): move this to a cordova hook
  await spawnStream('rsync', '-avc', 'src/cordova/apple/xcode/macos/', 'platforms/osx/');
  
  const macosProjectPath = path.join(getRootDir(), 'platforms', 'osx', 'PepperVPN.xcodeproj', 'project.pbxproj');
  if (await fileExists(macosProjectPath)) {
    addGeoFilesBuildPhase(macosProjectPath);
  }
}

async function setAppleVersion(platform, versionName, buildNumber) {
  await makeReplacements([
    {
      files: `platforms/${platform}/Outline/*.plist`,
      from: /<key>CFBundleShortVersionString<\/key>\s*<string>.*<\/string>/g,
      to: `<key>CFBundleShortVersionString</key>\n  <string>${versionName}</string>`,
    },
    {
      files: `platforms/${platform}/Outline/*.plist`,
      from: /<key>CFBundleVersion<\/key>\s*<string>.*<\/string>/g,
      to: `<key>CFBundleVersion</key>\n  <string>${buildNumber}</string>`,
    },
  ]);
}

async function appleIosRelease(version, buildNumber, verbose) {
  if (os.platform() !== 'darwin') {
    throw new Error('Building an Apple binary requires xcodebuild and can only be done on MacOS');
  }

  await cordova.prepare({
    platforms: ['ios'],
    save: false,
    verbose,
  });

  // TODO(daniellacosse): move this to a cordova hook
  await spawnStream('rsync', '-avc', 'src/cordova/apple/xcode/ios/', 'platforms/ios/');
  
  const iosProjectPath = path.join(getRootDir(), 'platforms', 'ios', 'PepperVPN.xcodeproj', 'project.pbxproj');
  if (await fileExists(iosProjectPath)) {
    addGeoFilesBuildPhase(iosProjectPath);
  }

  await setAppleVersion('ios', version, buildNumber);
}

async function appleMacOsRelease(version, buildNumber, verbose) {
  if (os.platform() !== 'darwin') {
    throw new Error('Building an Apple binary requires xcodebuild and can only be done on MacOS');
  }

  await cordova.platform('add', [`github:apache/cordova-osx#${WORKING_CORDOVA_OSX_COMMIT}`], {save: false});

  await cordova.prepare({
    platforms: ['osx'],
    save: false,
    verbose,
  });

  // TODO(daniellacosse): move this to a cordova hook
  await spawnStream('rsync', '-avc', 'src/cordova/apple/xcode/macos/', 'platforms/osx/');
  
  const macosProjectPath = path.join(getRootDir(), 'platforms', 'osx', 'PepperVPN.xcodeproj', 'project.pbxproj');
  if (await fileExists(macosProjectPath)) {
    addGeoFilesBuildPhase(macosProjectPath);
  }

  await setAppleVersion('osx', version, buildNumber);
}

async function copyGeoFilesForApple(platform) {
  const appleGeoDir = path.join(getRootDir(), 'output', 'build', 'apple', 'geo');
  const targetDir = path.join(getRootDir(), 'src', 'cordova', 'apple', 'PepperAppleLib', 'Sources', 'PacketTunnelProvider');
  
  console.log(`Copying geo files to ${targetDir}...`);
  await fs.mkdir(targetDir, {recursive: true});
  await fs.copyFile(
    path.join(appleGeoDir, 'geoip.dat'),
    path.join(targetDir, 'geoip.dat')
  );
  await fs.copyFile(
    path.join(appleGeoDir, 'geosite.dat'),
    path.join(targetDir, 'geosite.dat')
  );
  console.log('Geo files copied successfully');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
