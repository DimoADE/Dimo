#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Collects 5-platform Electron release artifacts, refreshes `electron-updater`
 * YAML checksums (`latest.yml`, `latest-arm64.yml`, `latest-mac.yml`,
 * `latest-linux.yml`, `latest-linux-arm64.yml`), and emits a Tauri v2
 * compatible `latest.json` bridge manifest (Decision D1) so existing Tauri
 * users auto-upgrade seamlessly into the signed Electron build.
 */

const BRIDGE_TARGETS = [
  {
    artifactName: 'Dimo-windows-x64',
    tauriPlatform: 'windows-x86_64',
    electronFeedSource: 'latest.yml',
    electronFeedDest: 'latest.yml',
    matchesBridgePayload(filePath) {
      return filePath.endsWith('-setup.exe');
    },
    matchesExtraReleaseAssets(filePath) {
      return filePath.endsWith('.exe.blockmap');
    },
  },
  {
    artifactName: 'Dimo-windows-arm64',
    tauriPlatform: 'windows-aarch64',
    electronFeedSource: 'latest.yml',
    electronFeedDest: 'latest-arm64.yml',
    matchesBridgePayload(filePath) {
      return filePath.endsWith('-setup.exe');
    },
    matchesExtraReleaseAssets(filePath) {
      return filePath.endsWith('.exe.blockmap');
    },
  },
  {
    artifactName: 'Dimo-linux-x64',
    tauriPlatform: 'linux-x86_64',
    electronFeedSource: 'latest-linux.yml',
    electronFeedDest: 'latest-linux.yml',
    matchesBridgePayload(filePath) {
      return filePath.endsWith('.AppImage');
    },
    matchesExtraReleaseAssets(filePath) {
      return filePath.endsWith('.deb');
    },
  },
  {
    artifactName: 'Dimo-linux-arm64',
    tauriPlatform: 'linux-aarch64',
    electronFeedSource: 'latest-linux-arm64.yml',
    electronFeedDest: 'latest-linux-arm64.yml',
    matchesBridgePayload(filePath) {
      return filePath.endsWith('.AppImage');
    },
    matchesExtraReleaseAssets(filePath) {
      return filePath.endsWith('.deb');
    },
  },
  {
    artifactName: 'Dimo-macos-arm64',
    tauriPlatform: 'darwin-aarch64',
    electronFeedSource: 'latest-mac.yml',
    electronFeedDest: 'latest-mac.yml',
    matchesBridgePayload(filePath) {
      return filePath.endsWith('.app.tar.gz');
    },
    matchesExtraReleaseAssets(filePath) {
      return (
        filePath.endsWith('.dmg') ||
        filePath.endsWith('.zip') ||
        filePath.endsWith('.zip.blockmap') ||
        filePath.endsWith('.dmg.blockmap')
      );
    },
  },
];

function walkFiles(root) {
  if (!fs.existsSync(root)) {
    throw new Error(`Electron artifact directory does not exist: ${root}`);
  }
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

/**
 * Updates `sha512` and `size` values inside an `electron-builder` `latest*.yml`
 * file to match the final signed release binaries placed in `outputDir`.
 * Necessary because Windows EVSign signs `.exe` installers post-pack.
 */
function refreshElectronFeedHashes(yamlContent, outputDir) {
  const lines = yamlContent.split(/\r?\n/);
  const updated = [];
  let activeFile = null;
  let topLevelPath = null;

  for (const line of lines) {
    const topPathMatch = line.match(/^path:\s*(.+?)\s*$/);
    if (topPathMatch) {
      topLevelPath = topPathMatch[1].replace(/^['"]|['"]$/g, '');
      activeFile = null;
      updated.push(line);
      continue;
    }

    const fileUrlMatch = line.match(/^(\s*-\s*url:\s*)(.+?)\s*$/);
    if (fileUrlMatch) {
      activeFile = fileUrlMatch[2].replace(/^['"]|['"]$/g, '');
      updated.push(line);
      continue;
    }

    const nestedShaMatch = line.match(/^(\s+)sha512:\s*.+$/);
    if (nestedShaMatch && activeFile) {
      const targetPath = path.join(outputDir, path.basename(activeFile));
      if (fs.existsSync(targetPath)) {
        updated.push(`${nestedShaMatch[1]}sha512: ${sha512Base64(targetPath)}`);
        continue;
      }
    }

    const nestedSizeMatch = line.match(/^(\s+)size:\s*\d+\s*$/);
    if (nestedSizeMatch && activeFile) {
      const targetPath = path.join(outputDir, path.basename(activeFile));
      if (fs.existsSync(targetPath)) {
        const size = fs.statSync(targetPath).size;
        updated.push(`${nestedSizeMatch[1]}size: ${size}`);
        continue;
      }
    }

    if (/^sha512:\s*.+$/.test(line) && topLevelPath) {
      const targetPath = path.join(outputDir, path.basename(topLevelPath));
      if (fs.existsSync(targetPath)) {
        updated.push(`sha512: ${sha512Base64(targetPath)}`);
        continue;
      }
    }

    updated.push(line);
  }

  return `${updated.join('\n').replace(/\n*$/, '')}\n`;
}

function releaseAssetUrl(repository, releaseTag, assetName) {
  return (
    `https://github.com/${repository}/releases/download/` +
    `${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`
  );
}

function readNotesOption({ notes, notesFile, releaseTag }) {
  if (typeof notesFile === 'string' && notesFile.length > 0) {
    const contents = fs.readFileSync(notesFile, 'utf8').trim();
    if (contents.length === 0) {
      throw new Error(`Updater notes file is empty: ${notesFile}`);
    }
    return contents;
  }
  if (typeof notes === 'string' && notes.trim().length > 0) {
    return notes.trim();
  }
  return `Desktop installers for ${releaseTag}.`;
}

function generateTauriBridgeManifest({
  artifactsDir,
  outputDir,
  repository,
  releaseTag,
  version,
  notes,
  notesFile,
  pubDate = new Date().toISOString(),
}) {
  for (const [name, value] of Object.entries({
    artifactsDir,
    outputDir,
    repository,
    releaseTag,
    version,
  })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${name} is required`);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const platforms = {};
  const publishedFeeds = [];

  for (const target of BRIDGE_TARGETS) {
    const artifactRoot = path.join(artifactsDir, target.artifactName);
    const allFiles = walkFiles(artifactRoot);

    const signedBridgePayloads = allFiles.filter(
      (filePath) =>
        target.matchesBridgePayload(filePath) && fs.existsSync(`${filePath}.sig`)
    );
    if (signedBridgePayloads.length !== 1) {
      throw new Error(
        `Expected one signed Tauri bridge payload for ${target.tauriPlatform} in ` +
          `${artifactRoot}, found ${signedBridgePayloads.length}`
      );
    }

    const sourcePayload = signedBridgePayloads[0];
    const sourceSig = `${sourcePayload}.sig`;
    const assetName = path.basename(sourcePayload);
    const destPayload = path.join(outputDir, assetName);
    const destSig = `${destPayload}.sig`;

    fs.copyFileSync(sourcePayload, destPayload);
    fs.copyFileSync(sourceSig, destSig);

    const signature = fs.readFileSync(sourceSig, 'utf8').trim();
    if (signature.length === 0) {
      throw new Error(`Bridge signature is empty: ${sourceSig}`);
    }

    platforms[target.tauriPlatform] = {
      signature,
      url: releaseAssetUrl(repository, releaseTag, assetName),
    };

    for (const extraFile of allFiles) {
      if (target.matchesExtraReleaseAssets(extraFile)) {
        fs.copyFileSync(
          extraFile,
          path.join(outputDir, path.basename(extraFile))
        );
      }
    }

    const feedCandidates = allFiles.filter(
      (filePath) =>
        path.basename(filePath) === target.electronFeedSource ||
        path.basename(filePath) === target.electronFeedDest
    );
    if (feedCandidates.length !== 1) {
      throw new Error(
        `Expected one Electron updater feed (${target.electronFeedSource}) for ` +
          `${target.artifactName} in ${artifactRoot}, found ${feedCandidates.length}`
      );
    }

    const rawFeed = fs.readFileSync(feedCandidates[0], 'utf8');
    const refreshedFeed = refreshElectronFeedHashes(rawFeed, outputDir);
    const destFeedPath = path.join(outputDir, target.electronFeedDest);
    fs.writeFileSync(destFeedPath, refreshedFeed, 'utf8');
    publishedFeeds.push(destFeedPath);
  }

  const manifest = {
    version,
    notes: readNotesOption({ notes, notesFile, releaseTag }),
    pub_date: pubDate,
    platforms,
  };
  const manifestPath = path.join(outputDir, 'latest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifestPath,
    publishedFeeds,
  };
}

function readOption(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index !== -1) {
    return args[index + 1] || null;
  }
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : null;
}

if (require.main === module) {
  try {
    const { manifestPath, publishedFeeds } = generateTauriBridgeManifest({
      artifactsDir: readOption('--artifacts-dir'),
      outputDir: readOption('--output-dir'),
      repository: readOption('--repository'),
      releaseTag: readOption('--release-tag'),
      version: readOption('--version'),
      notes: readOption('--notes'),
      notesFile: readOption('--notes-file'),
    });
    console.log(`Generated Tauri->Electron bridge manifest: ${manifestPath}`);
    for (const feed of publishedFeeds) {
      console.log(`Published Electron updater feed: ${feed}`);
    }
  } catch (error) {
    console.error(
      `Failed to generate Tauri->Electron bridge manifest: ${error.message}`
    );
    process.exit(1);
  }
}

module.exports = {
  BRIDGE_TARGETS,
  generateTauriBridgeManifest,
  refreshElectronFeedHashes,
  sha512Base64,
};
