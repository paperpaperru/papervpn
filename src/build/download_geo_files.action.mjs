import {createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import url from 'url';

import minimist from 'minimist';
import fetch from 'node-fetch';

import {getRootDir} from './get_root_dir.mjs';
import {getBuildParameters} from '../../client/src/build/get_build_parameters.mjs';

const GEO_DATA_REPO = 'paperpaperru/geo-data';

async function fetchReleaseAsset(releaseTag, assetName, githubToken) {
  const apiUrl = `https://api.github.com/repos/${GEO_DATA_REPO}/releases/tags/${releaseTag}`;
  const headers = githubToken ? {Authorization: `Bearer ${githubToken}`} : {};
  
  console.log(`Fetching release info for tag: ${releaseTag}`);
  const releaseResponse = await fetch(apiUrl, {headers});
  
  if (!releaseResponse.ok) {
    if (releaseResponse.status === 404) {
      throw new Error(`Release with tag ${releaseTag} not found in repository ${GEO_DATA_REPO}`);
    }
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
}

export async function main(...parameters) {
  const {platform: targetPlatform} = getBuildParameters(parameters);
  const args = minimist(parameters);

  if (targetPlatform !== 'windows') {
    return;
  }

  const releaseTag = args.geoDataReleaseTag || process.env.GEO_DATA_VERSION;
  const githubToken = args.githubToken || process.env.GITHUB_TOKEN;
    
  if (!releaseTag) {
    throw new Error(`Parameter --geoDataReleaseTag is required for Windows builds`);
  }

  const outputDir = path.join(getRootDir(), 'client', 'output', 'build', 'windows');

  await fs.mkdir(outputDir, {recursive: true});
  
  const geoipPath = path.join(outputDir, 'geoip.dat');
  const geoipAsset = await fetchReleaseAsset(releaseTag, 'geoip.dat', githubToken);
  await downloadAsset(geoipAsset, geoipPath, githubToken);
  console.log(`Downloaded ${geoipAsset.name} from release ${releaseTag}`);
  
  const geositePath = path.join(outputDir, 'geosite.dat');
  const geositeAsset = await fetchReleaseAsset(releaseTag, 'geosite.dat', githubToken);
  await downloadAsset(geositeAsset, geositePath, githubToken);
  console.log(`Downloaded ${geositeAsset.name} from release ${releaseTag}`);
  
  console.log(`Geo files downloaded successfully to ${outputDir}`);
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
