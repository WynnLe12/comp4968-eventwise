import { useCallback, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Button } from "../../components/ui";
import { guestPhotoPath, photoError, photoPageQuery, photoRequest, type PhotoPage } from "./photoApi";
import { usePhotoPages } from "./usePhotoPages";

export function GuestGallery() {
  const { share = "" } = useParams<{ share: string }>();
  return <GuestPhotos key={share} share={share} />;
}

function GuestPhotos({ share }: { share: string }) {
  const path = guestPhotoPath(share);
  const load = useCallback((after?: string, signal?: AbortSignal) =>
    photoRequest<PhotoPage>(`${path}${photoPageQuery(after)}`, { signal }), [path]);
  const { page, error, loading, fetchPage } = usePhotoPages(load);
  const [file, setFile] = useState<File>();
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState<string>();
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || uploading) return;
    setNotice("");
    setActionError("");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) {
      setActionError("Choose a JPEG, PNG or WebP image up to 10 MB.");
      return;
    }
    const form = event.currentTarget;
    setUploading(true);
    try {
      const signed = await photoRequest<{ url: string; headers: Record<string, string> }>(`${path}/uploads`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: file.type, size: file.size }),
      });
      const response = await fetch(signed.url, {
        method: "PUT", headers: signed.headers, body: file, referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error("The upload failed. Please try again.");
      form.reset();
      setFile(undefined);
      setNotice("Photo uploaded. It will appear here after processing and approval.");
    } catch (error) { setActionError(photoError(error)); }
    finally { setUploading(false); }
  }

  async function download(id: string) {
    setDownloading(id);
    setActionError("");
    try {
      const { url } = await photoRequest<{ url: string }>(`${path}/download/${id}`);
      const link = document.createElement("a");
      link.href = url;
      link.referrerPolicy = "no-referrer";
      link.click();
    } catch (error) { setActionError(photoError(error)); }
    finally { setDownloading(undefined); }
  }

  return <main className="guest-gallery">
    <h1>Share a photo</h1>
    {error && <p role="alert">{error}</p>}
    {!page && !loading && <Button onClick={() => fetchPage()}>Try again</Button>}
    {page && <>
      <form className="gallery-upload" onSubmit={event => void upload(event)}>
        <input type="file" aria-label="Choose a JPEG, PNG or WebP image up to 10 MB"
          accept="image/jpeg,image/png,image/webp" disabled={uploading}
          onChange={event => setFile(event.target.files?.[0])} />
        <Button type="submit" disabled={uploading || !file}>{uploading ? "Uploading…" : "Upload photo"}</Button>
      </form>
      {notice && <p role="status">{notice}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      <div className="gallery-head">
        <h2>Approved photos</h2>
      </div>
      {!loading && !page.items.length && !page.next && <p>There are no approved photos yet.</p>}
      <div className="photo-grid">
        {page.items.map((photo, index) => <figure className="gallery-photo" key={photo.id}>
          <img src={photo.thumbnailUrl} referrerPolicy="no-referrer" alt={`Event photo ${index + 1}`} loading="lazy" />
          <figcaption><Button variant="secondary" disabled={Boolean(downloading)} onClick={() => void download(photo.id)}>
            {downloading === photo.id ? "Preparing…" : "Download"}
          </Button></figcaption>
        </figure>)}
      </div>
      {page.next && <Button variant="secondary" disabled={loading} onClick={() => fetchPage(page.next)}>Load more</Button>}
    </>}
    {loading && <p role="status">Loading photos…</p>}
  </main>;
}
