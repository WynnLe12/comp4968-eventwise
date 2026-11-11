import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppModal, type ModalName } from "./components/AppModal";
import { Sidebar, Topbar } from "./components/layout";
import { LoadingState } from "./components/page";
import { PublicApp } from "./features/auth/PublicPage";
import { pagePath } from "./routes/navigation";
import type { Page, PublicPage } from "./types";

const named = <K extends string, P extends object>(load: () => Promise<Record<K, React.ComponentType<P>>>, key: K) =>
  lazy(() => load().then((module) => ({ default: module[key] })));

const Dashboard = named(() => import("./features/dashboard/Dashboard"), "Dashboard");
const Events = named(() => import("./features/events/Events"), "Events");
const Templates = named(() => import("./features/events/Templates"), "Templates");
const Budget = named(() => import("./features/budgets/Budget"), "Budget");
const Expenses = named(() => import("./features/expenses/Expenses"), "Expenses");
const Vendors = named(() => import("./features/vendors/Vendors"), "Vendors");
const Contracts = named(() => import("./features/vendors/Contracts"), "Contracts");
const Guests = named(() => import("./features/guests/Guests"), "Guests");
const Invitations = named(() => import("./features/guests/Invitations"), "Invitations");
const Tasks = named(() => import("./features/planning/Tasks"), "Tasks");
const Timeline = named(() => import("./features/planning/Timeline"), "Timeline");
const Documents = named(() => import("./features/documents/Documents"), "Documents");
const CoPlanners = named(() => import("./features/collaboration/CoPlanners"), "CoPlanners");
const Alerts = named(() => import("./features/alerts/Alerts"), "Alerts");
const Photos = named(() => import("./features/photos/Photos"), "Photos");

const publicPaths: Record<PublicPage, string> = {
  landing: "/",
  login: "/login",
  signup: "/signup",
  reset: "/reset-password",
};

function PublicRoute({ page, onAuthenticated }: { page: PublicPage; onAuthenticated: () => void }) {
  const navigate = useNavigate();
  return (
    <PublicApp
      page={page}
      setPage={(nextPage) => navigate(publicPaths[nextPage])}
      enterApp={onAuthenticated}
    />
  );
}

function WorkspaceLayout({ onSignOut }: { onSignOut: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const currentPage = (location.pathname.split("/").at(-1) || "dashboard") as Page;

  const goToPage = (page: Page) => navigate(pagePath(page));

  return (
    <div className="app-shell">
      <Sidebar
        page={currentPage}
        setPage={goToPage}
        open={sidebarOpen}
        close={() => setSidebarOpen(false)}
      />
      <div className="app-main">
        <Topbar
          toggleMenu={() => setSidebarOpen(true)}
          goAlerts={() => goToPage("alerts")}
          exit={onSignOut}
        />
        <main className="page-content">
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  // UI-only sign-in state for the wireframe; no real authentication is performed.
  const [authenticated, setAuthenticated] = useState(false);
  const [modal, setModal] = useState<ModalName | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);
  const navigate = useNavigate();
  const go = (page: Page) => navigate(pagePath(page));

  const openModal = useCallback((name: ModalName) => setModal(name), []);
  const closeModal = useCallback(() => setModal(null), []);
  const showSaved = useCallback((message: string) => {
    setModal(null);
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const enterWorkspace = () => {
    setAuthenticated(true);
    navigate("/app/dashboard");
  };

  const signOut = () => {
    setAuthenticated(false);
    navigate("/");
  };

  return (
    <>
      <Routes>
        <Route path="/" element={<PublicRoute page="landing" onAuthenticated={enterWorkspace} />} />
        <Route path="/login" element={<PublicRoute page="login" onAuthenticated={enterWorkspace} />} />
        <Route path="/signup" element={<PublicRoute page="signup" onAuthenticated={enterWorkspace} />} />
        <Route
          path="/reset-password"
          element={<PublicRoute page="reset" onAuthenticated={enterWorkspace} />}
        />

        <Route
          path="/app"
          element={
            authenticated ? <WorkspaceLayout onSignOut={signOut} /> : <Navigate to="/login" replace />
          }
        >
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard go={go} />} />
          <Route path="events" element={<Events onCreate={() => openModal("event")} go={go} />} />
          <Route path="budget" element={<Budget openReset={() => openModal("template")} />} />
          <Route path="expenses" element={<Expenses onAdd={() => openModal("expense")} />} />
          <Route path="vendors" element={<Vendors onAdd={() => openModal("vendor")} />} />
          <Route path="guests" element={<Guests onAdd={() => openModal("guest")} />} />
          <Route path="templates" element={<Templates applyTemplate={() => openModal("template")} />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="documents" element={<Documents />} />
          <Route path="invitations" element={<Invitations />} />
          <Route path="coplanners" element={<CoPlanners />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="photos" element={<Photos />} />
          <Route path="contracts" element={<Contracts />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <AppModal modal={modal} onClose={closeModal} onSaved={showSaved} />
      {toast && (
        <div className="toast" role="status">
          <span>✓</span>
          {toast}
        </div>
      )}
    </>
  );
}
