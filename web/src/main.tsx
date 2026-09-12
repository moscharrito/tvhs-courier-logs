import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import { AuthProvider } from './app/auth';
import './styles.css';

/* Register the service worker so the app is installable on a courier's
   phone. It caches the shell only and never anything from /api: see
   web/public/sw.js for why that rule is not negotiable.

   Registration is skipped in development so a stale worker cannot serve an
   old bundle over the Vite dev server. */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
    const register = () => {
        void navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
            /* An unavailable worker costs offline support and nothing else, so
               this never blocks the app. It is logged rather than swallowed:
               a silent failure here looks exactly like a working install
               until a courier loses signal and finds out it is not. */
            console.warn('TAG: offline support is unavailable.', err);
        });
    };
    // Waiting for `load` when the document has already loaded would mean
    // never registering at all, which is what a warm cache or a fast
    // connection produces.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
}

createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <BrowserRouter>
            <AuthProvider>
                <App />
            </AuthProvider>
        </BrowserRouter>
    </React.StrictMode>,
);
