import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Hub } from "aws-amplify/utils";
import { authErrorMessage, requireAuthSession, signOut as cognitoSignOut } from "./features/auth/services/authService";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppModal, type ModalName } from "./components/AppModal";
import { Sidebar, Topbar } from "./components/layout";
import { LoadingState } from "./components/page";
import { PublicApp } from "./features/auth/PublicPage";
import { EventsProvider, useEvents } from "./features/events/EventsContext";
import { EventWorkspace } from "./features/events/EventWorkspace";
import { pagePath } from "./routes/navigation";
import type { Page, PublicPage } from "./types";

type ToastTone = "success" | "error";

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

function PublicRoute({ page, authenticated, onAuthenticated }: {
  page: PublicPage;
  authenticated: boolean;
  onAuthenticated: () => void;
}) {
  const navigate = useNavigate();
  if (authenticated && page !== "landing") return <Navigate to="/app/dashboard" replace />;
  return (
    <PublicApp
      page={page}
      setPage={(nextPage) => navigate(publicPaths[nextPage])}
      enterApp={onAuthenticated}
    />
  );
}

function WorkspaceCreateEvent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh, expireSession } = useEvents();
  const navigate = useNavigate();
  return <AppModal modal={open ? "event" : null} onClose={onClose} onSaved={onClose}
    onEventSessionExpired={expireSession}
    onEventCreated={async ({ userId, event }) => {
      const loaded = await refresh({ userId, id: event.event_id });
      if (loaded) navigate("/app/dashboard");
      return loaded;
    }} />;
}

function WorkspaceLayout({ onSignOut, onSessionExpired, onEventDeleted }: { onSignOut: () => void; onSessionExpired: () => void; onEventDeleted: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = useCallback(() => setCreateOpen(true), []);
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const location = useLocation();
  const navigate = useNavigate();
  const currentPage = (location.pathname.split("/").at(-1) || "dashboard") as Page;

  const goToPage = (page: Page) => navigate(pagePath(page));

  return (
    <EventsProvider onSessionExpired={onSessionExpired} onCreate={openCreate} onEdit={closeCreate}
      onDeleted={() => { closeCreate(); navigate("/app/events"); onEventDeleted(); }}>
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
            <EventWorkspace page={currentPage}>
              <Suspense fallback={<LoadingState />}><Outlet /></Suspense>
            </EventWorkspace>
          </main>
        </div>
      </div>
      <WorkspaceCreateEvent open={createOpen} onClose={closeCreate} />
    </EventsProvider>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const sessionVersion = useRef(0);
  const signOutPending = useRef(false);
  const [modal, setModal] = useState<ModalName | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const navigate = useNavigate();
  const go = (page: Page) => navigate(pagePath(page));

  const onEventSessionExpired = useCallback(async () => {
    if (signOutPending.current) return;
    signOutPending.current = true;
    ++sessionVersion.current;
    setSigningOut(true);
    try {
      await cognitoSignOut();
      setToast({ message: "Your session has expired. Please sign in again.", tone: "error" });
    } catch {
      setToast({ message: "Your session is unavailable. Please sign in again.", tone: "error" });
    } finally {
      signOutPending.current = false;
      setAuthenticated(false);
      setCheckingSession(false);
      setSigningOut(false);
      navigate("/login", { replace: true });
    }
  }, [navigate]);

  const openModal = useCallback((name: ModalName) => setModal(name), []);
  const closeModal = useCallback(() => setModal(null), []);
  const notify = useCallback((message: string, tone: ToastTone = "success") => {
    setToast({ message, tone });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), tone === "error" ? 4500 : 2600);
  }, []);
  const showSaved = useCallback(
    (message: string) => {
      setModal(null);
      notify(message);
    },
    [notify],
  );

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const refreshSession = useCallback(async () => {
    if (signOutPending.current) return;
    const version = ++sessionVersion.current;
    try {
      await requireAuthSession();
      if (version === sessionVersion.current) setAuthenticated(true);
    } catch {
      if (version === sessionVersion.current) setAuthenticated(false);
    } finally {
      if (version === sessionVersion.current) setCheckingSession(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
    const refresh = () => { void refreshSession(); };
    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signedOut" || payload.event === "tokenRefresh_failure") {
        ++sessionVersion.current;
        setAuthenticated(false);
        setCheckingSession(false);
      } else if (payload.event === "signedIn") {
        refresh();
      }
    });
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      ++sessionVersion.current;
      unsubscribe();
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [refreshSession]);

  useEffect(() => {
    if (!authenticated) setModal(null);
  }, [authenticated]);

  // This is also the landing demo callback. It never grants a mock session.
  const enterWorkspace = async () => {
    if (signOutPending.current) return;
    const version = ++sessionVersion.current;
    try {
      await requireAuthSession();
      if (version !== sessionVersion.current) return;
      setAuthenticated(true);
      setCheckingSession(false);
      navigate("/app/dashboard");
    } catch {
      if (version !== sessionVersion.current) return;
      setAuthenticated(false);
      setCheckingSession(false);
      navigate("/login");
    }
  };

  const signOut = async () => {
    if (signOutPending.current) return;
    signOutPending.current = true;
    ++sessionVersion.current;
    setSigningOut(true);
    try {
      await cognitoSignOut();
      setAuthenticated(false);
      setModal(null);
      setToast(null);
      navigate("/");
    } catch (error) {
      setToast({ message: `Sign out failed. ${authErrorMessage(error)}`, tone: "error" });
    } finally {
      signOutPending.current = false;
      setSigningOut(false);
      setCheckingSession(false);
    }
  };

  if (checkingSession || signingOut) return <LoadingState label={signingOut ? "Signing out?" : "Checking your session?"} />;

  return (
    <>
      <Routes>
        <Route path="/" element={<PublicRoute authenticated={authenticated} page="landing" onAuthenticated={enterWorkspace} />} />
        <Route path="/login" element={<PublicRoute authenticated={authenticated} page="login" onAuthenticated={enterWorkspace} />} />
        <Route path="/signup" element={<PublicRoute authenticated={authenticated} page="signup" onAuthenticated={enterWorkspace} />} />
        <Route
          path="/reset-password"
          element={<PublicRoute authenticated={authenticated} page="reset" onAuthenticated={enterWorkspace} />}
        />

        <Route
          path="/app"
          element={
            authenticated ? <WorkspaceLayout onSignOut={signOut} onSessionExpired={onEventSessionExpired}
              onEventDeleted={() => notify("Event deleted successfully.")} /> : <Navigate to="/login" replace />
          }
        >
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard go={go} />} />
          <Route path="events" element={<Events go={go} />} />
          <Route path="budget" element={<Budget openReset={() => openModal("template")} />} />
          <Route path="expenses" element={<Expenses />} />
          <Route path="vendors" element={<Vendors onToast={notify} />} />
          <Route path="guests" element={<Guests onToast={notify} />} />
          <Route path="templates" element={<Templates />} />
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

      <AppModal modal={authenticated ? modal : null} onClose={closeModal} onSaved={showSaved} />
      {toast && (
        <div
          className={`toast${toast.tone === "error" ? " toast-error" : ""}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          <span aria-hidden="true">{toast.tone === "error" ? "!" : "✓"}</span>
          {toast.message}
        </div>
      )}
    </>
  );
}
