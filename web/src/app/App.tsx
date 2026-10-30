import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './Layout';
import { Loading } from './Loading';
import { Login } from '../pages/Login';
import { Home } from '../pages/Home';
import { Users } from '../pages/Users';
import { UserDetail } from '../pages/UserDetail';
import { Devices } from '../pages/Devices';
import { Audit } from '../pages/Audit';
import { MailQueue } from '../pages/MailQueue';
import { LegacyTvhs } from '../pages/LegacyTvhs';
import { ProjectHome } from '../pages/ProjectHome';
import { Orders } from '../pages/uh/Orders';
import { Board } from '../pages/uh/Board';
import { MyRun } from '../pages/uh/MyRun';
import { Pickup } from '../pages/uh/Pickup';
import { Stop } from '../pages/uh/Stop';
import { Returns } from '../pages/uh/Returns';
import { ClientPortal } from '../pages/uh/ClientPortal';
import { ClientReports } from '../pages/uh/ClientReports';
import { ClientListUpload } from '../pages/uh/ClientListUpload';
import { PortalLogins } from '../pages/uh/PortalLogins';
import { Drivers } from '../pages/uh/Drivers';
import { Roster } from '../pages/uh/Roster';
import { DriverRecord } from '../pages/uh/DriverRecord';
import { Discrepancies } from '../pages/uh/Discrepancies';
import { Reports } from '../pages/uh/Reports';
import { Invoices } from '../pages/uh/Invoices';
import { OrderDetail } from '../pages/uh/OrderDetail';
import { Applications } from '../pages/uh/Applications';

function AdminOnly({ children }: { children: JSX.Element }) {
    const { user } = useAuth();
    return user?.role === 'admin' ? children : <Navigate to="/" replace />;
}

/* A DRIVER'S WEB IS THE DRIVER'S APP, AND NOTHING ELSE.
 *
 * Every driver uses the browser for the first month, so the browser has to
 * offer a driver exactly what the phone does -- no more. It did not. A
 * courier signed in on the web could open the dispatch screens by typing
 * the path or by following "Back to orders" from their own delivery, and
 * what they got was an operations console: a filter naming all nine
 * University Health counters, a Courier box inviting them to look somebody
 * else up, Export to Excel, and the contract's on-time figures.
 *
 * NO PATIENT DATA LEAKED, and that is worth stating precisely because it
 * decides what this fix is. The server scopes a courier to their own work
 * in three places -- the order list ANDs `assigned_to_username = me` last,
 * so no query parameter reaches past it; the single order 403s if it is not
 * theirs; pricing is withheld. The board, roster, reports and invoices
 * refuse a courier outright. What the client was leaking was the SHAPE of
 * the operation, and what it was offering was a screen nobody should be
 * handed mid-round.
 *
 * The board was worse than useless: it rendered, asked the server, got 403,
 * and asked again, forever. A driver tapping it got a spinner that never
 * resolved and a request every few seconds.
 *
 * So: a courier gets the driver routes and is sent back to their run from
 * anything else. Allow-list, not deny-list -- a route added later is
 * closed to couriers until somebody decides it is open, which is the right
 * way round for a screen that might carry another person's prescription.
 */
function DriverRoutesOnly({ children }: { children: JSX.Element }) {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const role = projects.find((p) => p.code === code)?.role;
    /* Only `courier` is redirected. An unknown code or a project the session
       has not loaded yet falls through to the page, which handles both --
       bouncing on absent membership would flash a redirect on every cold
       load. */
    return role === 'courier' ? <Navigate to={`/projects/${code}/my-run`} replace /> : children;
}

export function App() {
    const { loading, user } = useAuth();

    if (loading) return <Loading full />;
    if (!user) return <Login />;

    // Everyone lands on the project picker after sign-in and chooses where to go.
    return (
        <Routes>
            <Route path="/projects/tvhs/tvhs/*" element={<LegacyTvhs />} />
            <Route element={<Layout />}>
                <Route path="/" element={<Home />} />
                <Route path="/projects/:code/board" element={<DriverRoutesOnly><Board /></DriverRoutesOnly>} />
                <Route path="/projects/:code/my-run" element={<MyRun />} />
                <Route path="/projects/:code/runs/:runId/pickup" element={<Pickup />} />
                <Route path="/projects/:code/returns" element={<Returns />} />
                <Route path="/projects/:code/deliveries" element={<DriverRoutesOnly><ClientPortal /></DriverRoutesOnly>} />
                {/* The reporting Karthik Munnam asked for, read by the client
                    themselves and scoped to the pharmacies they may see. */}
                <Route path="/projects/:code/performance" element={<DriverRoutesOnly><ClientReports /></DriverRoutesOnly>} />
                <Route path="/projects/:code/send-list" element={<DriverRoutesOnly><ClientListUpload /></DriverRoutesOnly>} />
                {/* The contract manager resetting their own counters'
                    passwords. The server refuses anybody without the
                    capability and the page says so in words, which is better
                    than a redirect for somebody who might legitimately be
                    here -- a lead, a pharmacy account. A COURIER is not one
                    of those: they have nothing to be told, so the guard sends
                    them back to their run before the page loads. See
                    pages/uh/PortalLogins.tsx. */}
                <Route path="/projects/:code/pharmacy-logins" element={<DriverRoutesOnly><PortalLogins /></DriverRoutesOnly>} />
                {/* `mine` comes from the route rather than from a prop a
                    caller could get wrong: /my-deliveries asks the server for
                    /drivers/me, which takes the username off the session. */}
                <Route path="/projects/:code/my-deliveries" element={<DriverRecord mine />} />
                <Route path="/projects/:code/drivers" element={<DriverRoutesOnly><Drivers /></DriverRoutesOnly>} />
                {/* Standing driver-to-pharmacy assignments. The server
                    refuses anybody who is not dispatch and the page says so,
                    which is the right answer for everybody except a courier:
                    a driver has no business on the roster screen at all and
                    is sent back to their run. Same pattern as
                    pharmacy-logins above. */}
                <Route path="/projects/:code/roster" element={<DriverRoutesOnly><Roster /></DriverRoutesOnly>} />
                <Route path="/projects/:code/drivers/:username" element={<DriverRoutesOnly><DriverRecord /></DriverRoutesOnly>} />
                <Route path="/projects/:code/reports" element={<DriverRoutesOnly><Reports /></DriverRoutesOnly>} />
                <Route path="/projects/:code/discrepancies" element={<Discrepancies />} />
                <Route path="/projects/:code/invoices" element={<DriverRoutesOnly><Invoices /></DriverRoutesOnly>} />
                {/* NOT GUARDED, deliberately. This page checks the role itself and
                    answers "Not yours to see" with a sentence about somebody's
                    licence and background check. That is a better answer than
                    a redirect, and it is the only one of these screens that
                    gives it -- the rest render a dispatch console or hang on a
                    403, which is why they are guarded and this is not. */}
                <Route path="/projects/:code/applications" element={<Applications />} />
                <Route path="/projects/:code/orders" element={<DriverRoutesOnly><Orders /></DriverRoutesOnly>} />
                <Route path="/projects/:code/orders/:orderId/stop" element={<Stop />} />
                <Route path="/projects/:code/orders/:orderId" element={<OrderDetail />} />
                <Route path="/projects/:code/*" element={<DriverRoutesOnly><ProjectHome /></DriverRoutesOnly>} />
                <Route path="/devices" element={<Devices />} />
                <Route path="/users" element={<AdminOnly><Users /></AdminOnly>} />
                <Route path="/users/:username" element={<AdminOnly><UserDetail /></AdminOnly>} />
                <Route path="/audit" element={<AdminOnly><Audit /></AdminOnly>} />
                <Route path="/mail-queue" element={<AdminOnly><MailQueue /></AdminOnly>} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
        </Routes>
    );
}
