# @aztec/wsdb

Generated TypeScript IPC package for the Wsdb service.

```ts
import { WsdbService } from '@aztec/wsdb';

const service = await WsdbService.spawn({ transport: 'uds' });
try {
  const response = await service.bytes({ data: new Uint8Array([1, 2, 3]) });
} finally {
  await service.destroy();
}
```

The package resolves `aztec-wsdb` from `AZTEC_WSDB_PATH`,
an installed arch package, or `build/<platform>/aztec-wsdb`.

## Build

```sh
npm install --omit=optional
npm run build
```

To prepare per-architecture binary packages from local `build/<platform>`
directories:

```sh
npm run prepare_arch_packages
```
