import { useCallback, useState } from "react";
import QRCode from "qrcode";
import { Button } from "../../components/ui";
import { PageHeader } from "../../components/page";
import { useEvents } from "../events/EventsContext";
import { authenticatedEventRequest } from "../events/services/eventApi";
import { galleryUrl, ownerPhotoPath, photoError, photoPageQuery, photoRequest, type PhotoPage } from "./photoApi";
import { usePhotoPages } from "./usePhotoPages";

async function ownerRequest<T>(path: string, init?: RequestInit) {
  const { token } = await authenticatedEventRequest();
  return photoRequest<T>(path, { ...init, headers: { Authorization: `Bearer ${token}` } });
}

export function Photos() {
  const { selectedEvent } = useEvents();
  return <>
    <PageHeader page="photos" />
    {selectedEvent?.role === "OWNER"
      ? <PhotoModeration key={selectedEvent.event_id} eventId={selectedEvent.event_id} />
      : <p>{selectedEvent ? "Only the event owner can manage the photo gallery." : "Select an event to open its gallery."}</p>}
  </>;
}

function PhotoModeration({ eventId }: { eventId: string }) {
  const path = ownerPhotoPath(eventId);
  const load = useCallback(async (after?: string, signal?: AbortSignal) => {
    const pending = ownerRequest<PhotoPage>(`${path}/pending${photoPageQuery(after)}`, { signal });
    if (after) return { ...await pending, shareInfo: undefined };
    const [{ share }, page] = await Promise.all([ownerRequest<{ share: string }>(path, { signal }), pending]);
    const url = galleryUrl(share);
    return { ...page, shareInfo: { url, qr: await QRCode.toDataURL(url, { width: 256, margin: 4 }) } };
  }, [path]);
  const { page, loading, error, fetchPage, remove } = usePhotoPages(load);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [approving, setApproving] = useState<string>();

  async function approve(id: string) {
    setApproving(id);
    setActionError("");
    setNotice("");
    try {
      await ownerRequest<void>(`${path}/approve/${id}`, { method: "POST" });
      remove(id);
      setNotice("Photo approved and visible in the guest gallery.");
    } catch (error) { setActionError(photoError(error)); }
    finally { setApproving(undefined); }
  }

  async function copy(url: string) {
    setActionError("");
    setNotice("");
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Gallery link copied.");
    } catch {
      setActionError("Unable to copy automatically. Open the guest gallery to copy its address.");
    }
  }

  return <>
    {page?.shareInfo && <section className="qr-banner">
      <img className="gallery-qr" src={page.shareInfo.qr} alt="QR code for the guest gallery" />
      <div>
        <h2>Guest photo gallery</h2>
        <p>Guests can scan the QR code to upload and view approved photos without an account.</p>
        <div className="gallery-controls">
          <Button variant="secondary" icon="link" onClick={() => void copy(page.shareInfo!.url)}>Copy gallery link</Button>
          <a href={page.shareInfo.url} target="_blank" rel="noreferrer">Open guest gallery</a>
        </div>
      </div>
    </section>}
    <div className="gallery-head">
      <h3>Pending approval</h3>
      <Button variant="secondary" disabled={loading || Boolean(approving)} onClick={() => fetchPage()}>Refresh</Button>
    </div>
    {error && <p role="alert">{error}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">Loading photos…</p>}
    {page && !loading && !page.items.length && !page.next && <p>No photos are awaiting approval.</p>}
    <div className="photo-grid">
      {page?.items.map((photo, index) => <figure className="gallery-photo" key={photo.id}>
        <img src={photo.thumbnailUrl} referrerPolicy="no-referrer" alt={`Pending photo ${index + 1}`} loading="lazy" />
        <figcaption><Button disabled={Boolean(approving) || loading} onClick={() => void approve(photo.id)}>
          {approving === photo.id ? "Approving…" : "Approve"}
        </Button></figcaption>
      </figure>)}
    </div>
    {page?.next && <Button variant="secondary" disabled={loading || Boolean(approving)} onClick={() => fetchPage(page.next)}>Load more</Button>}
  </>;
}
