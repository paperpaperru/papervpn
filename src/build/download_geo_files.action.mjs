import url from 'url';
import path from 'node:path';
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import minimist from 'minimist';
import fetch from 'node-fetch';
import {getBuildParameters} from './get_build_parameters.mjs';
import {getRootDir} from './get_root_dir.mjs';

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

  if (targetPlatform === 'browser') {
    return;
  }

  const releaseTag = args.geoDataReleaseTag || process.env.GEO_DATA_VERSION;
  const githubToken = args.githubToken || process.env.GITHUB_TOKEN;
    
  if (!releaseTag) {
    throw new Error(`Parameter --geoDataReleaseTag is required for ${targetPlatform} builds`);
  }

  let outputDir;
  if (targetPlatform === 'android') {
    outputDir = path.join(getRootDir(), 'output', 'build', 'android', 'geo');
  } else if (['ios', 'macos'].includes(targetPlatform)) {
    outputDir = path.join(getRootDir(), 'output', 'build', 'apple', 'geo');
  } else {
    return;
  }

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
