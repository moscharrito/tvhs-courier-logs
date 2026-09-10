/* Mounts the legacy TVHS courier log app (server/public, served at /legacy)
   inside the shell without an iframe.

   How it works: the legacy index.html body is fetched and injected into a
   host element; its stylesheet is attached to <head> while mounted; its
   script (which declares top-level `let`s, so it can load only once per
   page) is loaded on first mount and re-entered via its global
   checkSession() on later mounts. The legacy `logout` global is replaced by
   the shell's sign-out so both agree on who is signed in.

   Drivers whose only membership is a TVHS courier one are routed here
   directly after login, so their experience is unchanged. */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../app/auth';

const LEGACY_BASE = '/legacy/';
const LEGACY_STYLE_ID = 'izy-legacy-style';
const FLATPICKR_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/flatpickr/4.6.13/flatpickr.min.css';
const FLATPICKR_JS = 'https://cdnjs.cloudflare.com/ajax/libs/flatpickr/4.6.13/flatpickr.min.js';

declare global {
    interface Window {
        checkSession?: () => Promise<void>;
        logout?: () => Promise<void>;
        __izyLegacyLoaded?: boolean;
    }
}

function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) return resolve();
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`failed to load ${src}`));
        document.body.appendChild(s);
    });
}

function attachStyles(): () => void {
    const links: HTMLLinkElement[] = [];
    for (const href of [FLATPICKR_CSS, `${LEGACY_BASE}style.css`]) {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        l.dataset['legacy'] = LEGACY_STYLE_ID;
        document.head.appendChild(l);
        links.push(l);
    }
    return () => links.forEach((l) => l.remove());
}

async function legacyBodyHtml(): Promise<string> {
    const res = await fetch(`${LEGACY_BASE}index.html`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`legacy app not available (${res.status})`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    doc.querySelectorAll('script').forEach((s) => s.remove());
    return doc.body.innerHTML;
}

export function LegacyTvhs() {
    const host = useRef<HTMLDivElement>(null);
    const { user, signOut } = useAuth();
    const navigate = useNavigate();
    const [error, setError] = useState<string | null>(null);
    const isCourierOnly = user?.role !== 'admin';

    useEffect(() => {
        let cancelled = false;
        const detachStyles = attachStyles();

        (async () => {
            const html = await legacyBodyHtml();
            if (cancelled || !host.current) return;
            host.current.innerHTML = html;

            await loadScript(FLATPICKR_JS);
            if (!window.__izyLegacyLoaded) {
                await loadScript(`${LEGACY_BASE}app.js`);
                window.__izyLegacyLoaded = true;
            }
            if (cancelled) return;

            // Shell owns sign-out. Inline onclick="logout()" resolves this global at call time.
            window.logout = async () => {
                await signOut();
                navigate('/', { replace: true });
            };
            if (typeof window.checkSession === 'function') await window.checkSession();
        })().catch((err: unknown) => {
            if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the TVHS app');
        });

        return () => {
            cancelled = true;
            detachStyles();
            if (host.current) host.current.innerHTML = '';
            // flatpickr appends its calendar popups to <body>; drop them so
            // they do not linger (hidden) behind the shell's other screens.
            document.querySelectorAll('.flatpickr-calendar').forEach((el) => el.remove());
        };
    }, [signOut, navigate]);

    return (
        <div>
            <div className="izy-legacy-bar">
                <b>Izy Ops</b>
                <span>TVHS RMD Courier</span>
                {!isCourierOnly && <Link to="/" style={{ marginLeft: 'auto' }}>Back to platform</Link>}
                {isCourierOnly && <button className="izy-link" style={{ marginLeft: 'auto', color: '#fff' }} type="button" onClick={() => { void window.logout?.(); }}>Sign out</button>}
            </div>
            {error && <div className="izy-alert error" role="alert" style={{ margin: 12 }}>{error}</div>}
            <div ref={host} className="izy-legacy-host" data-testid="legacy-host" />
        </div>
    );
}
