import { type IpcClientAsync, UdsIpcClient, createNapiShmAsyncClient } from '@aztec/ipc-runtime';

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

import { AsyncApi, type IpcErrorFactory } from './generated/async.js';
import { findWsdbBinary } from './platform.js';

export * from './generated/api_types.js';
export { AsyncApi } from './generated/async.js';

export type WsdbTransport = 'uds' | 'shm';

export interface WsdbServiceOptions {
  binaryPath?: string;
  transport?: WsdbTransport;
  logger?: (msg: string) => void;
  connectTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  createError?: IpcErrorFactory;
  napiPath?: string;
  clientId?: number;
}

let instanceCounter = 0;

class SpawnedBackend implements IpcClientAsync {
  private constructor(
    private child: ChildProcess,
    private client: IpcClientAsync,
    private ipcPath: string,
    private transport: WsdbTransport,
    private exitPromise: Promise<void>,
  ) {}

  static async spawn(options: WsdbServiceOptions = {}): Promise<SpawnedBackend> {
    const binaryPath = findWsdbBinary(options.binaryPath);
    if (!binaryPath) {
      throw new Error('aztec-wsdb binary not found');
    }

    const transport = options.transport ?? 'uds';
    const instanceId = 'wsdb-' + process.pid + '-' + threadId + '-' + instanceCounter++;
    const ipcPath = transport === 'shm' ? instanceId + '.shm' : join(tmpdir(), instanceId + '.sock');

    if (transport === 'uds' && existsSync(ipcPath)) {
      unlinkSync(ipcPath);
    }

    const child = spawn(binaryPath, ['--socket', ipcPath, ...(options.extraArgs ?? [])], {
      stdio: ['ignore', options.logger ? 'pipe' : 'ignore', options.logger ? 'pipe' : 'ignore'],
      env: { ...process.env, ...(options.env ?? {}) },
    });

    if (options.logger) {
      child.stdout?.on('data', (data: Buffer) => options.logger?.('[aztec-wsdb stdout] ' + data.toString().trimEnd()));
      child.stderr?.on('data', (data: Buffer) => options.logger?.('[aztec-wsdb stderr] ' + data.toString().trimEnd()));
    }

    const exitPromise = new Promise<void>(resolve => {
      child.on('exit', () => resolve());
    });

    const client = await connectClient(child, ipcPath, transport, options);
    return new SpawnedBackend(child, client, ipcPath, transport, exitPromise);
  }

  getIpcPath(): string {
    return this.ipcPath;
  }

  call(input: Uint8Array): Promise<Uint8Array> {
    return this.client.call(input);
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM');
    }
    await this.exitPromise;
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.removeAllListeners();
    cleanupIpcPath(this.ipcPath, this.transport);
  }
}

async function connectClient(
  child: ChildProcess,
  ipcPath: string,
  transport: WsdbTransport,
  options: WsdbServiceOptions,
): Promise<IpcClientAsync> {
  const timeoutMs = options.connectTimeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    if (child.exitCode !== null) {
      throw new Error('aztec-wsdb exited before IPC connection was ready');
    }
    try {
      if (transport === 'uds') {
        return await UdsIpcClient.connect(ipcPath, { connectTimeoutMs: Math.max(1, deadline - Date.now()) });
      }
      if (transport === 'shm') {
        return createNapiShmAsyncClient(ipcPath.replace(/\.shm$/, ''), {
          clientId: options.clientId ?? 0,
          customAddonPath: options.napiPath,
        });
      }
      throw new Error('Unsupported transport: ' + transport);
    } catch (err) {
      lastError = err;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  throw new Error(
    'Timed out connecting to aztec-wsdb: ' + (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

function cleanupIpcPath(ipcPath: string, transport: WsdbTransport) {
  try {
    if (transport === 'uds' && existsSync(ipcPath)) {
      unlinkSync(ipcPath);
    }
    if (transport === 'shm') {
      const shmName = ipcPath.replace(/\.shm$/, '');
      for (const suffix of ['_request', '_response']) {
        const shmPath = '/dev/shm/' + shmName + suffix;
        if (existsSync(shmPath)) {
          unlinkSync(shmPath);
        }
      }
    }
  } catch {}
}

export class WsdbService extends AsyncApi {
  private constructor(
    private spawnedBackend: SpawnedBackend,
    createError?: IpcErrorFactory,
  ) {
    super(spawnedBackend, createError);
  }

  static async spawn(options: WsdbServiceOptions = {}): Promise<WsdbService> {
    const backend = await SpawnedBackend.spawn(options);
    return new WsdbService(backend, options.createError);
  }

  getIpcPath(): string {
    return this.spawnedBackend.getIpcPath();
  }
}
