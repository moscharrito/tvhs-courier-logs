/* Project settings.
 *
 *   GET   /api/projects/:pid/settings    admin, courier
 *   PATCH /api/projects/:pid/settings    admin
 *
 * GET returns the resolved settings and the contract defaults side by side,
 * so a screen can mark which values a person changed.
 *
 * PATCH is a partial merge, section by section: sending { pricing: { ... } }
 * leaves the sla section alone. Only leaves that actually moved are written
 * to the audit trail, with their new values. That is a deliberate exception
 * to the "field names only" rule in core/audit: these are contract
 * parameters, not PHI, and an invoice dispute turns on who changed the
 * after-hours window and when.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client } from '@libsql/client';
import { requireProjectRole } from './middleware';
import {
    SettingsPatch, DEFAULT_PROJECT_SETTINGS, resolveSettings, mergeSettings,
    changedPaths, settingValue, dueTimesFor, type ServiceType,
} from './settings';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export function createProjectSettingsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const manage = requireProjectRole('admin');
    /* The courier app reads business hours from here, so a courier reads it
     * too. A client viewer does not: these are the operating parameters of the
     * contract, including the internal goal we hold ourselves to above the
     * 85% University Health measures us against, and a pharmacy contact
     * reading that learns what our own target is. Open to any member until
     * the access matrix in ticket 4.2 made the question explicit. */
    const readers = requireProjectRole('admin', 'courier');

    function present(timezone: string, stored: Record<string, unknown>, canManage: boolean) {
        const settings = resolveSettings(stored);
        const at = new Date();
        return {
            timezone,
            settings,
            defaults: DEFAULT_PROJECT_SETTINGS,
            /** Leaves that differ from the contract default, so the UI can mark them. */
            overridden: changedPaths(DEFAULT_PROJECT_SETTINGS, settings),
            canManage,
            /* What the current rules mean for an order received right now.
               A due time is easier to sanity-check than four numbers. */
            example: (['scheduled', 'stat', 'adhoc'] as ServiceType[]).map((serviceType) => {
                const d = dueTimesFor({ serviceType, receivedAt: at }, settings);
                return {
                    serviceType,
                    receivedAt: at.toISOString(),
                    dueAt: d.dueAt ? d.dueAt.toISOString() : null,
                    minutes: d.minutes,
                    from: d.from,
                    pending: d.pending,
                    basis: d.basis,
                };
            }),
        };
    }

    async function storedFor(projectId: number): Promise<{ timezone: string; settings: Record<string, unknown> }> {
        const rs = await client.execute({ sql: 'SELECT timezone, settings FROM projects WHERE id = ?', args: [projectId] });
        const row = rs.rows[0];
        let parsed: Record<string, unknown> = {};
        try {
            const v: unknown = JSON.parse(String(row?.['settings'] ?? '{}'));
            if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
        } catch { /* a corrupt blob resolves to the defaults rather than failing the read */ }
        return { timezone: String(row?.['timezone'] ?? 'America/Chicago'), settings: parsed };
    }

    router.get('/', readers, wrap(async (req, res) => {
        const role = req.membership?.role;
        const { timezone, settings } = await storedFor(req.project!.id);
        res.json(present(timezone, settings, role === 'admin'));
    }));

    router.patch('/', manage, wrap(async (req, res) => {
        const parsed = SettingsPatch.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: 'Invalid request',
                details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
            });
            return;
        }
        const patch = parsed.data;

        const { timezone: currentTz, settings: stored } = await storedFor(req.project!.id);
        const before = resolveSettings(stored);
        const merged = mergeSettings(stored, patch);
        const after = resolveSettings(merged);

        const nextTz = patch.timezone ?? currentTz;
        const paths = changedPaths(before, after);
        const tzChanged = nextTz !== currentTz;

        if (paths.length === 0 && !tzChanged) {
            res.json(present(currentTz, stored, true));
            return;
        }

        await client.execute({
            sql: 'UPDATE projects SET settings = ?, timezone = ? WHERE id = ?',
            args: [JSON.stringify(merged), nextTz, req.project!.id],
        });

        await req.audit('project.settings.update', 'project', req.project!.code, {
            changed: [...paths, ...(tzChanged ? ['timezone'] : [])],
            to: [
                ...paths.map((p) => `${p}=${settingValue(after, p)}`),
                ...(tzChanged ? [`timezone="${nextTz}"`] : []),
            ],
        });

        res.json(present(nextTz, merged, true));
    }));

    return router;
}
