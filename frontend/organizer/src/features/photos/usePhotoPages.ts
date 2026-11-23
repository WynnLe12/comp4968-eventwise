import { useEffect, useState } from "react";
import { photoError, type PhotoPage } from "./photoApi";

export function usePhotoPages<T extends PhotoPage>(load: (after?: string, signal?: AbortSignal) => Promise<T>) {
  const [page, setPage] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [request, setRequest] = useState<{ after?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    load(request.after, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setPage(current => request.after && current ? { ...current, next: result.next, items: [...current.items, ...result.items] } : result);
    }).catch(error => {
      if (!controller.signal.aborted) setError(photoError(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [load, request]);

  function fetchPage(after?: string) {
    setError("");
    setLoading(true);
    setRequest({ after });
  }
  function remove(id: string) {
    setPage(current => current && { ...current, items: current.items.filter(item => item.id !== id) });
  }
  return { page, loading, error, fetchPage, remove };
}
