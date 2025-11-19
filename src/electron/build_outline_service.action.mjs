// Copyright 2024 The Outline Authors
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

import {exec} from 'child_process';
import {createWriteStream, unlink} from 'fs';
import fs from 'fs/promises';
import https from 'https';
import path from 'path';
import {promisify} from 'util';

import {getRootDir} from '../build/get_root_dir.mjs';

const execAsync = promisify(exec);

function downloadNuget(nugetPath) {
  const nugetUrl = 'https://dist.nuget.org/win-x86-commandline/latest/nuget.exe';
  
  console.log(`Downloading nuget.exe from ${nugetUrl}...`);
  
  // eslint-disable-next-line compat/compat
  return new Promise((resolve, reject) => {
    const file = createWriteStream(nugetPath);
    https.get(nugetUrl, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('✓ nuget.exe downloaded successfully');
        resolve();
      });
    }).on('error', (err) => {
      unlink(nugetPath, () => {});
      reject(new Error(`Failed to download nuget.exe: ${err.message}`));
    });
  });
}

async function ensureNuget(rootDir) {
  const nugetDir = path.join(rootDir, 'tools', 'nuget');
  const nugetPath = path.join(nugetDir, 'nuget.exe');
  
  try {
    await fs.access(nugetPath);
    console.log('✓ nuget.exe found');
    return nugetPath;
  } catch (e) {
    console.log('nuget.exe not found, downloading...');
    await fs.mkdir(nugetDir, { recursive: true });
    await downloadNuget(nugetPath);
    return nugetPath;
  }
}

export async function main(...parameters) {
  const platform = parameters.find(p => p.includes('--platform='))?.split('=')[1];
  
  // Собираем только для Windows
  if (platform && platform !== 'windows') {
    console.log('Skipping OutlineService build (not Windows platform)');
    return;
  }

  console.log('Building OutlineService...');
  
  const rootDir = getRootDir();
  const solutionPath = path.join(rootDir, 'tools', 'OutlineService', 'OutlineService.sln');
  
  // Проверяем существование solution файла
  try {
    await fs.access(solutionPath);
  } catch (e) {
    throw new Error(`OutlineService.sln not found at ${solutionPath}`);
  }

  // Ищем MSBuild
  const msbuildPaths = [
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe',
  ];

  let msbuildPath;
  
  for (const testPath of msbuildPaths) {
    try {
      await fs.access(testPath);
      msbuildPath = testPath;
      console.log(`Found MSBuild at: ${msbuildPath}`);
      break;
    } catch (e) {
      // Продолжаем поиск
    }
  }

  if (!msbuildPath) {
    // Пытаемся использовать vswhere
    try {
      const vsWherePath = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
      await fs.access(vsWherePath);
      
      const { stdout } = await execAsync(
        `"${vsWherePath}" -latest -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\MSBuild.exe`
      );
      msbuildPath = stdout.trim().split('\n')[0];
      console.log(`Found MSBuild via vswhere: ${msbuildPath}`);
    } catch (e) {
      throw new Error(
        'MSBuild not found. Please install Visual Studio with .NET desktop development workload.\n' +
        'Download from: https://visualstudio.microsoft.com/downloads/'
      );
    }
  }

  // Восстанавливаем NuGet пакеты
  console.log('Restoring NuGet packages...');
  const nugetPath = await ensureNuget(rootDir);
  
  try {
    const restoreCommand = `"${nugetPath}" restore "${solutionPath}"`;
    console.log(`Running: ${restoreCommand}`);
    const {stdout: restoreStdout} = await execAsync(restoreCommand);
    
    if (restoreStdout) {
      console.log(restoreStdout);
    }
    
    console.log('✓ NuGet packages restored');
  } catch (error) {
    console.error('Failed to restore NuGet packages:');
    console.error(error.stdout || error.message);
    throw new Error(`NuGet restore failed: ${error.message}`);
  }

  // Собираем проект
  const buildCommand = `"${msbuildPath}" "${solutionPath}" /p:Configuration=Release /p:Platform=x86 /t:Rebuild /v:minimal`;
  
  console.log(`Running: ${buildCommand}`);
  
  try {
    const {stdout, stderr} = await execAsync(buildCommand);
    
    if (stdout) {
      console.log(stdout);
    }
    
    if (stderr) {
      console.error('Build warnings/errors:', stderr);
    }
    
    // Проверяем, что файл создан
    const outputExePath = path.join(rootDir, 'tools', 'OutlineService', 'OutlineService', 'bin', 'OutlineService.exe');
    await fs.access(outputExePath);
    
    console.log('✓ OutlineService.exe built successfully!');
    console.log(`  Output: ${outputExePath}`);
  } catch (error) {
    console.error('Failed to build OutlineService:');
    console.error(error.stdout || error.message);
    console.error(error.stderr || '');
    throw new Error(`OutlineService build failed: ${error.message}`);
  }
}

// Запуск если вызван напрямую
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  await main(...process.argv.slice(2));
}

