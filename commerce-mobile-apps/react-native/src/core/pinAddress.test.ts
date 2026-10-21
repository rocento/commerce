import { describe, expect, it, vi } from 'vitest';
import { formatPinAddress, lookupPinAddress } from '../ui/addressLookup';
describe('delivery address lookup', () => {
  it('deduplicates locality names and preserves Arabic', () => {
    expect(formatPinAddress({features:[{properties:{street:' شارع التحرير ',district:'الدقي',city:'الجيزة',state:'الجيزة',country:'مصر'}}]})).toBe('شارع التحرير, الدقي, الجيزة, مصر');
  });
  it('rejects missing results instead of inventing an address', () => {
    expect(()=>formatPinAddress({features:[]})).toThrow();
    expect(()=>formatPinAddress({features:[{properties:{country:'Egypt'}}]})).toThrow();
  });
  it('looks up valid zero coordinates without sending customer credentials', async () => {
    const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({features:[{properties:{name:'Example'}}]})});
    vi.stubGlobal('fetch',fetcher);
    try {
      const signal=new AbortController().signal;
      expect(await lookupPinAddress('https://example.test/api','0','0','ar',signal)).toBe('Example');
      expect(fetcher).toHaveBeenCalledWith('https://example.test/api/v1/location-address?lat=0.000000&lon=0.000000&lang=ar',{signal,credentials:'omit'});
      await expect(lookupPinAddress('https://example.test/api','NaN','0','en',signal)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
