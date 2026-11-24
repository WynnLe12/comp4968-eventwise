import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

import { Button, Card, Icon, Modal } from "../../components/ui";
import {
  LoadingState,
  PageHeader,
} from "../../components/page";
import { useEvents } from "../events/EventsContext";

import {
  fetchDocuments,
  uploadDocument,
  getDocumentDownloadUrl,
  deleteDocument,
  type EventDocument,
} from "./documentsApi";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getDocumentKind(contentType: string): string {
  if (contentType === "application/pdf") return "PDF";
  if (contentType === "image/jpeg") return "JPG";
  if (contentType === "image/png") return "PNG";
  return "Document";
}

function getDocumentTone(contentType: string): string {
  if (contentType === "application/pdf") return "purple";
  if (contentType.startsWith("image/")) return "pink";
  return "blue";
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "Unknown";

  return date.toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

export function Documents() {
  const { selectedId: eventId } = useEvents();

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Prevent results from an old event appearing in a new event.
  const activeEventRef = useRef(eventId);
  activeEventRef.current = eventId;

  const [documents, setDocuments] = useState<EventDocument[]>([]);
  const [loadedEventId, setLoadedEventId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const [documentToDelete, setDocumentToDelete] =
    useState<EventDocument | null>(null);

  const [refreshKey, setRefreshKey] = useState(0);

  const isCurrentEvent = (id: string) =>
    activeEventRef.current === id;

  // Load documents when selecting an event or refreshing.
  useEffect(() => {
    let cancelled = false;

    setDocuments([]);
    setLoadedEventId(null);
    setLoadError(null);
    setMessage(null);
    setSearch("");
    setDocumentToDelete(null);
    setUploading(false);
    setDeleting(false);
    setOpeningId(null);

    if (!eventId) {
      return () => {
        cancelled = true;
      };
    }

    const requestEventId = eventId;

    async function load() {
      try {
        const result = await fetchDocuments(requestEventId);

        if (!cancelled && isCurrentEvent(requestEventId)) {
          setDocuments(result);
          setLoadedEventId(requestEventId);
        }
      } catch (error) {
        if (!cancelled && isCurrentEvent(requestEventId)) {
          setLoadError(errorMessage(error));
          setLoadedEventId(requestEventId);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [eventId, refreshKey]);

  function refreshDocuments() {
    setRefreshKey((previous) => previous + 1);
  }

  async function handleUpload(file: File) {
    if (!eventId || uploading) return;

    if (!ALLOWED_TYPES.has(file.type)) {
      setMessage({
        type: "error",
        text: "Only PDF, DOCX, JPG, and PNG files are supported.",
      });
      return;
    }

    if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
      setMessage({
        type: "error",
        text: "File must be between 1 byte and 10 MB.",
      });
      return;
    }

    const requestEventId = eventId;

    setUploading(true);
    setMessage(null);

    try {
      await uploadDocument(requestEventId, file);

      if (!isCurrentEvent(requestEventId)) return;

      const updated = await fetchDocuments(requestEventId);

      if (!isCurrentEvent(requestEventId)) return;

      setDocuments(updated);
      setLoadedEventId(requestEventId);
      setLoadError(null);
      setMessage({
        type: "success",
        text: `${file.name} uploaded successfully.`,
      });
    } catch (error) {
      if (isCurrentEvent(requestEventId)) {
        setMessage({
          type: "error",
          text: `Upload failed: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (isCurrentEvent(requestEventId)) {
        setUploading(false);
      }
    }
  }

  function handleFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];

    if (file) {
      void handleUpload(file);
    }

    // Allow selecting the same file again.
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();

    if (uploading || !eventId) return;

    const file = event.dataTransfer.files[0];

    if (file) {
      void handleUpload(file);
    }
  }

  async function handleOpen(
    document: EventDocument,
    download: boolean,
  ) {
    if (!eventId) return;

    const requestEventId = eventId;

    setOpeningId(document.documentId);
    setMessage(null);

    try {
      const result = await getDocumentDownloadUrl(
        requestEventId,
        document.documentId,
      );

      if (!isCurrentEvent(requestEventId)) return;

      // Use the temporary authorized S3 URL.
      const link = window.document.createElement("a");
      link.href = result.downloadUrl;
      link.target = download ? "_self" : "_blank";
      link.rel = "noopener noreferrer";

      window.document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      if (isCurrentEvent(requestEventId)) {
        setMessage({
          type: "error",
          text: `Could not open document: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (isCurrentEvent(requestEventId)) {
        setOpeningId(null);
      }
    }
  }

  async function handleConfirmDelete() {
    if (!eventId || !documentToDelete || deleting) return;

    const requestEventId = eventId;
    const document = documentToDelete;

    setDeleting(true);
    setMessage(null);

    try {
      const result = await deleteDocument(
        requestEventId,
        document.documentId,
      );

      if (!isCurrentEvent(requestEventId)) return;

      setDocuments((previous) =>
        previous.filter(
          (item) => item.documentId !== document.documentId,
        ),
      );

      setDocumentToDelete(null);

      setMessage({
        type: result.storageCleanupPending
          ? "error"
          : "success",
        text: result.storageCleanupPending
          ? "Document removed, but S3 cleanup is pending."
          : `${document.filename} deleted successfully.`,
      });
    } catch (error) {
      if (isCurrentEvent(requestEventId)) {
        setMessage({
          type: "error",
          text: `Delete failed: ${errorMessage(error)}`,
        });
        setDocumentToDelete(null);
      }
    } finally {
      if (isCurrentEvent(requestEventId)) {
        setDeleting(false);
      }
    }
  }

  const filteredDocuments = documents.filter((document) =>
    document.filename
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  const totalBytes = documents.reduce(
    (sum, document) => sum + Number(document.sizeBytes),
    0,
  );

  const loading = Boolean(eventId) &&
    loadedEventId !== eventId;

  return (
    <>
      <PageHeader
        page="documents"
        action={
          <Button
            icon="upload"
            disabled={!eventId || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? "Uploading..." : "Upload document"}
          </Button>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        hidden
        accept=".pdf,.docx,.jpg,.jpeg,.png"
        onChange={handleFileChange}
      />

      {!eventId ? (
        <Card>
          <p>Select an event to manage its documents.</p>
        </Card>
      ) : loading ? (
        <LoadingState label="Loading documents..." />
      ) : loadError ? (
        <Card>
          <p role="alert">Error: {loadError}</p>
          <Button variant="secondary" onClick={refreshDocuments}>
            Try again
          </Button>
        </Card>
      ) : (
        <>
          {message && (
            <div
              role="alert"
              className={
                message.type === "success"
                  ? "alert alert-success"
                  : "alert alert-error"
              }
              style={{ marginBottom: 16 }}
            >
              {message.text}
            </div>
          )}

          <div
            className="upload-zone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <div>
              <Icon name="upload" />
            </div>

            <b>
              {uploading
                ? "Uploading your document..."
                : "Drop files here to upload"}
            </b>

            <span>PDF, DOCX, JPG, PNG up to 10 MB</span>

            <Button
              variant="secondary"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "Uploading..." : "Choose files"}
            </Button>
          </div>

          <Card>
            <div className="card-head">
              <div>
                <h3>All documents</h3>
                <p>
                  {documents.length} files · {formatSize(totalBytes)} total
                </p>
              </div>

              <div className="search-input">
                <Icon name="search" />
                <input
                  placeholder="Search files..."
                  aria-label="Search files"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>

            {filteredDocuments.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center" }}>
                <p>
                  {search
                    ? "No documents match your search."
                    : "No documents uploaded yet."}
                </p>
              </div>
            ) : (
              <div className="file-list">
                {filteredDocuments.map((document) => (
                  <div
                    className="file-row"
                    key={document.documentId}
                  >
                    <div
                      className={`file-icon ${getDocumentTone(
                        document.contentType,
                      )}`}
                    >
                      <Icon name="file" />
                    </div>

                    <div>
                      <b>{document.filename}</b>
                      <span>
                        {getDocumentKind(document.contentType)}
                        {" · "}
                        {formatSize(Number(document.sizeBytes))}
                      </span>
                    </div>

                    <span>
                      Uploaded {formatDate(document.uploadedAt)}
                    </span>

                    <button
                      className="icon-btn"
                      title="Preview"
                      aria-label={`Preview ${document.filename}`}
                      disabled={openingId !== null}
                      onClick={() =>
                        void handleOpen(document, false)
                      }
                    >
                      <Icon name="eye" />
                    </button>

                    <button
                      className="icon-btn"
                      title="Download"
                      aria-label={`Download ${document.filename}`}
                      disabled={openingId !== null}
                      onClick={() =>
                        void handleOpen(document, true)
                      }
                    >
                      <Icon name="download" />
                    </button>

                    <button
                      className="icon-btn"
                      title="Delete"
                      aria-label={`Delete ${document.filename}`}
                      onClick={() => setDocumentToDelete(document)}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {documentToDelete && eventId && (
        <Modal
          title="Delete Document"
          onClose={() => {
            if (!deleting) setDocumentToDelete(null);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                disabled={deleting}
                onClick={() => setDocumentToDelete(null)}
              >
                Cancel
              </Button>

              <Button
                variant="danger"
                disabled={deleting}
                onClick={() => void handleConfirmDelete()}
              >
                {deleting ? "Deleting..." : "Delete document"}
              </Button>
            </>
          }
        >
          <p>
            Are you sure you want to delete
            {" "}
            <strong>{documentToDelete.filename}</strong>?
          </p>

          <p>This action cannot be undone.</p>
        </Modal>
      )}
    </>
  );
}
