import { apiUrl } from "../../services/apiConfig";

export interface GalleryPhoto {
  id: string;
  createdAt: string;
  thumbnailUrl: string;
}

export interface PhotoPage {
  items: GalleryPhoto[];
  next?: string;
}

export const guestPhotoPath = (share: string) => `/photo-gallery/${encodeURIComponent(share)}`;
export const ownerPhotoPath = (id: string) => `/events/${encodeURIComponent(id)}/photo-gallery`;
export const galleryUrl = (share: string) => new URL(`/gallery/${encodeURIComponent(share)}`, window.location.origin).href;

export function photoError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export async function photoRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const base = import.meta.env.VITE_PHOTOS_API_BASE_URL?.replace(/\/$/, "");
  const response = await fetch(base ? `${base}${path}` : apiUrl(path), { ...init, referrerPolicy: "no-referrer" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.error === "string" ? body.error : "The gallery is temporarily unavailable.");
  }
  return response.status === 204 ? undefined as T : response.json();
}

export const photoPageQuery = (after?: string) => after ? `?after=${encodeURIComponent(after)}` : "";
