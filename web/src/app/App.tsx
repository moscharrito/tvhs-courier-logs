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
import { OrderDetail } from '../pages/uh/OrderDetail';

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
