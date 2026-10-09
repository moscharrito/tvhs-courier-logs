import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './Layout';
import { Loading } from './Loading';
import { Login } from '../pages/Login';
import { Home } from '../pages/Home';
import { Users } from '../pages/Users';
import { UserDetail } from '../pages/UserDetail';
import { Devices } from '../pages/Devices';
import { Audit } from '../pages/Audit';
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
                <Route path="/projects/:code/board" element={<Board />} />
                <Route path="/projects/:code/my-run" element={<MyRun />} />
                <Route path="/projects/:code/runs/:runId/pickup" element={<Pickup />} />
                <Route path="/projects/:code/returns" element={<Returns />} />
                <Route path="/projects/:code/deliveries" element={<ClientPortal />} />
                {/* The reporting Karthik Munnam asked for, read by the client
                    themselves and scoped to the pharmacies they may see. */}
                <Route path="/projects/:code/performance" element={<ClientReports />} />
                <Route path="/projects/:code/send-list" element={<ClientListUpload />} />
                {/* The contract manager resetting their own counters'
                    passwords. No route guard: the server refuses anybody
                    without the capability and the page says so in words, which
                    is better than a redirect to somewhere they did not ask
                    for. See pages/uh/PortalLogins.tsx. */}
                <Route path="/projects/:code/pharmacy-logins" element={<PortalLogins />} />
                {/* `mine` comes from the route rather than from a prop a
                    caller could get wrong: /my-deliveries asks the server for
                    /drivers/me, which takes the username off the session. */}
                <Route path="/projects/:code/my-deliveries" element={<DriverRecord mine />} />
                <Route path="/projects/:code/drivers" element={<Drivers />} />
                <Route path="/projects/:code/drivers/:username" element={<DriverRecord />} />
                <Route path="/projects/:code/reports" element={<Reports />} />
                <Route path="/projects/:code/discrepancies" element={<Discrepancies />} />
                <Route path="/projects/:code/invoices" element={<Invoices />} />
                <Route path="/projects/:code/applications" element={<Applications />} />
                <Route path="/projects/:code/orders" element={<Orders />} />
                <Route path="/projects/:code/orders/:orderId/stop" element={<Stop />} />
                <Route path="/projects/:code/orders/:orderId" element={<OrderDetail />} />
                <Route path="/projects/:code/*" element={<ProjectHome />} />
                <Route path="/devices" element={<Devices />} />
                <Route path="/users" element={<AdminOnly><Users /></AdminOnly>} />
                <Route path="/users/:username" element={<AdminOnly><UserDetail /></AdminOnly>} />
                <Route path="/audit" element={<AdminOnly><Audit /></AdminOnly>} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
        </Routes>
    );
}
