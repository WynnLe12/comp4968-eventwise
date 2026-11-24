import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Badge, Button, Icon, Modal } from "../../components/ui";
import { PageHeader } from "../../components/page";
import { useEvents } from "../events/EventsContext";
import { authenticatedEventRequest } from "../events/services/eventApi";
import {
  galleryUrl, guestPhotoPath, ownerPhotoPath, photoError, photoPageQuery, photoRequest,
  type GalleryPhoto, type PhotoPage,
} from "./photoApi";
import { usePhotoPages } from "./usePhotoPages";

async function ownerRequest<T>(path: string, init?: RequestInit) {
  const { token } = await authenticatedEventRequest();
  return photoRequest<T>(path, { ...init, headers: { Authorization: `Bearer ${token}` } });
}

async function collectPhotos(load: (query: string) => Promise<PhotoPage>): Promise<GalleryPhoto[]> {
  const photos: GalleryPhoto[] = [];
  let cursor: string | undefined;
  do {
    const page = await load(photoPageQuery(cursor));
    photos.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return photos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function Photos({ onToast }: { onToast: (message: string) => void }) {
  const { selectedEvent } = useEvents();
  if (selectedEvent?.role === "OWNER") {
    return <PhotoModeration key={selectedEvent.event_id} eventId={selectedEvent.event_id} onToast={onToast} />;
  }
  return <>
    <PageHeader page="photos" />
    <p>{selectedEvent ? "Only the event owner can manage the photo gallery." : "Select an event to open its gallery."}</p>
  </>;
}

function PhotoModeration({ eventId, onToast }: { eventId: string; onToast: (message: string) => void }) {
  const path = ownerPhotoPath(eventId);
  const load = useCallback(async (_after?: string, signal?: AbortSignal) => {
    const pending = collectPhotos(query => ownerRequest<PhotoPage>(`${path}/pending${query}`, { signal }));
    const [{ share }, items] = await Promise.all([ownerRequest<{ share: string }>(path, { signal }), pending]);
    const guestPath = guestPhotoPath(share);
    const url = galleryUrl(share);
    const [approved, qr] = await Promise.all([
      collectPhotos(query => photoRequest<PhotoPage>(`${guestPath}${query}`, { signal })),
      QRCode.toDataURL(url, { width: 320, margin: 4 }),
    ]);
    return { items, approved, guestPath, url, qr, next: undefined };
  }, [path]);
  const { page, loading, error, fetchPage } = usePhotoPages(load);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showSelection, setShowSelection] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [approving, setApproving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [photoToDelete, setPhotoToDelete] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const busy = loading || approving || downloading || deleting;
  const selectedIds = page?.items.filter(photo => selected.has(photo.id)).map(photo => photo.id) ?? [];
  const allSelected = Boolean(page?.items.length && selectedIds.length === page.items.length);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (busy || photoToDelete) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") fetchPage();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [busy, photoToDelete, fetchPage]);

  function openDeleteDialog(id: string) {
    setDeleteError("");
    setPhotoToDelete(id);
  }

  function closeDeleteDialog() {
    if (!deleting) setPhotoToDelete(undefined);
  }

  async function deletePhoto() {
    if (!photoToDelete || deleting) return;
    const id = photoToDelete;
    setDeleting(true);
    setDeleteError("");
    setActionError("");
    setNotice("");
    try {
      await ownerRequest<void>(`${path}/photos/${id}`, { method: "DELETE" });
      setSelected(current => new Set([...current].filter(value => value !== id)));
      if (page?.items.length === 1 && page.items[0].id === id) setShowSelection(false);
      setPhotoToDelete(undefined);
      onToast("Photo deleted.");
      fetchPage();
    } catch (error) {
      setDeleteError(photoError(error));
    } finally {
      setDeleting(false);
    }
  }

  function toggle(id: string) {
    setSelected(current => {
      const updated = new Set(current);
      if (updated.has(id)) updated.delete(id);
      else updated.add(id);
      return updated;
    });
  }

  async function approve(ids: string[]) {
    setApproving(true);
    setActionError("");
    setNotice("");
    let approved = 0;
    for (const id of ids) {
      try {
        await ownerRequest<void>(`${path}/approve/${id}`, { method: "POST" });
        approved++;
        setSelected(current => new Set([...current].filter(value => value !== id)));
      } catch (error) {
        setActionError(photoError(error));
        break;
      }
    }
    if (approved) {
      if (approved === page?.items.length) setShowSelection(false);
      onToast(approved === 1 ? "Photo approved." : `${approved} photos approved.`);
      fetchPage();
    }
    setApproving(false);
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

  async function downloadAll() {
    if (!page?.approved.length) return;
    setDownloading(true);
    setNotice("");
    setActionError("");
    try {
      for (const photo of page.approved) {
        const { url } = await photoRequest<{ url: string }>(`${page.guestPath}/download/${photo.id}`);
        const link = document.createElement("a");
        link.href = url;
        link.referrerPolicy = "no-referrer";
        link.click();
      }
      setNotice("Download requests sent. Allow multiple downloads if your browser asks.");
    } catch (error) {
      setActionError(photoError(error));
    } finally {
      setDownloading(false);
    }
  }

  return <div className="photo-moderation">
    <PageHeader page="photos" action={
      <Button icon="download" disabled={busy || !page?.approved.length} onClick={() => void downloadAll()}>
        {downloading ? "Preparing downloads…" : "Download all"}
      </Button>
    } />
    {page && <section className="qr-banner">
      <img className="gallery-qr" src={page.qr} alt="QR code for the guest gallery" />
      <div className="gallery-share-copy">
        <p className="gallery-eyebrow">Guest photo gallery</p>
        <h2>Let guests capture every angle</h2>
        <p>Share the QR code at your event. Guests can upload without an account, and photos appear in their gallery after you approve them.</p>
        <div className="gallery-controls">
          <Button variant="secondary" icon="link" onClick={() => void copy(page.url)}>Copy upload link</Button>
          <a href={page.url} target="_blank" rel="noreferrer">Open guest gallery</a>
        </div>
      </div>
      <dl className="gallery-stats">
        <div><dt>photos processed</dt><dd>{page.items.length + page.approved.length}</dd></div>
        <div><dt>approved</dt><dd>{page.approved.length}</dd></div>
      </dl>
    </section>}
    {Boolean(page?.items.length) && <div className="gallery-head">
      <div>
        <h3>Pending approval</h3>
        {page && <p>{page.items.length === 1 ? "1 guest upload needs your review" : `${page.items.length} guest uploads need your review`}</p>}
      </div>
      <div className="gallery-controls">
        <Button variant="ghost" disabled={busy} onClick={() => {
          setShowSelection(!allSelected);
          setSelected(new Set(allSelected ? [] : page?.items.map(photo => photo.id)));
        }}>{allSelected ? "Deselect all" : "Select all"}</Button>
        {!!selectedIds.length && <Button disabled={busy} onClick={() => void approve(selectedIds)}>
          {approving ? "Approving…" : `Approve selected (${selectedIds.length})`}
        </Button>}
      </div>
    </div>}
    {error && <p role="alert">{error}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading && !page && <p role="status">Loading photos…</p>}
    <div className="photo-grid">
      {page?.items.map((photo, index) => <figure className="gallery-photo moderation-photo" key={photo.id}>
        <img src={photo.thumbnailUrl} referrerPolicy="no-referrer" alt={`Pending photo ${index + 1}`} loading="lazy" />
        {showSelection && <label className="moderation-select">
          <input type="checkbox" aria-label={`Select pending photo ${index + 1}`}
            checked={selected.has(photo.id)} disabled={busy} onChange={() => toggle(photo.id)} />
        </label>}
        <figcaption>
          <Button variant="secondary" disabled={busy} onClick={() => void approve([photo.id])}>Approve</Button>
          <button type="button" className="icon-btn moderation-delete" aria-label={`Delete pending photo ${index + 1}`}
            disabled={busy} onClick={() => openDeleteDialog(photo.id)}><Icon name="trash" size={18} /></button>
        </figcaption>
      </figure>)}
    </div>
    {!!page?.approved.length && <section aria-label="Approved photos">
      <div className="gallery-head"><h3>Approved photos</h3></div>
      <div className="photo-grid">
        {page.approved.map((photo, index) => <figure className="gallery-photo moderation-photo" key={photo.id}>
          <img src={photo.thumbnailUrl} referrerPolicy="no-referrer" alt={`Approved photo ${index + 1}`} loading="lazy" />
          <div className="moderation-badge"><Badge tone="success">Approved</Badge></div>
          <figcaption><button type="button" className="icon-btn moderation-delete" aria-label={`Delete approved photo ${index + 1}`}
            disabled={busy} onClick={() => openDeleteDialog(photo.id)}><Icon name="trash" size={18} /></button></figcaption>
        </figure>)}
      </div>
    </section>}
    {photoToDelete && <Modal title="Delete photo?" onClose={closeDeleteDialog} footer={<>
      <Button variant="secondary" disabled={deleting} onClick={closeDeleteDialog}>Cancel</Button>
      <Button variant="danger" disabled={deleting} onClick={() => void deletePhoto()}>
        {deleting ? "Deleting…" : "Delete photo"}
      </Button>
    </>}>
      <p>This permanently deletes the photo from this event’s gallery.</p>
      {deleteError && <p className="expense-form-error" role="alert">{deleteError}</p>}
    </Modal>}
  </div>;
}
