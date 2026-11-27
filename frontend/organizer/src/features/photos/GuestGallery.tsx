import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Brand } from "../../components/layout";
import { Button, Icon } from "../../components/ui";
import { guestPhotoPath, photoError, photoPageQuery, photoRequest, type PhotoPage } from "./photoApi";
import { usePhotoPages } from "./usePhotoPages";

export function GuestGallery() {
  const { share = "" } = useParams<{ share: string }>();
  return <GuestPhotos key={share} share={share} />;
}

function isValidPhoto(file: File) {
  return ["image/jpeg", "image/png", "image/webp"].includes(file.type) &&
    file.size > 0 && file.size <= 10 * 1024 * 1024;
}

function SelectedPhoto({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    if (!isValidPhoto(file)) {
      setPreviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return <li className="guest-gallery-selection">
    {previewUrl ? <img src={previewUrl} alt="Selected photo preview" /> : <span>Preview unavailable</span>}
    <button type="button" className="icon-btn guest-gallery-remove" aria-label={`Remove ${file.name}`}
      disabled={disabled} onClick={onRemove}><Icon name="trash" size={16} /></button>
  </li>;
}

function GuestPhotos({ share }: { share: string }) {
  const path = guestPhotoPath(share);
  const load = useCallback((after?: string, signal?: AbortSignal) =>
    photoRequest<PhotoPage & { name?: string }>(`${path}${photoPageQuery(after)}`, { signal }), [path]);
  const { page, error, loading, fetchPage } = usePhotoPages(load, 10_000);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState<string>();
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!files.length || uploading) return;
    setNotice("");
    setActionError("");
    setUploadErrors([]);
    setUploading(true);
    const failedFiles: File[] = [];
    const errors: string[] = [];
    try {
      for (const file of files) {
        try {
          if (!isValidPhoto(file)) {
            throw new Error("Choose a JPEG, PNG or WebP image up to 10 MB.");
          }
          const signed = await photoRequest<{ url: string; headers: Record<string, string> }>(`${path}/uploads`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contentType: file.type, size: file.size }),
          });
          const response = await fetch(signed.url, {
            method: "PUT", headers: signed.headers, body: file, referrerPolicy: "no-referrer",
          });
          if (!response.ok) throw new Error("The upload failed. Please try again.");
        } catch (error) {
          failedFiles.push(file);
          errors.push(`${file.name}: ${photoError(error)}`);
        }
      }
      setFiles(failedFiles);
      setUploadErrors(errors);
      const uploaded = files.length - failedFiles.length;
      if (uploaded > 0) {
        setNotice(uploaded === 1
          ? "Photo uploaded. It will appear here after processing and approval."
          : `${uploaded} photos uploaded. They will appear here after processing and approval.`);
      }
    } finally {
      setUploading(false);
    }
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
    <header className="guest-gallery-header">
      <Brand />
      {page?.name && <h1>{page.name}</h1>}
    </header>
    {error && <p className="guest-gallery-message guest-gallery-error" role="alert">{error}</p>}
    {!page && !loading && <Button onClick={() => fetchPage()}>Try again</Button>}
    {page && <>
      <section className="guest-gallery-upload" aria-labelledby="guest-upload-heading">
        <h2 id="guest-upload-heading">Share photos</h2>
        <p>Photos appear in the gallery after the organizer approves them.</p>
        <form onSubmit={event => void upload(event)}>
          <label className="guest-gallery-picker">
            <input type="file" aria-labelledby="guest-photo-picker-text" aria-describedby="guest-photo-picker-hint"
              accept="image/jpeg,image/png,image/webp" multiple disabled={uploading}
              onChange={event => {
                const selected = Array.from(event.currentTarget.files ?? []);
                if (!selected.length) return;
                setFiles(current => [...current, ...selected]);
                setUploadErrors([]);
                event.currentTarget.value = "";
              }} />
            <span className="guest-gallery-icon"><Icon name="image" size={24} /></span>
            <strong id="guest-photo-picker-text">{files.length ? "Add more photos" : "Choose photos to upload"}</strong>
            <span id="guest-photo-picker-hint">JPEG, PNG or WebP · Up to 10 MB per photo</span>
          </label>
          {!!files.length && <ul className="guest-gallery-selection-list" aria-label="Selected photos">
            {files.map((file, index) => <SelectedPhoto key={index} file={file} disabled={uploading}
              onRemove={() => {
                setFiles(current => current.filter((_, position) => position !== index));
                setUploadErrors([]);
              }} />)}
          </ul>}
          <Button type="submit" icon="upload" disabled={uploading || !files.length}>
            {uploading ? "Uploading…" : files.length > 1 ? `Upload ${files.length} photos` : "Upload photo"}
          </Button>
        </form>
      </section>
      {!!uploadErrors.length && <div className="guest-gallery-message guest-gallery-error" role="alert">
        <p>Some photos could not be uploaded.</p>
        <ul>{uploadErrors.map((message, index) => <li key={index}>{message}</li>)}</ul>
      </div>}
      {notice && <p className="guest-gallery-message" role="status">{notice}</p>}
      {actionError && <p className="guest-gallery-message guest-gallery-error" role="alert">{actionError}</p>}
      <section className="guest-gallery-photos" aria-labelledby="guest-photos-heading">
        <h2 id="guest-photos-heading">Approved photos</h2>
        {!page.items.length && !page.next && <div className="guest-gallery-empty">
          <span className="guest-gallery-icon"><Icon name="image" size={22} /></span>
          <p>There are no approved photos yet.</p>
        </div>}
        <div className="photo-grid">
          {page.items.map((photo, index) => <figure className="gallery-photo" key={photo.id}>
            <img src={photo.thumbnailUrl} referrerPolicy="no-referrer" alt={`Event photo ${index + 1}`} loading="lazy" />
            <figcaption><Button variant="secondary" icon="download" disabled={Boolean(downloading)} onClick={() => void download(photo.id)}>
              {downloading === photo.id ? "Preparing…" : "Download"}
            </Button></figcaption>
          </figure>)}
        </div>
        {page.next && <Button variant="secondary" disabled={loading} onClick={() => fetchPage(page.next)}>Load more</Button>}
      </section>
    </>}
    {loading && !page && <p className="guest-gallery-message" role="status">Loading photos…</p>}
  </main>;
}
