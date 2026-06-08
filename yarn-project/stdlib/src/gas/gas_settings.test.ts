import { MAX_TX_DA_GAS } from '@aztec/constants';

import { Gas } from './gas.js';
import { GasFees } from './gas_fees.js';
import { GasSettings } from './gas_settings.js';
import { getDefaultNetworkTxGasLimits } from './tx_gas_limits.js';

describe('GasSettings.fallback', () => {
  const maxFeesPerGas = new GasFees(10, 10);

  it('defaults gas limits to the per-tx maximum for the network', () => {
    const settings = GasSettings.fallback({ maxFeesPerGas });
    expect(settings.gasLimits.daGas).toBe(getDefaultNetworkTxGasLimits().daGas);
    expect(settings.gasLimits.l2Gas).toBe(getDefaultNetworkTxGasLimits().l2Gas);
    expect(settings.gasLimits.daGas).toBeLessThanOrEqual(MAX_TX_DA_GAS);
  });

  it('keeps default teardown limits at or below the total limits', () => {
    const settings = GasSettings.fallback({ maxFeesPerGas });
    expect(settings.teardownGasLimits.daGas).toBeLessThanOrEqual(settings.gasLimits.daGas);
    expect(settings.teardownGasLimits.l2Gas).toBeLessThanOrEqual(settings.gasLimits.l2Gas);
  });

  it('derives teardown from explicit gas limits so teardown never exceeds the total', () => {
    // A small total (e.g. a network with many blocks per checkpoint) must still produce a valid teardown.
    const gasLimits = new Gas(100, 800);
    const settings = GasSettings.fallback({ gasLimits, maxFeesPerGas });
    expect(settings.teardownGasLimits.daGas).toBeLessThanOrEqual(gasLimits.daGas);
    expect(settings.teardownGasLimits.l2Gas).toBeLessThanOrEqual(gasLimits.l2Gas);
  });
});
