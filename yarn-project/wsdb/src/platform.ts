import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Platform = 'x86_64-linux' | 'x86_64-darwin' | 'aarch64-linux' | 'aarch64-darwin';

const PLATFORM_TO_BUILD_DIR: Record<Platform, string> = {
  'x86_64-linux': 'amd64-linux',
  'x86_64-darwin': 'amd64-macos',
  'aarch64-linux': 'arm64-linux',
  'aarch64-darwin': 'arm64-macos',
};

const PLATFORM_TO_PACKAGE: Record<Platform, string> = {
  'x86_64-linux': '@aztec/wsdb-linux-x64',
  'x86_64-darwin': '@aztec/wsdb-darwin-x64',
  'aarch64-linux': '@aztec/wsdb-linux-arm64',
  'aarch64-darwin': '@aztec/wsdb-darwin-arm64',
};

function currentDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function detectPlatform(): Platform | null {
  if (process.arch === 'x64' && process.platform === 'linux') return 'x86_64-linux';
  if (process.arch === 'x64' && process.platform === 'darwin') return 'x86_64-darwin';
  if (process.arch === 'arm64' && process.platform === 'linux') return 'aarch64-linux';
  if (process.arch === 'arm64' && process.platform === 'darwin') return 'aarch64-darwin';
  return null;
}

function findPackageRoot(): string | null {
  let dir = currentDir();
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      if (fs.existsSync(path.join(dir, 'build')) || fs.existsSync(path.join(dir, 'dest'))) {
        return dir;
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function findArchPackageDir(platform: Platform): string | null {
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve(PLATFORM_TO_PACKAGE[platform] + '/package.json'));
  } catch {
    return null;
  }
}

export function findWsdbBinary(customPath?: string): string | null {
  if (customPath) {
    return fs.existsSync(customPath) ? path.resolve(customPath) : null;
  }

  const envPath = process.env.AZTEC_WSDB_PATH;
  if (envPath) {
    return fs.existsSync(envPath) ? path.resolve(envPath) : null;
  }

  const platform = detectPlatform();
  if (!platform) {
    return null;
  }

  const archDir = findArchPackageDir(platform);
  if (archDir) {
    const candidate = path.join(archDir, 'aztec-wsdb');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const packageRoot = findPackageRoot();
  if (!packageRoot) {
    return null;
  }

  const localCandidate = path.join(packageRoot, 'build', PLATFORM_TO_BUILD_DIR[platform], 'aztec-wsdb');
  return fs.existsSync(localCandidate) ? localCandidate : null;
}

export const ARCH_PACKAGE_STEM = 'wsdb';
