/* Landing page for a project that has no module screens yet (UH until the
   dispatch module ships in Phases 1 and 2). Members see the project and
   their role; the TVHS project never lands here because its route mounts
   the legacy app directly. */

import { Link, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '../app/auth';
import { Sites } from './uh/Sites';
import { Pricing } from './uh/Pricing';
import { ListImport } from './uh/ListImport';
import { NewOrder } from './uh/NewOrder';
import { ProjectSettings } from './ProjectSettings';

const ROLE_LABEL: Record<string, string> = {
    admin: 'Admin and dispatch', courier: 'Driver', pharmacy: 'Pharmacy staff',
};

export function ProjectHome() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);

    if (!project) {
        return (
            <>
                <h1>Project not available</h1>
                <p className="izy-sub">You are not a member of <code>{code}</code>, or it does not exist.</p>
                <Link className="izy-btn secondary" to="/">Back to projects</Link>
            </>
        );
    }

    /* One role runs the operation now, so one flag covers it. */
    const canManage = project.role === 'admin';
    const canImport = canManage;

    /* A courier gets their run and nothing else. The rest of this page is
       sites, pricing, settings and the whole day's list of patient addresses,
       none of which is theirs to see. */
    if (project.role === 'courier') return <Navigate to={`/projects/${project.code}/my-run`} replace />;

    /* Pharmacy staff get their own deliveries and nothing else. This page is
       our sites, our rate card, our settings and every pharmacy's patients;
       none of it is theirs. */
    if (project.role === 'pharmacy') return <Navigate to={`/projects/${project.code}/deliveries`} replace />;

    return (
        <>
            <h1>{project.name}</h1>
            <p className="izy-sub"><code>{project.code}</code> · {project.timezone} · your role: {ROLE_LABEL[project.role] ?? project.role}</p>

            {/* FIRST, because it is why anybody opens this page.
                It used to be last: underneath the STAT form, the import, nine
                pharmacies, a nine-row rate card and a twelve-row settings
                table. Somebody coming in to see who is running late scrolled
                past sixty rows of reference data that changes twice a year to
                reach the one link they wanted. Order by how often a thing is
                needed, not by how the components were written. */}
            <nav className="izy-card izy-quick" aria-label="Dispatch">
                <Link className="izy-btn" to={`/projects/${project.code}/board`}>Open the board</Link>
                <Link className="izy-btn secondary" to={`/projects/${project.code}/orders`}>Search orders</Link>
                <Link className="izy-btn secondary" to={`/projects/${project.code}/reports`}>Performance</Link>
                <Link className="izy-btn secondary" to={`/projects/${project.code}/discrepancies`}>Discrepancies</Link>
                {canManage && (
                    <Link className="izy-btn secondary" to={`/projects/${project.code}/invoices`}>Invoices</Link>
                )}
                {/* People, not deliveries, and the only thing on this row
                    that somebody is waiting on us for. */}
                {canManage && (
                    <Link className="izy-btn secondary" to={`/projects/${project.code}/applications`}>Driver applications</Link>
                )}
                {/* Staff see exactly what the client sees. A portal nobody on
                    our side ever looks at is a portal nobody can answer a
                    question about. */}
                <Link className="izy-btn secondary" to={`/projects/${project.code}/deliveries`}>The client&apos;s view</Link>
            </nav>

            {/* The daily job, so it stays open. */}
            <ListImport projectCode={project.code} timezone={project.timezone} canImport={canImport} />

            {/* Everything below folds away and remembers that it did. These
                are reference and occasional work: a phone order, the site
                list, the rate card, the contract parameters. */}
            <NewOrder projectCode={project.code} timezone={project.timezone} canCreate={canImport} />
            <Sites projectCode={project.code} canManage={canManage} />
            <Pricing projectCode={project.code} />
            <ProjectSettings projectCode={project.code} />

            <p className="izy-muted izy-footnote">
                {/* This was a card headed "Not here yet". A whole card, with a
                    border and a heading, to say one thing is missing. It is a
                    footnote, so it looks like one. */}
                Address lookup is not switched on, so pharmacies have no coordinates, a run cannot be ordered
                by distance, and out-of-area miles cannot be measured. Everything else here is in use.
                Admins enrol staff and couriers from <Link to="/users">Users</Link>.
            </p>
        </>
    );
}
