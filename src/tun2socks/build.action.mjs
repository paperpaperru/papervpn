// Copyright 2023 The Outline Authors
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

import url from 'url';
import os from 'os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import minimist from 'minimist';
import fetch from 'node-fetch';
import {spawnStream} from '../build/spawn_stream.mjs';
import {getBuildParameters} from '../build/get_build_parameters.mjs';
import {getRootDir} from '../build/get_root_dir.mjs';

async function fetchReleaseAsset(releaseTag, assetName, githubToken) {
  const apiUrl = `https://api.github.com/repos/paperpaperru/papervpn-mobile/releases/tags/${releaseTag}`;
  const headers = githubToken ? {Authorization: `Bearer ${githubToken}`} : {};
  
  console.log(`Fetching release info for tag: ${releaseTag}`);
  const releaseResponse = await fetch(apiUrl, {headers});
  
  if (!releaseResponse.ok) {
    throw new Error(`Failed to fetch release info: ${releaseResponse.status} ${releaseResponse.statusText}`);
  }

  const releaseData = await releaseResponse.json();
  const asset = releaseData.assets?.find(a => a.name === assetName);
  
  if (!asset) {
    throw new Error(`Asset ${assetName} not found in release ${releaseTag}`);
  }

  return asset;
}

async function downloadAsset(asset, outputPath, githubToken) {
  const headers = {
    'Accept': 'application/octet-stream',
    ...(githubToken ? {Authorization: `Bearer ${githubToken}`} : {})
  };
  
  console.log(`Downloading ${asset.name} (${asset.size} bytes)`);
  const downloadResponse = await fetch(asset.url, {headers});
  
  if (!downloadResponse.ok) {
    throw new Error(`Failed to download asset: ${downloadResponse.status} ${downloadResponse.statusText}`);
  }

  const target = createWriteStream(outputPath);
  await pipeline(downloadResponse.body, target);
  console.log(`Downloaded ${asset.name}`);
}

/**
 * @description Builds the tun2socks library for the specified platform.
 *
 * @param {string[]} parameters
 */
export async function main(...parameters) {
  const {platform: targetPlatform} = getBuildParameters(parameters);
  const args = minimist(parameters);

  const currentPlatform = os.platform() === 'win32' ? 'windows' : os.platform();

  if (targetPlatform === 'browser') {
    return;
  }

  if (targetPlatform === currentPlatform && ['linux', 'windows'].includes(targetPlatform)) {
    return spawnStream(
      'go',
      'build',
      '-o',
      `output/build/${targetPlatform}/tun2socks`,
      'github.com/Jigsaw-Code/outline-client/src/tun2socks/outline/electron'
    );
  }

  const releaseTag = args.tun2socksReleaseTag || process.env.TUN2SOCKS_VERSION;
  const githubToken = args.githubToken || process.env.GITHUB_TOKEN;
    
  if (!releaseTag) {
    throw new Error(`Parameter --tun2socksReleaseTag is required for ${targetPlatform} builds`);
  }

  let outputPath;

  if (targetPlatform === 'android') {
    outputPath = path.join(getRootDir(), 'output', 'build', 'android', 'tun2socks.aar');
    await fs.mkdir(path.dirname(outputPath), {recursive: true});
    const asset = await fetchReleaseAsset(releaseTag, 'tun2socks.aar', githubToken);
    await downloadAsset(asset, outputPath, githubToken);
    console.log(`Downloaded tun2socks.aar from release ${releaseTag}`);
    return;
  }

  outputPath = path.join(getRootDir(), 'output', 'build', 'apple');
  await fs.mkdir(outputPath, {recursive: true});
  const archivePath = path.join(outputPath, 'Tun2socks.xcframework.tar.gz');
  const asset = await fetchReleaseAsset(releaseTag, 'Tun2socks.xcframework.tar.gz', githubToken);
  await downloadAsset(asset, archivePath, githubToken);
  console.log(`Extracting Tun2socks.xcframework.tar.gz...`);
  await spawnStream('tar', '-xzf', archivePath, '-C', outputPath);
  console.log(`Extracted Tun2socks.xcframework to ${outputPath}`);
  return;
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
