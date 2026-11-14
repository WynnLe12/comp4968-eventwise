import { useEffect, useState } from "react";
import { Hub } from "aws-amplify/utils";
import { getUserProfile, type UserProfile } from "../services/authService";

export function useUserProfile() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let version = 0;
    const clear = () => {
      ++version;
      setProfile(null);
      setLoading(false);
    };
    const load = async () => {
      const current = ++version;
      setProfile(null);
      setLoading(true);
      try {
        const next = await getUserProfile();
        if (current === version) setProfile(next);
      } catch {
        // A neutral label keeps the dropdown usable when authentication or attributes fail.
        if (current === version) setProfile(null);
      } finally {
        if (current === version) setLoading(false);
      }
    };
    const refresh = () => { void load(); };
    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signedIn") refresh();
      if (payload.event === "signedOut" || payload.event === "tokenRefresh_failure") clear();
    });
    // Re-read identity when returning from another tab, including account switching there.
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      ++version;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return { profile, loading };
}
