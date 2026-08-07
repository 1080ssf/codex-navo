const fs = require('node:fs');
const path = require('node:path');
const packager = require('@electron/packager');

const root = path.resolve(__dirname, '..');
const releaseDirectory = path.join(root, 'release');

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(sourcePath, destinationPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destinationPath);
  }
}

async function build() {
  const [applicationDirectory] = await packager({
    dir: path.join(root, 'desktop-src'),
    name: 'Codex 账号切换',
    platform: 'win32',
    arch: 'x64',
    out: releaseDirectory,
    overwrite: true,
    asar: true,
    icon: path.join(root, 'desktop-src', 'icon.ico'),
    ...(process.env.ELECTRON_ZIP_DIR ? { electronZipDir: process.env.ELECTRON_ZIP_DIR } : {}),
  });

  for (const file of ['server.js', 'README.md']) {
    fs.copyFileSync(path.join(root, file), path.join(applicationDirectory, file));
  }
  fs.copyFileSync(
    path.join(root, 'LICENSE'),
    path.join(applicationDirectory, 'LICENSE.codex-switchboard.txt'),
  );
  for (const directory of ['lib', 'public']) {
    copyTree(path.join(root, directory), path.join(applicationDirectory, directory));
  }
  const configDirectory = path.join(applicationDirectory, 'config');
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(root, 'config', 'settings.example.json'),
    path.join(configDirectory, 'settings.example.json'),
  );

  console.log(`Portable application: ${applicationDirectory}`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
