import { promises as fs } from 'fs';
import path from 'path';

export async function main(srcDirs, destDir) {
  try {
    await fs.mkdir(destDir, { recursive: true });
    
    for (const srcDir of srcDirs) {
      const files = await fs.readdir(srcDir);
      for (const file of files) {
        const srcFile = path.join(srcDir, file);
        const destFile = path.join(destDir, file);

        const stat = await fs.stat(srcFile);

        if (stat.isFile()) {
          await fs.copyFile(srcFile, destFile);
          console.log(`${srcFile} is copied to ${destFile}`);
        } else if (stat.isDirectory()) {
          await main(srcFile, destFile);
        }
      }
    }
    console.log('Files copied successfully');
  } catch (error) {
    console.error(`Error copying files: ${error}`);
  }
}

const tun2socksDir = path.resolve('tools/tun2socks');
const xrayDir = path.resolve('tools/xray');
const destDir = path.resolve('client/output/build/windows');

await main([tun2socksDir, xrayDir], destDir);