import { describe, it, expect } from 'vitest';
import { defaultServer, NoServerError, serverForContract } from './servers';

const BOTH = {
    apiBaseUrl: 'http://192.168.86.83:3000',
    tvhsApiBaseUrl: 'https://logs.izyglobalservices.com',
};

describe('which server a contract talks to', () => {
    it('sends TVHS to its own server and UH to the default', () => {
        /* The whole point. TVHS is live with two drivers filing against it;
           UH is in test on the laptop. Getting this backwards would write
           test deliveries into the live courier log. */
        expect(serverForContract(BOTH, 'tvhs')).toBe('https://logs.izyglobalservices.com');
        expect(serverForContract(BOTH, 'uh')).toBe('http://192.168.86.83:3000');
    });

    it('sends anything it has never heard of to the default', () => {
        expect(serverForContract(BOTH, 'something-new')).toBe('http://192.168.86.83:3000');
        expect(serverForContract(BOTH, '')).toBe('http://192.168.86.83:3000');
    });

    it('falls back rather than failing when TVHS has no server of its own', () => {
        /* Every build before this change had one server. A build that was
           never told where TVHS lives should still work, because a driver on
           the road is not helped by a purist error message. */
        expect(serverForContract({ apiBaseUrl: 'http://127.0.0.1:3000' }, 'tvhs')).toBe('http://127.0.0.1:3000');
        expect(serverForContract({ ...BOTH, tvhsApiBaseUrl: '   ' }, 'tvhs')).toBe('http://192.168.86.83:3000');
    });

    it('throws when there is no default at all, rather than guessing localhost', () => {
        /* apiUrl.cjs exists to stop a submitted build reaching for a server
           on the reviewer's own phone. This is the same refusal at run time. */
        expect(() => defaultServer({})).toThrow(NoServerError);
        expect(() => serverForContract({}, 'uh')).toThrow(NoServerError);
    });

    it('still finds the TVHS server when there is no default', () => {
        /* A TVHS-only build is a coherent thing to want and should not be
           held up by UH having nowhere to point. */
        expect(serverForContract({ tvhsApiBaseUrl: 'https://logs.izyglobalservices.com' }, 'tvhs'))
            .toBe('https://logs.izyglobalservices.com');
    });

    it('drops a trailing slash, so paths do not end up doubled', () => {
        expect(serverForContract({ apiBaseUrl: 'http://x:3000/', tvhsApiBaseUrl: 'https://y//' }, 'tvhs')).toBe('https://y');
        expect(serverForContract({ apiBaseUrl: 'http://x:3000/' }, 'uh')).toBe('http://x:3000');
    });
});
