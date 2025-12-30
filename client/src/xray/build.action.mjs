import {execSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import url from 'url';

import minimist from 'minimist';
import fetch from 'node-fetch';

import {getRootDir} from '../../../src/build/get_root_dir.mjs';
import {getBuildParameters} from '../build/get_build_parameters.mjs';

const XRAY_REPO = 'XTLS/Xray-core';
const ASSET_NAME = 'Xray-windows-64.zip';

async function fetchReleaseByTag(releaseTag) {
  const apiUrl = `https://api.github.com/repos/${XRAY_REPO}/releases/tags/${releaseTag}`;
  
  console.log(`Fetching release info for tag: ${releaseTag}`);
  const releaseResponse = await fetch(apiUrl);
  
  if (!releaseResponse.ok) {
    throw new Error(`Failed to fetch release info: ${releaseResponse.status} ${releaseResponse.statusText}`);
  }

  const releaseData = await releaseResponse.json();
  return releaseData;
}

async function downloadAsset(asset, outputPath) {
  const headers = {
    'Accept': 'application/octet-stream'
  };
  
  console.log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(2)} MB)`);
  const downloadResponse = await fetch(asset.url, {headers});
  
  if (!downloadResponse.ok) {
    throw new Error(`Failed to download asset: ${downloadResponse.status} ${downloadResponse.statusText}`);
  }

  const target = createWriteStream(outputPath);
  await pipeline(downloadResponse.body, target);
}

async function extractZip(zipPath, extractDir) {
  console.log(`Extracting archive...`);
  const powershellCommand = `powershell -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force"`;
  execSync(powershellCommand, {stdio: 'inherit'});
  console.log(`Extraction completed`);
}

async function findXrayExe(searchDir) {
  const files = await fs.readdir(searchDir, {withFileTypes: true});
  
  for (const file of files) {
    const fullPath = path.join(searchDir, file.name);
    
    if (file.isDirectory()) {
      const found = await findXrayExe(fullPath);
      if (found) return found;
    } else if (file.name === 'xray.exe') {
      return fullPath;
    }
  }
  
  return null;
}

export async function main(...parameters) {
  const {platform: targetPlatform} = getBuildParameters(parameters);
  const args = minimist(parameters);

  if (targetPlatform !== 'windows') {
    return;
  }

  const releaseTag = args.xrayReleaseTag || process.env.XRAY_VERSION;
  if (!releaseTag) {
    throw new Error('xray release tag is required. Please specify --xrayReleaseTag or set XRAY_VERSION environment variable.');
  }
  const releaseData = await fetchReleaseByTag(releaseTag);
  const releaseTagName = releaseData.tag_name;
  const asset = releaseData.assets?.find(a => a.name === ASSET_NAME);
  
  if (!asset) {
    throw new Error(`Asset ${ASSET_NAME} not found in release ${releaseTagName}`);
  }

  const xrayDir = path.join(getRootDir(), 'tools', 'xray');
  await fs.mkdir(xrayDir, {recursive: true});

  const archivePath = path.join(xrayDir, ASSET_NAME);
  const readmePath = path.join(xrayDir, 'README.md');
  const tempReadmePath = path.join(xrayDir, 'README.md.tmp');

  let readmeExists = false;
  try {
    await fs.access(readmePath);
    readmeExists = true;
    await fs.copyFile(readmePath, tempReadmePath);
  } catch {
    console.log(`README.md not found, skipping backup`);
  }

  try {
    await downloadAsset(asset, archivePath);
    console.log(`Download completed: ${archivePath}`);

    await extractZip(archivePath, xrayDir);
    const xrayExePath = await findXrayExe(xrayDir);
    
    if (!xrayExePath) {
      throw new Error('xray.exe not found in extracted archive');
    }
    const finalXrayPath = path.join(xrayDir, 'xray.exe');
    if (xrayExePath !== finalXrayPath) {
      await fs.copyFile(xrayExePath, finalXrayPath);
    }

    const files = await fs.readdir(xrayDir, {withFileTypes: true});
    for (const file of files) {
      const filePath = path.join(xrayDir, file.name);
      
      if (file.name === 'xray.exe' || file.name === 'README.md' || file.name === 'README.md.tmp') {
        continue;
      }
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        await fs.rm(filePath, {recursive: true, force: true});
      } else {
        await fs.unlink(filePath);
      }
    }

    if (readmeExists) {
      await fs.copyFile(tempReadmePath, readmePath);
      await fs.unlink(tempReadmePath);
    }

    console.log(`Successfully downloaded xray.exe from release: ${releaseTagName}`);
    console.log(`xray.exe is ready in ${finalXrayPath}`);
  } catch (error) {
    console.error(`Error occurred: ${error.message}`);
    try {
      if (readmeExists) {
        await fs.copyFile(tempReadmePath, readmePath);
        await fs.unlink(tempReadmePath);
      }
      if (await fs.access(archivePath).then(() => true).catch(() => false)) {
        await fs.unlink(archivePath);
      }
    } catch (cleanupError) {
      console.warn(`Failed to cleanup after error:`, cleanupError);
    }
    throw error;
  }
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}