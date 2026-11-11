import { AuthCard } from "./components/AuthCard";
import { Landing } from "./pages/Landing";
import type { PublicPage } from "../../types";

export function PublicApp({
  page,
  setPage,
  enterApp,
}: {
  page: PublicPage;
  setPage: (p: PublicPage) => void;
  enterApp: () => void;
}) {
  if (page === "landing") return <Landing setPage={setPage} enterApp={enterApp} />;
  return <AuthCard page={page} setPage={setPage} enterApp={enterApp} />;
}
